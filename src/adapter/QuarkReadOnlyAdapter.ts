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
  QUARK_DOWNLOAD_TIMEOUT_MS,
  QuarkAuthError,
  QuarkDownloadCanceledError,
  QuarkDownloadTimeoutError,
  QuarkFileTooLargeError,
} from "../client/QuarkClient";
import { DownloadGateError } from "../client/downloadGate";
import { arrayBufferToString, getParentPath, normalizeVaultPath, guessMimeType, isTextFilePath } from "../utils/pathUtils";
import { attachmentCandidates, extractAttachmentRefs, isMarkdownPath } from "../utils/noteRefs";
import { MdContentStore } from "../store/MdContentStore";
import type { MdContentRecord, MdContentStore as MdStoreType } from "../store/MdContentStore";
import { firstBytesSha8 } from "../utils/diagLog";

/** 本 adapter 的固定名字（`getName()` 返回值）。 */
export const QUARK_ADAPTER_NAME = "quark-readonly";
/** 0.2.15：图片「点了才下」——未命中返回 1×1 透明 PNG 占位，不触发下载。 */
export const QUARK_PLACEHOLDER_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
/** 0.2.29：`stage=view`（getResourcePath）同 path 日志节流窗口。 */
const QUARK_VIEW_LOG_THROTTLE_MS = 2_000;
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
  /** 0.2.12：是否在队列/下载中（按笔记精准预取时跳过）。 */
  isPrefetching?(path: string): boolean;
  /** 0.2.29：查看缓存条目（`stage=view` 记录 bytes；可选）。 */
  peek?(path: string): { bytes: number } | null;
  /** 0.2.29：下载完成后重新生成 blob URL（可选；ContentCache 实现）。 */
  regenerateResourceUrl?(path: string): string;
}

/** 下载器的最小接口（`QuarkClient` 结构上满足）。 */
export interface QuarkDownloadClient {
  /** 第二参数是取消令牌（`aborted=true` 时客户端丢弃结果、不再重试）。 */
  downloadFile(fid: string, options?: {
      signal?: { aborted: boolean } | null;
      path?: string;
      priority?: "interactive" | "background" | "background-user" | "bulk";
      /** 0.2.26：优先级判定来源（`recentOpened|active|md-default|bulk|bg|bg-user`）。 */
      reason?: string;
      /** 0.2.27：按文件大小放宽后的硬超时（毫秒）。 */
      timeoutMs?: number;
    }): Promise<ArrayBuffer>;
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
  | "unknown"
  /** 0.2.19 B5：md 磁盘缓存（IDB）读写失败，只记日志、不影响正文读取。 */
  | "cache-get"
  | "cache-put"
  | "cache-delete"
  /** 0.2.25：只读库的写被静默忽略（`msg=readonly-noop`）。 */
  | "readonly";

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
  begin(info: {
    path: string;
    fid: string;
    sizeBytes: number;
    /** 0.2.19 SF3：取消作用域用（interactive 的下载点取消时不取消）。 */
    priority?: "interactive" | "background" | "background-user" | "bulk";
    scope?: string;
  }): QuarkDownloadToken;
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
  | "decode"
  | "prefetch"
  | "gate"
  | "cache"
  | "write"
  /** 0.2.27：图片/PDF 附件打开的自证埋点（`kind/mime/bytes/getResourcePath`）。 */
  | "view";

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
  /** 0.2.10：结构化字段（hit/size/bytes/chars/firstBytes/hop/status/code/urlLen/contentType）。 */
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
   * 写被静默忽略后的回调（0.2.8 引入，0.2.25 改语义）：main 用它做「回滚视图到云端版本」。
   *
   * 0.2.25 起写方法**不再 reject**（否则 Obsidian 自己弹「文件保存失败」，重试一次弹一次），
   * 这里负责把编辑器内容回滚到云端版本并只提示一次。
   */
  onReadonlyWrite?: (info: { operation: string; path: string }) => void;
  /** 0.2.11：预取开关（默认关）；返回 false 时 getResourcePath 未命中不入队。 */
  allowPrefetch?: () => boolean;
  /** 0.2.12：每篇笔记的预取上限（默认 20；0 = 关闭）。 */
  prefetchPerNote?: () => number;
  /** 0.2.11：每次网络下载成功后回调字节数（会话统计用）。 */
  onDownloaded?: (
    bytes: number,
    priority: "interactive" | "background" | "background-user" | "bulk",
    path?: string
  ) => void;
  /** 0.2.13：md 正文磁盘缓存（只存 .md；附件永不进 IDB）。 */
  mdStore?: MdStoreType | null;
  /** 0.2.15：当前活动笔记路径（defer 汇总日志用）。 */
  currentNotePath?: () => string;
  /** 0.2.16：当前活动笔记路径（决定 interactive 优先级，不按扩展名）。 */
  activeNotePath?: () => string;
  /**
   * 0.2.26：`file-open` 后「刚打开」的时间窗（毫秒，默认 5000）。
   * 窗内对该 path 的读一律 interactive（解决「read 先于 file-open」的竞态）。
   */
  recentOpenTtlMs?: number;
  /** 0.2.26：时间源（单测注入假时钟），默认 `Date.now`。 */
  now?: () => number;
  /**
   * 0.2.26：md 读默认 interactive 的通道预算。
   * 返回 false 时回落 bulk（防止启动扫描把 interactive 通道占满）。
   */
  interactiveBudget?: () => boolean;
}

/** 0.2.26：优先级判定结果（reason 仅用于 `stage=gate` 日志）。 */
export type QuarkPriorityReason = "recentOpened" | "active" | "md-default" | "bulk" | "bg" | "bg-user";

