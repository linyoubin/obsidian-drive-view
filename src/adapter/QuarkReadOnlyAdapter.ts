/**
 * QuarkReadOnlyAdapter —— 把夸克网盘当 Obsidian 库的只读 DataAdapter（v3 §3）。
 *
 * 19 个方法一个不少（`implements DataAdapter`，少一个 TS 就报）：
 *   - 读 5：`exists` / `stat` / `list` / `read` / `readBinary`
 *   - 同步 2：`getName()` → `"quark-readonly"`；`getResourcePath()` → blob URL 或 `""`
 *   - 抛错 12：`write` / `writeBinary` / `append` / `appendBinary` / `process` /
 *              `mkdir` / `trashSystem` / `trashLocal` / `rmdir` / `remove` / `rename` / `copy`
 *
 * 行为约束：
 *   - `exists`/`stat`/`list` **只查索引**，一次网络请求都不发（v3 §8 A2：有快照冷启动 0 请求）；
 *   - `list` 非递归，实现为「按父路径取直接子项」；
 *   - `read`/`readBinary` 先查内存缓存，未命中才 `client.downloadFile(fid)` 并写回缓存；
 *   - `getResourcePath` 是同步方法：命中给 blob URL，未命中返回 `""` 并把路径塞进预取队列
 *     （v3 §3 第 12 条：同步接口不能等网络）；
 *   - `.obsidian/**` 与插件自身目录：读写**都**转发给注入的 `baseAdapter`，既不抛错也不查索引
 *     （否则配置、主题、workspace 都会写失败，v3 §3 全局例外）。
 *
 * 只使用注入的 `index` / `cache` / `client`，不直接 import 它们的实现，也不发网络。
 */

import type { DataAdapter, DataWriteOptions, ListedFiles, Stat } from "obsidian";

import { normalizeQuarkMtime } from "../store/IndexStore";
import type { IndexEntry } from "../store/IndexStore";
import {
  QuarkAuthError,
  QuarkDownloadCanceledError,
  QuarkDownloadTimeoutError,
  QuarkFileTooLargeError,
} from "../client/QuarkClient";
import { DownloadGateError } from "../client/downloadGate";
import { arrayBufferToString, getParentPath, normalizeVaultPath } from "../utils/pathUtils";
import { ReadOnlyError } from "./readonlyError";

/** 本 adapter 的固定名字（`getName()` 返回值）。 */
export const QUARK_ADAPTER_NAME = "quark-readonly";
/** 默认配置目录。 */
export const DEFAULT_CONFIG_DIR = ".obsidian";
/** 默认插件目录（配置目录内的子集，转发规则与配置目录相同）。 */
export const DEFAULT_PLUGIN_DIR = ".obsidian/plugins/quark-vault";

/** 只读所需的索引读口：`IndexStore.entries` 就是这个形状（getter 也行）。 */
export interface QuarkIndexReader {
  readonly entries: IndexEntry[];
  readonly entryCount?: number;
}

/** 内容缓存的最小接口（`ContentCache` 结构上满足）。 */
export interface QuarkCacheLike {
  has(path: string): boolean;
  get(path: string): ArrayBuffer | null;
  getResourceUrl(path: string): string;
  put(
    path: string,
    data: ArrayBuffer | Uint8Array,
    meta?: { fid?: string; mtime?: number }
  ): { cached: boolean };
  enqueuePrefetch(items: Array<{ path: string; size?: number }>): unknown;
}

/** 下载器的最小接口（`QuarkClient` 结构上满足）。 */
export interface QuarkDownloadClient {
  /** 第二参数是取消令牌（`aborted=true` 时客户端丢弃结果、不再重试）。 */
  downloadFile(fid: string, options?: { signal?: { aborted: boolean } | null; path?: string }): Promise<ArrayBuffer>;
}

/** 日志 cause（0.2.4 A7）：一次失败一条日志，带原因分类。 */
export type QuarkDiagCause =
  | "timeout"
  | "size"
  | "auth"
  | "http"
  | "canceled"
  | "utf8"
  | "empty"
  | "unknown";

/** 一次下载的取消令牌（与 `DownloadToken` 结构兼容）。 */
export interface QuarkDownloadToken {
  readonly id?: string;
  aborted: boolean;
}

export type QuarkDownloadEndOutcome = "done" | "failed" | "canceled";

/**
 * 下载提示出口（0.2.4 A4′）：由 main.ts 实现「正在下载 … [取消]」单例提示。
 *
 * 取消只改 `token.aborted`：`requestUrl` 无 AbortSignal，**不能中断已发出的 HTTP**，
 * 只能丢弃结果、停止重试、不写缓存。
 */
export interface QuarkDownloadUi {
  begin(info: { path: string; fid: string; sizeBytes: number }): QuarkDownloadToken;
  end(token: QuarkDownloadToken | null, outcome: QuarkDownloadEndOutcome): void;
}

/** 诊断阶段名（与 `src/utils/diagLog.ts` 的 `DiagStage` 对齐）。 */
export type QuarkAdapterDiagStage =
  | "read"
  | "readBinary"
  | "getResourcePath"
  | "download"
  | "list"
  | "sort"
  | "decode";

/** 诊断出口：只在 catch 分支调用，不改变任何读写行为（0.2.3 A5 / 0.2.4 A7）。 */
export type QuarkAdapterDiagSink = (entry: {
  stage: QuarkAdapterDiagStage;
  path: string;
  fid: string;
  message: string;
  cause?: QuarkDiagCause;
  retried?: boolean;
  /** 0.2.10：info 级埋点（read/decode/download hop）。 */
  level?: "error" | "warn" | "info";
  /** 0.2.10：结构化字段（hit/size/bytes/chars/sample/hop/status/code/urlLen/contentType/firstBytes）。 */
  fields?: Record<string, string | number | boolean>;
}) => void;

export interface QuarkReadOnlyAdapterOptions {
  index: QuarkIndexReader;
  cache: QuarkCacheLike;
  client: QuarkDownloadClient;
  /** 原生 adapter（桌面 `FileSystemAdapter` / 手机 `CapacitorAdapter`），用于配置目录转发。 */
  baseAdapter: DataAdapter;
  /** 配置目录，默认 `.obsidian`。 */
  configDir?: string;
  /** 本插件目录，默认 `.obsidian/plugins/quark-vault`。 */
  pluginDir?: string;
  /** 可选诊断出口（失败时记录 path/fid/阶段）；不传则完全无副作用。 */
  diag?: QuarkAdapterDiagSink | null;
  /** 可选下载提示 + 取消（0.2.4 A4′）；不传则下载时无提示。 */
  downloadUi?: QuarkDownloadUi | null;
  /**
   * 写被拒后的回调（0.2.8）：main 用它做「回滚视图到云端版本」。
   * 写操作仍然 reject `ReadOnlyError`（不假装成功），这里只是通知。
   */
  onReadonlyWrite?: (info: { operation: string; path: string }) => void;
}

/** 回滚用到的叶子视图最小形状（Obsidian `WorkspaceLeaf` 结构上满足）。 */
export interface ReadonlyRollbackLeaf {
  view?: { file?: { path?: string } | null } | null;
  getViewState(): unknown;
  setViewState(state: unknown): Promise<void>;
}

/** 回滚用到的 workspace 最小形状（`app.workspace` 结构上满足）。 */
export interface ReadonlyRollbackWorkspace {
  iterateAllLeaves(callback: (leaf: ReadonlyRollbackLeaf) => void): void;
}

/**
 * 写失败 → 回滚视图（0.2.8）。
 *
 * 用户原话：「不应该是保存失败就回滚掉吗？然后就可以操作其他文件了」。
 * 做法：同一 path 在 `windowMs`（默认 10s）内**只回滚一次、只提示一次**；
 * 回滚 = 用 `setViewState(getViewState())` 强制按 adapter 内容重载，编辑缓冲被云端版本覆盖。
 * 找不到打开着的视图（后台保存）时只回调日志、不重载。
 *
 * 注意：回滚触发的是 `read`，不会再触发写，因此不会形成环路；防抖只是双保险。
 */