export interface QuarkPriorityChoice {
  priority: "interactive" | "background" | "background-user" | "bulk";
  reason: QuarkPriorityReason;
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

/** 0.2.27：二进制扩展名被当作文本读（明确报错，而不是把字节按 UTF-8 解码成乱码）。 */
export class QuarkBinaryReadError extends Error {
  readonly path: string;

  constructor(path: string) {
    super(`二进制文件不能按文本读取：${path}（应使用 readBinary / 附件视图）`);
    this.name = "QuarkBinaryReadError";
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
  private readonly allowPrefetch?: () => boolean;
  private readonly prefetchPerNote?: () => number;
  private readonly onDownloaded?: (
    bytes: number,
    priority: "interactive" | "background" | "background-user" | "bulk",
    path?: string
  ) => void;
  private readonly mdStore?: MdStoreType | null;
  private readonly currentNotePath?: () => string;
  private readonly activeNotePath?: () => string;
  /** 0.2.26：最近 `file-open` 过的 path → 时间戳（TTL 内读按 interactive）。 */
  private readonly recentOpened = new Map<string, number>();
  private readonly recentOpenTtlMs: number;
  private readonly now: () => number;
  private readonly interactiveBudget?: () => boolean;
  private deferCount = 0;
  private deferLoggedAt = 0;
  /** 0.2.29：`stage=view`（getResourcePath）节流时间（path → at）。 */
  private readonly viewLoggedAt = new Map<string, number>();

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
    this.allowPrefetch = options.allowPrefetch;
    this.prefetchPerNote = options.prefetchPerNote;
    this.onDownloaded = options.onDownloaded;
    this.mdStore = options.mdStore ?? null;
    this.currentNotePath = options.currentNotePath;
    this.activeNotePath = options.activeNotePath;
    this.recentOpenTtlMs = Math.max(0, options.recentOpenTtlMs ?? 5000);
    this.now = options.now ?? (() => Date.now());
    this.interactiveBudget = options.interactiveBudget;
  }

  /**
   * 0.2.26：`file-open` 通知 —— 记住这个 path（TTL 内读一律 interactive）。
   *
   * 真机竞态：Obsidian 打开笔记时可能**先发起 read、后触发 file-open**，
   * 于是这一篇的正文读被判成 bulk 排在后台队列。用 5s 时间窗兜住「file-open 之后的读」，
   * 时间窗之前的第一次读则由 `interactiveBudget`（md-default）兜住。
   */
  markNoteOpened(normalizedPath: string): void {
    const clean = normalizeVaultPath(normalizedPath);
    if (!clean) return;
    const at = this.now();
    this.recentOpened.set(clean, at);
    if (this.recentOpened.size > 64) {
      const cutoff = at - this.recentOpenTtlMs;
      for (const [path, openedAt] of this.recentOpened) {
        if (openedAt < cutoff) this.recentOpened.delete(path);
      }
    }
  }

  // ---------------------------------------------------------------- 同步 2

  /** 0.2.17：FileSystemAdapter 兼容方法（Obsidian 内部偶有调用；缺了会 `undefined.then`）。 */
  getBasePath(): string {
    return "";
  }