export function createReadonlyRollback(options: {
  workspace: ReadonlyRollbackWorkspace;
  now?: () => number;
  windowMs?: number;
  onRollback?: (info: { path: string; reloaded: boolean; operation: string }) => void;
}): (info: { operation: string; path: string }) => void {
  const lastAt = new Map<string, number>();
  const now = options.now ?? (() => Date.now());
  const windowMs = options.windowMs ?? 10_000;
  return (info) => {
    const path = info.path;
    const at = now();
    const previous = lastAt.get(path);
    if (previous !== undefined && at - previous < windowMs) return; // 10s 内只回滚一次
    lastAt.set(path, at);

    let reloaded = false;
    try {
      options.workspace.iterateAllLeaves((leaf) => {
        if (reloaded) return;
        const leafPath = leaf?.view?.file?.path;
        if (!leafPath || leafPath !== path) return;
        reloaded = true;
        try {
          void Promise.resolve(leaf.setViewState(leaf.getViewState())).catch(() => undefined);
        } catch {
          /* 移动端 setViewState 异常不影响其它文件 */
        }
      });
    } catch {
      /* workspace 不可用：只记日志 */
    }
    try {
      options.onRollback?.({ path, reloaded, operation: info.operation });
    } catch {
      /* 提示/日志失败不影响 Obsidian 的保存流程 */
    }
  };
}

/** 同一个错误对象只记一条日志（download 与 read 不再各记一条，0.2.4 A7）。 */
const loggedErrors = new WeakSet<object>();

/** 索引里查不到该路径（不是只读错误，是「库里有快照但不含此文件」）。 */
export class QuarkEntryNotFoundError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`索引中没有该路径：${path || "根目录"}`);
    this.name = "QuarkEntryNotFoundError";
    this.path = path;
  }
}

function isDirectoryLike(entry: IndexEntry): boolean {
  return entry.type === "folder";
}

export class QuarkReadOnlyAdapter implements DataAdapter {
  private readonly index: QuarkIndexReader;
  private readonly cache: QuarkCacheLike;
  private readonly client: QuarkDownloadClient;
  private readonly baseAdapter: DataAdapter;
  private readonly configDir: string;
  private readonly pluginDir: string;
  private readonly diag?: QuarkAdapterDiagSink | null;
  private readonly downloadUi?: QuarkDownloadUi | null;
  private readonly onReadonlyWrite?: (info: { operation: string; path: string }) => void;

  constructor(options: QuarkReadOnlyAdapterOptions) {
    if (!options || !options.index || !options.cache || !options.client || !options.baseAdapter) {
      throw new Error("QuarkReadOnlyAdapter 需要注入 { index, cache, client, baseAdapter }");
    }
    this.index = options.index;
    this.cache = options.cache;
    this.client = options.client;
    this.baseAdapter = options.baseAdapter;
    this.configDir = normalizeVaultPath(options.configDir ?? DEFAULT_CONFIG_DIR);
    this.pluginDir = normalizeVaultPath(options.pluginDir ?? DEFAULT_PLUGIN_DIR);
    this.diag = options.diag ?? null;
    this.downloadUi = options.downloadUi ?? null;
    this.onReadonlyWrite = options.onReadonlyWrite;
  }

  // ---------------------------------------------------------------- 同步 2

  getName(): string {
    return QUARK_ADAPTER_NAME;
  }

  /** 命中缓存 → 该条目的 blob URL；未命中 → `""` 并排队预取（同步，绝不返回 Promise）。 */
  getResourcePath(normalizedPath: string): string {
    if (this.shouldForward(normalizedPath)) {
      return this.baseAdapter.getResourcePath(normalizedPath);
    }
    const clean = normalizeVaultPath(normalizedPath);
    let fid = "-";
    try {
      const url = this.cache.getResourceUrl(clean);
      if (url) return url;
      if (clean) {
        const entry = this.findEntry(clean);
        if (entry) fid = entry.fid;
        this.cache.enqueuePrefetch([{ path: clean, size: entry ? entry.size : undefined }]);
      }
      return "";
    } catch (error) {
      // 诊断：打开失败时记录读的是哪个 path/fid（不改行为：照旧抛出）
      this.reportDiagOnce(error, "getResourcePath", clean, fid);
      throw error;
    }
  }

  // ---------------------------------------------------------------- 读 5

  async exists(normalizedPath: string, sensitive?: boolean): Promise<boolean> {
    if (this.shouldForward(normalizedPath)) {
      return this.baseAdapter.exists(normalizedPath, sensitive);
    }
    const clean = normalizeVaultPath(normalizedPath);
    if (clean === "") return true;
    if (this.findEntry(clean)) return true;
    if (sensitive === false) {
      const lower = clean.toLowerCase();
      return this.index.entries.some((entry) => entry.path.toLowerCase() === lower);
    }
    return false;
  }

  async stat(normalizedPath: string): Promise<Stat | null> {
    if (this.shouldForward(normalizedPath)) {
      return this.baseAdapter.stat(normalizedPath);
    }
    const clean = normalizeVaultPath(normalizedPath);
    if (clean === "") {
      // 根目录不在索引里，按「全库最新 mtime」造一个；没有条目就用 0
      let mtime = 0;
      for (const entry of this.index.entries) {
        if (entry.mtime > mtime) mtime = entry.mtime;
      }
      return { type: "folder", ctime: mtime, mtime: normalizeQuarkMtime(mtime), size: 0 };
    }
    const entry = this.findEntry(clean);
    if (!entry) return null;
    // 索引里没有 ctime（夸克只给 updated_at），ctime 取 mtime 兜底
    // 0.2.9：mtime 统一成毫秒（秒级 updated_at 在 IndexStore 已归一，这里再兜一层）
    const mtime = normalizeQuarkMtime(entry.mtime);
    return { type: entry.type, ctime: mtime, mtime, size: entry.size };
  }

  /** 非递归：只返回直接子项（完整库内路径，与 Obsidian 约定一致）。 */
  async list(normalizedPath: string): Promise<ListedFiles> {
    if (this.shouldForward(normalizedPath)) {
      return this.baseAdapter.list(normalizedPath);
    }
    const clean = normalizeVaultPath(normalizedPath);
    const files: string[] = [];
    const folders: string[] = [];
    let sorting = false;
    try {
      for (const entry of this.index.entries) {
        if (getParentPath(entry.path) !== clean) continue;
        if (isDirectoryLike(entry)) folders.push(entry.path);
        else files.push(entry.path);
      }
      sorting = true;
      files.sort((a, b) => a.localeCompare(b));
      folders.sort((a, b) => a.localeCompare(b));
      sorting = false;
      return { files, folders };
    } catch (error) {
      // 诊断：区分「列目录」与「排序」两个阶段（不改行为：照旧抛出）
      this.reportDiagOnce(error, sorting ? "sort" : "list", clean, "-");
      throw error;
    }
  }