  /** 0.2.17：同上——库内绝对路径在虚拟库里不存在，返回空串。 */
  getFullPath(normalizedPath: string): string {
    return normalizeVaultPath(normalizedPath) ? `/${normalizeVaultPath(normalizedPath)}` : "/";
  }

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
      if (url) {
        this.logViewResource(clean, url);
        return url;
      }
      if (clean && !this.prefetchEnabled()) {
        // 0.2.15：默认不下载、不入队；返回占位图（每次笔记一条汇总日志，限流 1s）
        const now = Date.now();
        this.deferCount += 1;
        if (now - this.deferLoggedAt >= 1000) {
          this.deferLoggedAt = now;
          const note = this.currentNotePath ? this.currentNotePath() : "";
          this.reportInfo("prefetch", note || "/", fid, { state: "summary", note, refs: this.deferCount, deferred: this.deferCount, enqueued: 0, reason: "on-demand" });
          this.deferCount = 0;
        }
        this.logViewResource(clean, "");
        return QUARK_PLACEHOLDER_DATA_URL;
      }
      if (clean && this.prefetchEnabled()) {
        const entry = this.findEntry(clean);
        if (entry) fid = entry.fid;
        // 0.2.11：唯一允许的入队来源——Obsidian 对当前渲染真实请求的这一个 path
        const queued = this.cache.enqueuePrefetch([
          { path: clean, size: entry ? entry.size : undefined },
        ]) as { queued?: number; dropped?: number; skipped?: number } | undefined;
        const dropped = queued && typeof queued.dropped === "number" ? queued.dropped : 0;
        const skipped = queued && typeof queued.skipped === "number" ? queued.skipped : 0;
        this.reportInfo("prefetch", clean, fid, {
          state: dropped > 0 ? "drop" : skipped > 0 ? "skip" : "enqueue",
          src: "render",
          reason: dropped > 0 ? "queue-full" : "",
        });
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
    // 0.2.27：二进制扩展名不能按文本读（PDF/图片会被 UTF-8 解码成乱码/空白）。
    // 只拦「索引里确实是文件」的路径：目录/不存在的路径仍走原来的 QuarkEntryNotFoundError。
    const extension = clean.slice(clean.lastIndexOf(".") + 1).toLowerCase();
    const binaryEntry = extension ? this.findEntry(clean) : null;
    if (binaryEntry && !isDirectoryLike(binaryEntry) && !isTextFilePath(clean)) {
      this.reportInfo("read", clean, binaryEntry.fid, { state: "binary" });
      throw new QuarkBinaryReadError(clean);
    }
    const fid = this.fidOf(clean);
    const entry = this.findEntry(clean);
    // 0.2.10 入口埋点：命中缓存与否 + 索引里的 size（区分「空文件」与「下载到空内容」）
    this.reportInfo("read", clean, fid, { hit: this.cache.has(clean), size: entry ? entry.size : 0 });
    try {
      const buffer = await this.loadBinary(normalizedPath);
      const bytes = buffer.byteLength;
      const text = arrayBufferToString(buffer);
      const chars = text.length;
      // 0.2.20 N7：解码埋点只记长度与不可逆指纹（sha8），不记任何原文/原始字节
      if (chars > 0) {
        const sha8 = await firstBytesSha8(buffer);
        this.reportInfo("decode", clean, fid, {
          bytes,
          chars,
          ...(sha8 ? { sha8 } : {}),
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

  /** 0.2.13：bulk 预取专用读取——强制 bulk 优先级（永远让位于 interactive/background）。 */
  async readForBulk(normalizedPath: string): Promise<ArrayBuffer> {
    if (this.shouldForward(normalizedPath)) return this.baseAdapter.readBinary(normalizedPath);
    return await this.loadBinary(normalizedPath, { priority: "bulk", reason: "bulk" });
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

  /**
   * 0.2.21 S3：用户点开的附件读取 —— 走 `background-user`（预取让路、取消按钮可取消）。
   * 预取循环仍用 `readBinary`（普通 background），两者互不影响。
   *
   * 0.2.27：成功后记 `stage=view`（kind/mime/bytes/getResourcePath），下次 PDF/图片打不开
   * 可直接看是「blob 没生成」「MIME 不对」还是「根本没下载」。
   */
  async readBinaryForUser(normalizedPath: string): Promise<ArrayBuffer> {
    if (this.shouldForward(normalizedPath)) return this.baseAdapter.readBinary(normalizedPath);
    try {
      const buffer = await this.loadBinary(normalizedPath, {
        priority: "background-user",
        reason: "bg-user",
      });
      this.reportViewOpen(normalizedPath, buffer);
      return buffer;
    } catch (error) {
      this.reportDiagOnce(error, "readBinary", normalizedPath, this.fidOf(normalizedPath));
      throw error;
    }
  }

  /** 0.2.27：附件视图自证日志（level=info，不含正文/字节内容）。 */
  private reportViewOpen(
    normalizedPath: string,
    buffer: ArrayBuffer,
    api: "getResourcePath" | "readBinary" = "readBinary"
  ): void {
    try {
      const clean = normalizeVaultPath(normalizedPath);
      const url = this.cache.getResourceUrl(clean);
      const getResourcePath = url ? "url" : this.prefetchEnabled() ? "" : "placeholder";
      this.reportInfo("view", clean, this.fidOf(clean), {
        api,
        kind: quarkViewKind(clean),
        mime: guessMimeType(clean),
        bytes: buffer.byteLength,
        getResourcePath,
        urlHead: url.slice(0, 20),
      });
    } catch {
      /* 日志失败不影响附件读取 */
    }
  }

  /**
   * 0.2.29：`getResourcePath` 的自证日志（同 path 2s 内只记一次，避免图片连刷日志）。
   * 记录 `api/mime/bytes/urlHead`——判断 Obsidian 渲染器到底走 `getResourcePath` 还是 `readBinary`。
   */
  private logViewResource(path: string, url: string): void {
    if (!path || isMarkdownPath(path) || !this.findEntry(path)) return;
    try {
      const at = this.now();
      const previous = this.viewLoggedAt.get(path);
      if (previous !== undefined && at - previous < QUARK_VIEW_LOG_THROTTLE_MS) return;
      this.viewLoggedAt.set(path, at);
      const peek = this.cache.peek ? this.cache.peek(path) : null;
      this.reportInfo("view", path, this.fidOf(path), {
        api: "getResourcePath",
        kind: quarkViewKind(path),
        mime: guessMimeType(path),
        bytes: peek && typeof peek.bytes === "number" ? peek.bytes : 0,
        urlHead: url.slice(0, 20),
        state: url ? "hit" : this.prefetchEnabled() ? "miss" : "placeholder",
      });
    } catch {
      /* 日志失败不影响资源路径返回 */
    }
  }

  /**
   * 0.2.29：下载完成后重新生成 blob URL（不复用旧 URL）。
   *
   * Obsidian 可能缓存第一次拿到的资源 URL（占位 `data:` 或旧的空 blob），
   * 只换内容不换 URL 时视图会一直空白；warmup 在重载前调用这里强制换新。
   */
  refreshResourceUrl(normalizedPath: string): string {
    if (this.shouldForward(normalizedPath)) return this.baseAdapter.getResourcePath(normalizedPath);
    const clean = normalizeVaultPath(normalizedPath);
    if (!clean) return "";
    try {
      if (this.cache.regenerateResourceUrl) return this.cache.regenerateResourceUrl(clean);
      return this.cache.getResourceUrl(clean);
    } catch {
      return this.cache.getResourceUrl(clean);
    }
  }

  // ---------------------------------------------------------------- 写 12（只读 no-op，0.2.25）

  /**
   * 0.2.25：只读库的写**静默成功**（resolve），并通知 main 回滚视图。
   *
   * 0.2.8~0.2.24 是 reject `ReadOnlyError`：Obsidian 会自己弹「文件保存失败」，
   * 用户每次重试都再弹一次（同一文件连弹 3 次）。现在：
   *   - Obsidian 收不到写失败（不再弹窗）；
   *   - main 通过 `onReadonlyWrite` 把该笔记回滚到云端版本（10s 防抖、只提示一次）；
   *   - 日志留一条 `msg=readonly-noop cause=readonly` 便于统计。
   * `.obsidian/**` 与插件目录仍原样转发给 base adapter（真写进本地）。
   */
  private readonlyWrite(operation: string, normalizedPath: string): string {
    const path = normalizeVaultPath(normalizedPath);
    try {
      this.onReadonlyWrite?.({ operation, path });
    } catch {
      /* 回滚/提示失败不影响写调用返回成功 */
    }
    try {
      this.diag?.({
        level: "info",
        stage: "write",
        path: path || "/",
        fid: "-",
        message: "readonly-noop",
        cause: "readonly",
      });
    } catch {
      /* 日志失败不影响写调用返回成功 */
    }
    return path;
  }

  async write(normalizedPath: string, data: string, options?: DataWriteOptions): Promise<void> {
    if (this.shouldForward(normalizedPath)) return await this.baseAdapter.write(normalizedPath, data, options);
    this.readonlyWrite("write", normalizedPath);
  }

  async writeBinary(normalizedPath: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void> {
    if (this.shouldForward(normalizedPath)) {
      return await this.baseAdapter.writeBinary(normalizedPath, data, options);
    }
    this.readonlyWrite("writeBinary", normalizedPath);
  }

  async append(normalizedPath: string, data: string, options?: DataWriteOptions): Promise<void> {
    if (this.shouldForward(normalizedPath)) return await this.baseAdapter.append(normalizedPath, data, options);
    this.readonlyWrite("append", normalizedPath);
  }

  async appendBinary(normalizedPath: string, data: ArrayBuffer, options?: DataWriteOptions): Promise<void> {
    if (this.shouldForward(normalizedPath)) {
      return await this.baseAdapter.appendBinary(normalizedPath, data, options);
    }
    this.readonlyWrite("appendBinary", normalizedPath);
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
    this.readonlyWrite("process", normalizedPath);
    // 只读语义：不执行 fn、不写回；读不到（索引外）时给空串，绝不让 Obsidian 收到写失败
    try {
      return await this.read(normalizedPath);
    } catch {
      return "";
    }
  }

  async mkdir(normalizedPath: string): Promise<void> {
    if (this.shouldForward(normalizedPath)) return await this.baseAdapter.mkdir(normalizedPath);
    this.readonlyWrite("mkdir", normalizedPath);
  }

  /** 只读下删除静默忽略（resolve true，Obsidian 不会报错）。 */
  async trashSystem(normalizedPath: string): Promise<boolean> {
    if (this.shouldForward(normalizedPath)) return await this.baseAdapter.trashSystem(normalizedPath);
    this.readonlyWrite("trashSystem", normalizedPath);
    return true;
  }

  async trashLocal(normalizedPath: string): Promise<void> {
    if (this.shouldForward(normalizedPath)) return await this.baseAdapter.trashLocal(normalizedPath);
    this.readonlyWrite("trashLocal", normalizedPath);
  }

  async rmdir(normalizedPath: string, recursive: boolean): Promise<void> {
    if (this.shouldForward(normalizedPath)) return await this.baseAdapter.rmdir(normalizedPath, recursive);
    this.readonlyWrite("rmdir", normalizedPath);
  }

  async remove(normalizedPath: string): Promise<void> {
    if (this.shouldForward(normalizedPath)) return await this.baseAdapter.remove(normalizedPath);
    this.readonlyWrite("remove", normalizedPath);
  }

  async rename(normalizedPath: string, normalizedNewPath: string): Promise<void> {
    if (this.shouldForward(normalizedPath)) {
      return await this.baseAdapter.rename(normalizedPath, normalizedNewPath);
    }
    this.readonlyWrite("rename", normalizedPath);
  }

  async copy(normalizedPath: string, normalizedNewPath: string): Promise<void> {
    if (this.shouldForward(normalizedPath)) {
      return await this.baseAdapter.copy(normalizedPath, normalizedNewPath);
    }
    this.readonlyWrite("copy", normalizedPath);
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
  private async loadBinary(
    normalizedPath: string,
    priorityOverride?: QuarkPriorityChoice
  ): Promise<ArrayBuffer> {
    const clean = normalizeVaultPath(normalizedPath);
    if (!clean) throw new QuarkEntryNotFoundError(clean);

    const cached = this.cache.get(clean);
    if (cached) return cached;

    // 0.2.13：内存 LRU → IDB mdContent（只对 md）→ 网络
    // 0.2.19 B5：磁盘缓存是加速层，**任何** IDB 异常都不得导致正文读取失败
    if (this.mdStore && isMarkdownPath(clean)) {
      const indexed = this.findEntry(clean);
      let record: MdContentRecord | null = null;
      try {
        record = await this.mdStore.get(clean);
      } catch (error) {
        record = null;
        this.reportDiagnostic({
          stage: "cache",
          path: clean,
          fid: indexed ? indexed.fid : this.fidOf(clean),
          level: "warn",
          cause: "cache-get",
          message: errorText(error),
          fields: { state: "get-error" },
        });
      }
      if (record && indexed && MdContentStore.isValid(record, indexed)) {
        const buffer = record.bytes.buffer.slice(record.bytes.byteOffset, record.bytes.byteOffset + record.bytes.byteLength) as ArrayBuffer;
        this.cache.put(clean, buffer, { fid: indexed.fid, mtime: indexed.mtime });
        this.reportInfo("cache", clean, indexed.fid, { state: "hit-md", bytes: buffer.byteLength });
        return buffer;
      }
      if (record && indexed) {
        try {
          await this.mdStore.delete(clean);
        } catch (error) {
          this.reportDiagnostic({
            stage: "cache",
            path: clean,
            fid: indexed.fid,
            level: "warn",
            cause: "cache-delete",
            message: errorText(error),
            fields: { state: "delete-error" },
          });
        }
      }
    }

    const entry = this.findEntry(clean);
    if (!entry) throw new QuarkEntryNotFoundError(clean);
    if (isDirectoryLike(entry)) throw new QuarkEntryNotFoundError(clean);

    const choice = priorityOverride ?? this.notePriority(clean);
    const priority = choice.priority;
    const token =
      this.downloadUi?.begin({ path: clean, fid: entry.fid, sizeBytes: entry.size, priority }) ?? null;
    try {
      if (token && token.aborted) throw new QuarkDownloadCanceledError();
      const buffer = await this.client.downloadFile(entry.fid, {
        signal: token,
        path: clean,
        priority,
        reason: choice.reason,
        // 0.2.27：大文件（PDF 等）按大小放宽超时；小文件不传，沿用客户端配置的默认值
        ...(() => {
          const scaled = quarkDownloadTimeoutMsForSize(entry.size);
          return scaled > QUARK_DOWNLOAD_TIMEOUT_MS ? { timeoutMs: scaled } : {};
        })(),
      });
      if (token && token.aborted) throw new QuarkDownloadCanceledError();
      this.cache.put(clean, buffer, { fid: entry.fid, mtime: entry.mtime });
      // 0.2.13：md 正文同时落 IDB（附件永不进 IDB）
      // 0.2.19 B5：put 失败只记 cause=cache-put，正文照常返回
      if (this.mdStore && isMarkdownPath(clean)) {
        try {
          await this.mdStore.put(clean, buffer, { fid: entry.fid, size: entry.size, mtime: entry.mtime });
        } catch (error) {
          this.reportDiagnostic({
            stage: "cache",
            path: clean,
            fid: entry.fid,
            level: "warn",
            cause: "cache-put",
            message: errorText(error),
            fields: { state: "put-error", bytes: buffer.byteLength },
          });
        }
      }
      this.onDownloaded?.(buffer.byteLength, priority, clean);
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

  /** 0.2.11：预取默认关（设置项 `quarkPrefetchImages`）；未注入视为关闭。 */
  private prefetchEnabled(): boolean {
    try {
      return this.allowPrefetch ? this.allowPrefetch() === true : false;
    } catch {
      return false;
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

  /**
   * 0.2.26：md 正文读的优先级判定（reason 只用于诊断日志）。
   *
   * 竞态背景：Obsidian 打开笔记时可能**先 `read()` 再触发 `file-open`**，这次读若判 bulk
   * 就会排在后台队列里（手机端表现为长时间空白）。三层判定：
   *   1. `recentOpened`（file-open 后 5s 内）→ interactive（reason=recentOpened）；
   *   2. `activeNotePath` 命中 → interactive（reason=active）；
   *   3. md 默认 interactive，但受 `interactiveBudget` 约束（reason=md-default）；
   *      预算不足 → bulk（reason=bulk），避免启动扫描把交互通道占满。
   * 非 md（附件）永远 background（reason=bg），不受交互预算影响。
   */
  private notePriority(path: string): QuarkPriorityChoice {
    if (!isMarkdownPath(path)) return { priority: "background", reason: "bg" };
    const openedAt = this.recentOpened.get(path);
    if (openedAt !== undefined && this.now() - openedAt <= this.recentOpenTtlMs) {
      return { priority: "interactive", reason: "recentOpened" };
    }
    const active = this.activeNotePath ? String(this.activeNotePath() ?? "") : "";
    if (active && path === active) return { priority: "interactive", reason: "active" };
    let budget = false;
    try {
      budget = this.interactiveBudget ? this.interactiveBudget() === true : false;
    } catch {
      budget = false;
    }
    if (budget) return { priority: "interactive", reason: "md-default" };
    return { priority: "bulk", reason: "bulk" };
  }

  /**
   * 0.2.12：按笔记精准预取——只取**这篇笔记真实引用、索引里存在、非 md** 的附件。
   *
   * - 解析六种写法（见 `utils/noteRefs`），按出现顺序；
   * - 跳过：not-indexed / cached / inflight / duplicate(fid)；
   * - 每篇上限 `prefetchPerNote`（默认 20，0=关闭）；超出记 `state=drop reason=cap`；
   * - 队列上限仍为 8；完成后写一条 `state=summary`。
   */
  async prefetchNote(notePath: string): Promise<{
    enqueued: number;
    skipped: number;
    dropped: number;
    total: number;
  }> {
    const clean = normalizeVaultPath(notePath);
    const zero = { enqueued: 0, skipped: 0, dropped: 0, total: 0 };
    if (!clean || !this.prefetchEnabled() || !isMarkdownPath(clean)) return zero;

    const capRaw = this.prefetchPerNote ? this.prefetchPerNote() : 0;
    // 0.2.13：0 = 不限（有多少取多少）；非 0 才是手动上限
    const cap = Number.isFinite(capRaw) && capRaw > 0 ? Math.floor(capRaw) : Number.POSITIVE_INFINITY;

    let content = "";
    try {
      content = await this.read(clean);
    } catch {
      return zero;
    }

    const refs = attachmentCandidates(extractAttachmentRefs(content), clean);
    const fidSeen = new Set<string>();
    let enqueued = 0;
    let skipped = 0;
    let dropped = 0;

    for (let order = 0; order < refs.length; order += 1) {
      const candidate = refs[order];
      const entry = this.findEntry(candidate);
      if (!entry) {
        skipped += 1;
        this.reportInfo("prefetch", candidate, "-", { state: "skip", reason: "not-indexed", order });
        continue;
      }
      if (fidSeen.has(entry.fid)) {
        skipped += 1;
        this.reportInfo("prefetch", candidate, entry.fid, { state: "skip", reason: "duplicate", order });
        continue;
      }
      if (this.cache.has(candidate)) {
        skipped += 1;
        this.reportInfo("prefetch", candidate, entry.fid, { state: "skip", reason: "cached", order });
        continue;
      }
      if (this.cache.isPrefetching?.(candidate)) {
        skipped += 1;
        this.reportInfo("prefetch", candidate, entry.fid, { state: "skip", reason: "inflight", order });
        continue;
      }
      if (enqueued >= cap) {
        dropped += 1;
        this.reportInfo("prefetch", candidate, entry.fid, { state: "drop", reason: "cap", order, dropped });
        continue;
      }
      const result = this.cache.enqueuePrefetch([{ path: candidate, size: entry.size }]) as
        | { queued?: number; dropped?: number }
        | undefined;
      if (result && typeof result.queued === "number" && result.queued > 0) {
        enqueued += 1;
        fidSeen.add(entry.fid);
        this.reportInfo("prefetch", candidate, entry.fid, { state: "enqueue", src: "note", order });
      } else {
        dropped += 1;
        this.reportInfo("prefetch", candidate, entry.fid, { state: "drop", reason: "cap", order, dropped });
      }
    }

    this.reportInfo("prefetch", clean, "-", {
      state: "summary",
      src: "note",
      enqueued,
      skipped,
      dropped,
    });
    return { enqueued, skipped, dropped, total: refs.length };
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

// ------------------------------------------------------------------ 0.2.18 B1：附件「点开才下」

/** 附件打开预热的节流窗口：同一 path 1 秒内最多下一次（与重绘共用）。 */
export const QUARK_ATTACHMENT_OPEN_THROTTLE_MS = 1000;

/**
 * 算作「附件」的扩展名：打开这些文件时主动 `readBinary` 预热缓存并重绘该叶子。
 * `.md` / `.canvas` / `.base` 是 Obsidian 自己渲染的文档，不算附件（不主动下载）。
 */
export const QUARK_ATTACHMENT_EXTENSIONS: readonly string[] = [
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "bmp",
  "svg",
  "avif",
  "ico",
  "pdf",
  "mp3",
  "wav",
  "m4a",
  "ogg",
  "flac",
  "mp4",
  "webm",
  "mov",
  "m4v",
  "mkv",
];

/** 是否是「点开才下」的附件路径（大小写不敏感；md/canvas/base 不算）。 */
export function isQuarkAttachmentPath(path: string): boolean {
  const clean = normalizeVaultPath(path ?? "");
  if (!clean) return false;
  const slash = clean.lastIndexOf("/");
  const name = slash >= 0 ? clean.slice(slash + 1) : clean;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return false;
  return QUARK_ATTACHMENT_EXTENSIONS.includes(name.slice(dot + 1).toLowerCase());
}

/** 图片扩展名（0.2.27：`stage=view` 的 kind 判定）。 */
const QUARK_IMAGE_EXTENSIONS = new Set([
  "jpg",
  "jpeg",
  "png",
  "gif",
  "webp",
  "bmp",
  "svg",
  "avif",
  "ico",
]);

/** 0.2.27：附件视图种类（`image` / `pdf` / `other`），用于 `stage=view` 埋点。 */
export function quarkViewKind(path: string): "image" | "pdf" | "other" {
  const clean = normalizeVaultPath(path ?? "").toLowerCase();
  const dot = clean.lastIndexOf(".");
  const ext = dot >= 0 ? clean.slice(dot + 1) : "";
  if (ext === "pdf") return "pdf";
  if (QUARK_IMAGE_EXTENSIONS.has(ext)) return "image";
  return "other";
}

/**
 * 0.2.27：大文件下载超时随大小放宽（固定 20s 会误杀几十 MB 的 PDF）。
 *
 * 估算口径：512 KB/s 下限带宽 → 每 512KB 加 1s；下限 20s（小文件不缩短）、上限 120s。
 * 例：50MB → 100s；1MB → 20s；500MB → 120s。
 */
export function quarkDownloadTimeoutMsForSize(
  sizeBytes: number | null | undefined,
  baseMs: number = 20_000
): number {
  const base = Math.max(0, Number.isFinite(baseMs) ? baseMs : 20_000);
  if (typeof sizeBytes !== "number" || !Number.isFinite(sizeBytes) || sizeBytes <= 0) return base;
  const scaled = Math.ceil(sizeBytes / (512 * 1024)) * 1000;
  return Math.max(base, Math.min(120_000, scaled));
}

/** 附件预热需要的最小宿主：读字节（走 adapter.readBinary → 下载并写缓存）+ 重绘。 */
export interface AttachmentWarmupHost {
  readBinary(path: string): Promise<unknown>;
  /** 兼容旧回调：没有 `activeLeaf` 时用它重绘。 */
  redraw?: (path: string) => void;
  /** 0.2.20 B1：下载完成后要重载的叶子（图片/PDF/媒体没有 previewMode，必须 setViewState）。 */
  activeLeaf?: () => RefreshableLeafLike | null | undefined;
  /** 0.2.22 M5：当前仍打开的叶子集合（判断发起下载的叶子是否已被关闭）。 */
  openLeaves?: () => RefreshableLeafLike[];
  /**
   * 0.2.29：下载完成、重载之前调用 —— 重新生成 blob URL（Obsidian 可能缓存旧 URL）。
   */
  refreshResource?: (path: string) => void;
  /** 时间源（单测注入假时钟），默认 `Date.now`。 */
  now?: () => number;
  /** 下载/重绘失败回调（默认吞掉：预热失败不影响阅读）。 */
  onError?: (path: string, error: unknown) => void;
  /** 0.2.21 S4：结构化日志（如 `state=skip reason=path-mismatch`）。 */
  log?: (entry: { path: string; state: string; reason?: string }) => void;
}

// ------------------------------------------------------------------ 0.2.20 B1/N9：叶子重载与 file-open 绑定

/** 需要「强制重载」的叶子最小形状（Obsidian `WorkspaceLeaf` 结构上满足）。 */
export interface RefreshableLeafLike {
  view?: {
    file?: { path?: string } | null;
    getViewData?: () => string;
    previewMode?: { rerender?: (force?: boolean) => void } | null;
  } | null;
  getViewState?: () => unknown;
  setViewState?: (state: unknown) => Promise<void>;
}

/**
 * 0.2.20 B1 / 0.2.21 S4：按视图类型重载内容。
 *
 * - Markdown（有 `getViewData`）且有 `previewMode.rerender` → `rerender(true)`；
 * - 其它视图（图片 / PDF / 媒体）→ `setViewState(getViewState())` 强制重载；
 * - 传了 `expectedPath` 且叶子已切到别的文件 → `skip`（不重载，避免刷错页）；
 * - 两者都没有 → `none`（不抛）。
 */
export function reloadLeafView(
  leaf: RefreshableLeafLike | null | undefined,
  expectedPath?: string
): "rerender" | "reload" | "skip" | "none" {
  try {
    const view = leaf?.view;
    if (expectedPath !== undefined && view?.file?.path !== expectedPath) {
      return "skip";
    }
    const previewMode = view?.previewMode;
    const isMarkdown = Boolean(view) && typeof view?.getViewData === "function";
    if (isMarkdown && previewMode && typeof previewMode.rerender === "function") {
      previewMode.rerender(true);
      return "rerender";
    }
    if (typeof leaf?.getViewState === "function" && typeof leaf?.setViewState === "function") {
      void Promise.resolve(leaf.setViewState(leaf.getViewState())).catch(() => undefined);
      return "reload";
    }
    return "none";
  } catch {
    return "none";
  }
}

/** file-open 事件引用（Obsidian `EventRef` 结构上满足）。 */
export interface QuarkEventRef {
  ref?: unknown;
}

/** 0.2.20 N9：file-open 绑定的最小宿主（workspace + 挂载态 + 打开动作）。 */
export interface QuarkFileOpenHost {
  onFileOpen(callback: () => void): QuarkEventRef;
  offFileOpen(ref: QuarkEventRef): void;
  /** 只有挂载态才处理（退出只读后即使事件残留也不联网）。 */
  isActive(): boolean;
  onOpen(): void;
}

/**
 * 0.2.20 N9：`file-open` 的注册/解绑生命周期。
 *
 * `start()` 注册（重复调用先解绑再注册，不会重复）；`stop()` 解绑。
 * 退出只读 / 插件卸载都必须 `stop()`，否则本地附件仍会走 quarkAdapter 联网。
 */
export class QuarkFileOpenBinding {
  private ref: QuarkEventRef | null = null;

  constructor(private readonly host: QuarkFileOpenHost) {}

  get bound(): boolean {
    return this.ref !== null;
  }

  start(): void {
    this.stop();
    this.ref = this.host.onFileOpen(() => {
      if (!this.host.isActive()) return;
      try {
        this.host.onOpen();
      } catch {
        /* 打开事件失败不影响其它视图 */
      }
    });
  }

  stop(): void {
    if (!this.ref) return;
    try {
      this.host.offFileOpen(this.ref);
    } catch {
      /* 事件已失效 */
    }
    this.ref = null;
  }
}

// ------------------------------------------------------------------ 0.2.23 P0：调用埋点 + 未知成员兜底

/** Obsidian `DataAdapter` 的 21 个契约方法（与官方文档一致；埋点/审计共用）。 */
export const DATA_ADAPTER_METHOD_NAMES = [
  "getName",
  "getBasePath",
  "getFullPath",
  "getResourcePath",
  "exists",
  "stat",
  "list",
  "read",
  "readBinary",
  "write",
  "writeBinary",
  "append",
  "appendBinary",
  "process",
  "mkdir",
  "rmdir",
  "remove",
  "rename",
  "copy",
  "trashSystem",
  "trashLocal",
] as const;

/** 同步返回 string 的 4 个方法（其余契约方法必须返回 Promise）。 */
const SYNC_ADAPTER_METHODS = new Set<string>(["getName", "getBasePath", "getFullPath", "getResourcePath"]);

/** 一次 adapter 调用埋点（只在返回 undefined 时记录）。 */
export interface AdapterCallLogEntry {
  name: string;
  ret: "promise" | "string" | "undefined";
  args: number;
}

/**
 * 0.2.23 P0：给 21 个契约方法包一层运行期埋点。
 *
 * 返回 undefined 时：记 `name/ret/args`（warn），并且**不让 undefined 逃逸**——
 * 异步方法改成 rejected Promise（避免 Obsidian `writeData` 里 `undefined.then`），
 * 同步方法按契约给兜底 string。正常返回值不打日志（避免日志爆炸）。
 */
export function wrapAdapterCalls<T extends object>(
  adapter: T,
  log?: (entry: AdapterCallLogEntry) => void
): T {
  const names = new Set<string>(DATA_ADAPTER_METHOD_NAMES);
  const wrappers = new Map<string, (...args: unknown[]) => unknown>();
  return new Proxy(adapter, {
    get(target, prop, receiver) {
      if (typeof prop !== "string") return Reflect.get(target, prop, receiver);
      if (!names.has(prop)) return Reflect.get(target, prop, receiver);
      const original = Reflect.get(target, prop, receiver);
      if (typeof original !== "function") return original;
      const cached = wrappers.get(prop);
      if (cached) return cached;
      const wrapped = (...args: unknown[]): unknown => {
        const result = (original as (...a: unknown[]) => unknown).apply(target, args);
        const ret: AdapterCallLogEntry["ret"] =
          result === undefined ? "undefined" : typeof result === "string" ? "string" : "promise";
        if (ret !== "undefined") return result;
        try {
          log?.({ name: prop, ret, args: args.length });
        } catch {
          /* 日志失败不影响调用 */
        }
        if (SYNC_ADAPTER_METHODS.has(prop)) {
          return prop === "getName" ? QUARK_ADAPTER_NAME : "";
        }
        return Promise.reject(new Error(`adapter.${prop}() 返回 undefined（0.2.23 P0 防护）`));
      };
      wrappers.set(prop, wrapped);
      return wrapped;
    },
  }) as T;
}

/** 未知成员兜底的选项。 */
export interface AdapterGuardOptions {
  /** 原生 adapter：契约外成员优先回落到它（真实功能尽量保留）。 */
  fallback?: Record<string, unknown> | null;
  /** 未知成员被调用时的日志出口。 */
  logUnknown?: (entry: { name: string; state: "unknown-member" }) => void;
  /** 返回 undefined 的调用日志（传给 `wrapAdapterCalls`）。 */
  logCall?: (entry: AdapterCallLogEntry) => void;
}

/** 不应被兜底拦截的属性（Promise 探测、序列化、测试库探针等）。 */
const GUARD_IGNORED_PROPS = new Set([
  "then",
  "catch",
  "finally",
  "toJSON",
  "inspect",
  "constructor",
  "prototype",
  "nodeType",
  "$$typeof",
  "asymmetricMatch",
]);

/**
 * 0.2.23 P0：挂到 `app.vault.adapter` 上的最终外观。
 *
 * ① 21 个契约方法走 `wrapAdapterCalls`（undefined → 埋点 + 防护）；
 * ② 未知成员：base adapter 有 → 回落 base；没有 → 返回
 *    「返回 rejected Promise 的函数」并记 `state=unknown-member name=<x>`。
 *    这样 Obsidian 任何 `X(...)` 后取 `.then` 都不会再拿到 undefined。
 */
export function createObsidianAdapterProxy<T extends object>(
  adapter: T,
  options: AdapterGuardOptions = {}
): T {
  const wrapped = options.logCall ? wrapAdapterCalls(adapter, options.logCall) : adapter;
  const fallback = options.fallback ?? null;
  return new Proxy(wrapped, {
    get(target, prop, receiver) {
      if (typeof prop === "symbol") return Reflect.get(target, prop, receiver);
      const name = prop;
      if (GUARD_IGNORED_PROPS.has(name)) return Reflect.get(target, prop, receiver);
      const own = Reflect.get(target, prop, receiver);
      if (own !== undefined) return own;
      if (fallback) {
        const external = fallback[name];
        if (external !== undefined) {
          return typeof external === "function"
            ? (external as (...args: unknown[]) => unknown).bind(fallback)
            : external;
        }
      }
      return (..._args: unknown[]): Promise<never> => {
        try {
          options.logUnknown?.({ name, state: "unknown-member" });
        } catch {
          /* 日志失败不影响调用 */
        }
        return Promise.reject(new Error(`未知 adapter 成员：${name}`));
      };
    },
    has(target, prop) {
      return Reflect.has(target, prop) || (fallback ? prop in fallback : false);
    },
  }) as T;
}

/**
 * 0.2.18 B1：`file-open` → 附件预热。
 *
 * 返回 `(path) => Promise<boolean>`：true 表示「这次真的下载并重绘了」。
 * 节流 ≥1s（`throttleMs`）：窗口内重复打开同一附件直接返回 false，不发第二次下载。
 * 打开 md/canvas/base 或路径为空 → false，绝不触发附件下载。
 */
export function createAttachmentWarmup(
  host: AttachmentWarmupHost,
  throttleMs: number = QUARK_ATTACHMENT_OPEN_THROTTLE_MS
): (path: string) => Promise<boolean> {
  const now = host.now ?? (() => Date.now());
  const window = Math.max(0, throttleMs);
  const lastAt = new Map<string, number>();
  return async (path: string): Promise<boolean> => {
    const clean = normalizeVaultPath(path ?? "");
    if (!isQuarkAttachmentPath(clean)) return false;
    const at = now();
    const previous = lastAt.get(clean);
    if (previous !== undefined && at - previous < window) return false;
    // 先占位：同一节流窗口内并发 file-open 也只发一次下载
    lastAt.set(clean, at);
    // 0.2.22 M5：记住发起下载的叶子（用户切走后仍能在它上面重载）
    const originLeaf = host.activeLeaf ? host.activeLeaf() : null;
    try {
      await host.readBinary(clean);
    } catch (error) {
      // 0.2.27：失败要能自证（附件视图留白时看 stage=view state=failed）
      try {
        host.log?.({ path: clean, state: "failed" });
      } catch {
        /* 日志失败不影响失败上报 */
      }
      host.onError?.(clean, error);
      return false;
    }
    // 0.2.29：重载之前先换新 blob URL（Obsidian 可能缓存了旧的占位/空 blob）
    try {
      host.refreshResource?.(clean);
    } catch {
      /* 换 URL 失败不影响已下载内容；重载仍会重新取 getResourcePath */
    }
    // 0.2.20 B1：下载完成后按视图类型重载（Markdown → rerender；图片/PDF/媒体 → setViewState）
    // 0.2.21 S4：叶子已切到别的文件时不重载（path-mismatch）
    // 0.2.22 M5：优先重载**发起时**的叶子；它已关闭才跳过（leaf-closed）
    const leaf = originLeaf ?? (host.activeLeaf ? host.activeLeaf() : null);
    if (leaf) {
      const open = host.openLeaves ? host.openLeaves() : null;
      const stillOpen = open
        ? open.includes(leaf)
        : !host.activeLeaf || host.activeLeaf() === leaf;
      if (!stillOpen) {
        try {
          host.log?.({ path: clean, state: "skip", reason: "leaf-closed" });
        } catch {
          /* 日志失败不影响已完成的下载 */
        }
      } else {
        const outcome = reloadLeafView(leaf, clean);
        if (outcome === "skip") {
          try {
            host.log?.({ path: clean, state: "skip", reason: "path-mismatch" });
          } catch {
            /* 日志失败不影响已完成的下载 */
          }
        }
      }
    } else if (host.redraw) {
      try {
        host.redraw(clean);
      } catch {
        /* 重绘失败不影响已完成的下载 */
      }
    }
    return true;
  };
}