  async read(normalizedPath: string): Promise<string> {
    if (this.shouldForward(normalizedPath)) {
      return this.baseAdapter.read(normalizedPath);
    }
    const clean = normalizeVaultPath(normalizedPath);
    const fid = this.fidOf(clean);
    const entry = this.findEntry(clean);
    // 0.2.10 入口埋点：命中缓存与否 + 索引里的 size（区分「空文件」与「下载到空内容」）
    this.reportInfo("read", clean, fid, { hit: this.cache.has(clean), size: entry ? entry.size : 0 });
    try {
      const buffer = await this.loadBinary(normalizedPath);
      const bytes = buffer.byteLength;
      const text = arrayBufferToString(buffer);
      const chars = text.length;
      // 解码埋点：sample 仅 chars>0 时记录（前 60 字符、去换行），正文绝不写入
      if (chars > 0) {
        this.reportInfo("decode", clean, fid, {
          bytes,
          chars,
          sample: text.slice(0, 60).replace(/\s+/g, " "),
        });
      } else {
        this.reportDiagnostic({
          stage: "decode",
          path: clean,
          fid,
          cause: bytes === 0 ? "empty" : "utf8",
          message: bytes === 0 ? "empty-body" : "utf8-empty",
          fields: { bytes, chars },
        });
      }
      return text;
    } catch (error) {
      const cause = decodeCause(error);
      // 同一次失败若已在 download hop 记过，就不再重复记 decode（避免一次失败两条 error）
      if (cause && !this.alreadyLogged(error)) {
        this.reportDiagnostic({
          stage: "decode",
          path: clean,
          fid,
          cause,
          message: errorText(error),
          fields: { bytes: 0, chars: 0 },
        });
      }
      // 诊断：read 阶段（同一错误对象在 download 阶段已记过则不再重复）
      this.reportDiagOnce(error, "read", normalizedPath, fid);
      throw error;
    }
  }

  async readBinary(normalizedPath: string): Promise<ArrayBuffer> {
    if (this.shouldForward(normalizedPath)) {
      return this.baseAdapter.readBinary(normalizedPath);
    }
    try {
      return await this.loadBinary(normalizedPath);
    } catch (error) {
      // 诊断：readBinary 阶段
      this.reportDiagOnce(error, "readBinary", normalizedPath, this.fidOf(normalizedPath));
      throw error;
    }
  }

  // ---------------------------------------------------------------- 写 12（只读 no-op，0.2.8）

  /**
   * 0.2.8：写操作**仍然 reject**（`ReadOnlyError`），但拒绝前先通知 main 做「回滚视图」：
   * 用户要的是「保存失败就回滚掉，然后可以继续操作其它文件」，而不是静默假装成功。
   * `.obsidian/**` 与插件目录仍原样转发给 base adapter（真写进本地）。
   */
  private rejectWrite(operation: string, normalizedPath: string): Promise<never> {
    const path = normalizeVaultPath(normalizedPath);
    try {
      this.onReadonlyWrite?.({ operation, path });
    } catch {
      /* 回滚/提示失败不影响拒绝写 */
    }
    return Promise.reject(new ReadOnlyError(operation, path));
  }

  async write(normalizedPath: string, data: string, options?: DataWriteOptions): Promise<void> {
    if (this.shouldForward(normalizedPath)) return await this.baseAdapter.write(normalizedPath, data, options);
    return this.rejectWrite("write", normalizedPath);
  }

  async writeBinary(normalizedPath: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void> {
    if (this.shouldForward(normalizedPath)) {
      return await this.baseAdapter.writeBinary(normalizedPath, data, options);
    }
    return this.rejectWrite("writeBinary", normalizedPath);
  }

  async append(normalizedPath: string, data: string, options?: DataWriteOptions): Promise<void> {
    if (this.shouldForward(normalizedPath)) return await this.baseAdapter.append(normalizedPath, data, options);
    return this.rejectWrite("append", normalizedPath);
  }

  async appendBinary(normalizedPath: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void> {
    if (this.shouldForward(normalizedPath)) {
      return await this.baseAdapter.appendBinary(normalizedPath, data, options);
    }
    return this.rejectWrite("appendBinary", normalizedPath);
  }

  /** 只读下 `process` 返回**原始内容**（不执行 fn、不写回）。 */
  async process(
    normalizedPath: string,
    fn: (data: string) => string,
    options?: DataWriteOptions
  ): Promise<string> {
    if (this.shouldForward(normalizedPath)) {
      return await this.baseAdapter.process(normalizedPath, fn, options);
    }
    return this.rejectWrite("process", normalizedPath);
  }

  async mkdir(normalizedPath: string): Promise<void> {
    if (this.shouldForward(normalizedPath)) return await this.baseAdapter.mkdir(normalizedPath);
    return this.rejectWrite("mkdir", normalizedPath);
  }

  /** 只读下删除一律被拒（上层会看到「只读」错误，而不是误判成功）。 */
  async trashSystem(normalizedPath: string): Promise<boolean> {
    if (this.shouldForward(normalizedPath)) return await this.baseAdapter.trashSystem(normalizedPath);
    return this.rejectWrite("trashSystem", normalizedPath);
  }

  async trashLocal(normalizedPath: string): Promise<void> {
    if (this.shouldForward(normalizedPath)) return await this.baseAdapter.trashLocal(normalizedPath);
    return this.rejectWrite("trashLocal", normalizedPath);
  }

  async rmdir(normalizedPath: string, recursive: boolean): Promise<void> {
    if (this.shouldForward(normalizedPath)) return await this.baseAdapter.rmdir(normalizedPath, recursive);
    return this.rejectWrite("rmdir", normalizedPath);
  }

  async remove(normalizedPath: string): Promise<void> {
    if (this.shouldForward(normalizedPath)) return await this.baseAdapter.remove(normalizedPath);
    return this.rejectWrite("remove", normalizedPath);
  }

  async rename(normalizedPath: string, normalizedNewPath: string): Promise<void> {
    if (this.shouldForward(normalizedPath)) {
      return await this.baseAdapter.rename(normalizedPath, normalizedNewPath);
    }
    return this.rejectWrite("rename", normalizedPath);
  }

  async copy(normalizedPath: string, normalizedNewPath: string): Promise<void> {
    if (this.shouldForward(normalizedPath)) {
      return await this.baseAdapter.copy(normalizedPath, normalizedNewPath);
    }
    return this.rejectWrite("copy", normalizedPath);
  }

  // ---------------------------------------------------------------- 内部

  /** 配置目录 / 插件目录：读写都交给原生 adapter（v3 §3 全局例外）。 */
  private shouldForward(normalizedPath: string): boolean {
    const clean = normalizeVaultPath(normalizedPath);
    if (!clean) return false;
    if (clean === this.configDir || clean.startsWith(`${this.configDir}/`)) return true;
    if (this.pluginDir && (clean === this.pluginDir || clean.startsWith(`${this.pluginDir}/`))) return true;
    return false;
  }

  private findEntry(path: string): IndexEntry | null {
    for (const entry of this.index.entries) {
      if (entry.path === path) return entry;
    }
    return null;
  }

  /**
   * 缓存优先；未命中则下载并回写缓存（正文与附件同一规则，v3 §5）。
   *
   * 0.2.4：下载时通过注入的 `downloadUi` 显示「正在下载 … [取消]」。
   * 取消 = 丢弃结果 + 不写缓存 + 抛 `QuarkDownloadCanceledError`；
   * `requestUrl` 无 AbortSignal，**无法中断已发出的 HTTP**，这里也不假装能中断。
   */
  private async loadBinary(normalizedPath: string): Promise<ArrayBuffer> {
    const clean = normalizeVaultPath(normalizedPath);
    if (!clean) throw new QuarkEntryNotFoundError(clean);

    const cached = this.cache.get(clean);
    if (cached) return cached;

    const entry = this.findEntry(clean);
    if (!entry) throw new QuarkEntryNotFoundError(clean);
    if (isDirectoryLike(entry)) throw new QuarkEntryNotFoundError(clean);

    const token = this.downloadUi?.begin({ path: clean, fid: entry.fid, sizeBytes: entry.size }) ?? null;
    try {
      if (token && token.aborted) throw new QuarkDownloadCanceledError();
      const buffer = await this.client.downloadFile(entry.fid, { signal: token, path: clean });
      if (token && token.aborted) throw new QuarkDownloadCanceledError();
      this.cache.put(clean, buffer, { fid: entry.fid, mtime: entry.mtime });
      this.downloadUi?.end(token, "done");
      return buffer;
    } catch (error) {
      this.downloadUi?.end(token, token && token.aborted ? "canceled" : "failed");
      // 一次失败只记一条日志（download 与 read 不重复记）
      this.reportDiagOnce(error, "download", clean, entry.fid);
      throw error;
    }
  }

  /** 0.2.10：信息级埋点（level=info，正文绝不写入）。 */
  private reportInfo(
    stage: QuarkAdapterDiagStage,
    path: string,
    fid: string,
    fields?: Record<string, string | number | boolean>
  ): void {
    this.reportDiagnostic({ stage, path, fid, level: "info", message: "", fields });
  }

  /** 0.2.10：结构化诊断（可选 cause/level/fields）。 */
  private reportDiagnostic(entry: {
    stage: QuarkAdapterDiagStage;
    path: string;
    fid: string;
    message: string;
    cause?: QuarkDiagCause;
    level?: "error" | "warn" | "info";
    fields?: Record<string, string | number | boolean>;
  }): void {
    try {
      this.diag?.({
        stage: entry.stage,
        path: entry.path || "/",
        fid: entry.fid || "-",
        message: entry.message,
        cause: entry.cause,
        level: entry.level,
        fields: entry.fields,
      });
    } catch {
      /* 诊断日志失败不影响读写 */
    }
  }

  /** 诊断出口：任何异常都不允许影响读路径；同一错误对象只记一条。 */
  private reportDiag(
    stage: QuarkAdapterDiagStage,
    path: string,
    fid: string,
    error: unknown,
    cause: QuarkDiagCause = "unknown",
    retried = false
  ): void {
    try {
      this.diag?.({
        stage,
        path: path || "/",
        fid: fid || "-",
        message: error instanceof Error ? error.message : String(error),
        cause: diagCauseOf(error, cause),
        retried,
      });
    } catch {
      /* 诊断日志失败不影响读写 */
    }
  }

  /** 该错误对象是否已经记过日志（0.2.10）。 */
  private alreadyLogged(error: unknown): boolean {
    return typeof error === "object" && error !== null && loggedErrors.has(error);
  }

  /** 去重版：同一个错误对象（同一次失败）只记一条。 */
  private reportDiagOnce(
    error: unknown,
    stage: QuarkAdapterDiagStage,
    path: string,
    fid: string
  ): void {
    if (typeof error === "object" && error !== null) {
      if (loggedErrors.has(error)) return;
      loggedErrors.add(error);
    }
    this.reportDiag(stage, path, fid, error);
  }

  private fidOf(normalizedPath: string): string {
    const entry = this.findEntry(normalizeVaultPath(normalizedPath));
    return entry ? entry.fid : "-";
  }
}

/** 错误 → 日志 cause（0.2.4 A7：timeout / size / auth / canceled / http / unknown）。 */
export function diagCauseOf(error: unknown, fallback: QuarkDiagCause = "unknown"): QuarkDiagCause {
  if (error instanceof QuarkFileTooLargeError) return "size";
  if (error instanceof QuarkAuthError) return "auth";
  if (error instanceof DownloadGateError && error.kind === "auth-expired") return "auth";
  if (error instanceof QuarkDownloadCanceledError) return "canceled";
  if (error instanceof QuarkDownloadTimeoutError) return "timeout";
  if (error instanceof Error && /timeout|timed out|超时|ETIMEDOUT/i.test(`${error.name} ${error.message}`)) {
    return "timeout";
  }
  return fallback;
}

/** 错误 → 解码阶段 cause（0.2.10）：取消不算解码失败（返回 null 不记日志）。 */
export function decodeCause(error: unknown): QuarkDiagCause | null {
  if (error instanceof QuarkDownloadCanceledError) return null;
  if (error instanceof QuarkDownloadTimeoutError) return "timeout";
  if (error instanceof QuarkAuthError) return "auth";
  if (error instanceof DownloadGateError && error.kind === "auth-expired") return "auth";
  return "http";
}

/** 前 120 字符的错误消息（去换行）。 */
export function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return text.replace(/\s+/g, " ").slice(0, 120);
}