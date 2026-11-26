/**
 * QuarkSettingsTab —— 夸克只读库的设置页（登录态 / 索引态 / 缓存态 + 三个动作）。
 *
 * 与 Google Drive 的设置页并存（各自 `addSettingTab`），互不影响。
 * 状态文案全部走纯函数，便于单测；界面只显示 cookie **名称个数**，不出现任何 cookie 值。
 */

import * as obsidianRuntime from "obsidian";
import type { App, Plugin } from "obsidian";
import { diagLogPath } from "../utils/diagLog";

/** 登录态：未登录 / 已登录 / 已过期（有 cookie 但缺 `__pus` 判据）。 */
export type QuarkLoginState = "none" | "active" | "expired";

/** 状态快照（设置页 / 状态栏 / ribbon 分支判定共用）。 */
export interface QuarkUiSnapshot {
  loginState: QuarkLoginState;
  cookieNameCount: number;
  /** 0.2.15：secretStorage 是否可用（false → 登录入口禁用）。 */
  secretAvailable: boolean;
  rootPath: string;
  rootChosen: boolean;
  indexCount: number;
  builtAt: number;
  version: number;
  cacheBytes: number;
  cacheMaxBytes: number;
  mounted: boolean;
  degraded: boolean;
  indexing: boolean;
  scannedFolders: number;
  pendingFolders: number;
  /** 正在扫描的目录（库内路径，根为 `/`）；空闲时为空串。 */
  currentFolder: string;
  /** 下载并发上限（0.2.5，默认 4，可调 1–6）。 */
  downloadConcurrency: number;
  /** 大文件提醒阈值（字节，0 = 不提醒；仅提示不拦截）。 */
  maxFileBytes: number;
  /** 0.2.11：是否预取当前笔记的图片（默认关）。 */
  prefetchImages: boolean;
  /** 0.2.13：每篇笔记预取上限（0 = 不限）。 */
  prefetchPerNote: number;
  /** 0.2.13：全库 md 正文预取开关。 */
  prefetchAllMarkdown: boolean;
  /** 0.2.28：不可预览文件（docx/xlsx/zip…）点击时跳夸克打开。 */
  openUnpreviewableInQuark: boolean;
  /** 0.2.29：图片/PDF 点击时跳夸克打开。 */
  openMediaInQuark: boolean;
  /** 0.2.13：md 磁盘正文缓存统计。 */
  mdCount: number;
  mdBytes: number;
  /** 0.2.13：bulk 进度（已下载/总数/字节/状态）。 */
  bulkDone: number;
  bulkTotal: number;
  bulkBytes: number;
  bulkState: string;
  /** 0.2.12：当前笔记本批入队数量。 */
  lastNotePrefetch: number;
  /** 0.2.11：本会话已下载文件数。 */
  sessionDownloads: number;
  /** 0.2.11：本会话已下载字节数。 */
  sessionBytes: number;
}

/** 主插件暴露给设置页/弹窗的最小接口（避免 UI 直接操作 store/client）。 */
export interface QuarkHost {
  quarkSnapshot(): QuarkUiSnapshot;
  quarkOpenQrModal(): Promise<void>;
  quarkChooseRoot(): Promise<void>;
  quarkClearCache(): void;
  quarkExitReadOnly(): Promise<void>;
  /** 0.2.3 A7：最近 200 行诊断日志复制到剪贴板。 */
  quarkExportDiagnostics(): Promise<void>;
  /** 0.2.5：下载并发（1–6，默认 4，改完立即生效）。 */
  quarkSetDownloadConcurrency(value: number): Promise<void>;
  /** 0.2.4：大文件提醒阈值（MB，仅提示不拦截）。 */
  quarkSetMaxFileMb(mb: number): Promise<void>;
  /** 0.2.11：预取开关（默认关）。 */
  quarkSetPrefetchImages(value: boolean): Promise<void>;
  /** 0.2.12：每篇笔记预取上限（0–200）。 */
  quarkSetPrefetchPerNote(value: number): Promise<void>;
  quarkSetPrefetchAllMarkdown(value: boolean): Promise<void>;
  /** 0.2.28：不可预览文件点击跳夸克开关。 */
  quarkSetOpenUnpreviewableInQuark(value: boolean): Promise<void>;
  /** 0.2.29：图片/PDF 点击跳夸克开关。 */
  quarkSetOpenMediaInQuark(value: boolean): Promise<void>;
  quarkCancelBulkPrefetch(): void;
  quarkClearMdCache(): Promise<void>;
}

export const EMPTY_QUARK_SNAPSHOT: QuarkUiSnapshot = {
  loginState: "none",
  cookieNameCount: 0,
  secretAvailable: true,
  rootPath: "/",
  rootChosen: false,
  indexCount: 0,
  builtAt: 0,
  version: 0,
  cacheBytes: 0,
  cacheMaxBytes: 8 * 1024 * 1024,
  mounted: false,
  degraded: false,
  indexing: false,
  scannedFolders: 0,
  pendingFolders: 0,
  currentFolder: "",
  downloadConcurrency: 4,
  maxFileBytes: 50 * 1024 * 1024,
  prefetchImages: true,
  prefetchPerNote: 0,
  lastNotePrefetch: 0,
  prefetchAllMarkdown: true,
  openUnpreviewableInQuark: true,
  openMediaInQuark: true,
  bulkDone: 0,
  bulkTotal: 0,
  bulkBytes: 0,
  bulkState: "idle",
  mdCount: 0,
  mdBytes: 0,
  sessionDownloads: 0,
  sessionBytes: 0,
};

/** 登录态文案：未登录 / 已登录（N 个 cookie）/ 登录已过期（缺判据）。 */
export function describeLoginState(state: QuarkLoginState, cookieNameCount: number): string {
  switch (state) {
    case "active":
      return `已登录（${cookieNameCount} 个 cookie）`;
    case "expired":
      return `登录已过期（${cookieNameCount} 个 cookie，缺少 __pus 判据）`;
    default:
      return "未登录";
  }
}

/** 本地时间 `YYYY-MM-DD HH:mm`；0 或非法值显示「从未建立」。 */
export function formatBuiltAt(builtAt: number): string {
  if (!builtAt || builtAt <= 0) return "从未建立";
  const date = new Date(builtAt);
  if (Number.isNaN(date.getTime())) return "从未建立";
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes()
  )}`;
}

/** 字节数 → `1.2 MB`；0 → `0 B`。 */
export function formatBytes(bytes: number): string {
  const value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

/** 索引态：条目数 + 建立时间（+ 降级提示 + 索引中进度）。 */
export function describeIndexState(snapshot: QuarkUiSnapshot): string {
  if (snapshot.indexCount <= 0) {
    return snapshot.degraded ? "无快照（索引未持久化）" : "无快照";
  }
  const base = `${snapshot.indexCount} 条 · v${snapshot.version} · ${formatBuiltAt(snapshot.builtAt)}`;
  const current = snapshot.currentFolder && snapshot.currentFolder !== "" ? snapshot.currentFolder : "/";
  const progress = snapshot.indexing
    ? ` · 同步中：已扫 ${snapshot.scannedFolders} · 待扫 ${snapshot.pendingFolders} · 约 ${estimateScanPercent(
        snapshot.scannedFolders,
        snapshot.pendingFolders
      )}% · 正在扫描 ${current}`
    : "";
  const degraded = snapshot.degraded ? " · 索引未持久化" : "";
  return `${base}${progress}${degraded}`;
}

/** 缓存态：已用 / 上限（百分比）。 */
export function describeCacheState(cacheBytes: number, cacheMaxBytes: number): string {
  const max = cacheMaxBytes > 0 ? cacheMaxBytes : 1;
  const percent = Math.round((Math.max(0, cacheBytes) / max) * 100);
  return `${formatBytes(cacheBytes)} / ${formatBytes(max)}（${percent}%）`;
}

/** 挂载态：已挂载（只读）/ 未挂载。 */
export function describeMountedState(mounted: boolean): string {
  return mounted ? "已挂载（只读）" : "未挂载";
}

/** 库根文案：`/知识库_云端`；未选过时提示去选。 */
export function describeRootState(snapshot: QuarkUiSnapshot): string {
  if (!snapshot.rootChosen) return "未选择（点「选择库根目录」）";
  return snapshot.rootPath && snapshot.rootPath !== "/" ? snapshot.rootPath : "根目录（整个网盘）";
}

/** 首次使用判定：没选过库根就必须先选（T-11 A2）。 */
export function shouldForceRootPicker(settings: { quarkRootChosenAt?: number }): boolean {
  return !settings.quarkRootChosenAt;
}

/** 库根展示文案（设置页/提示共用）。 */
export function describeRootPath(rootPath: string | null | undefined): string {
  const path = String(rootPath ?? "");
  return path && path !== "/" ? path : "根目录（整个网盘）";
}

/** 同步进度文案：`同步 /知识库_云端：12/194 目录`（T-11 A5）。 */
export function describeSyncProgress(rootPath: string, scanned: number, total: number): string {
  return `同步 ${describeRootPath(rootPath)}：${scanned}/${total} 目录`;
}

/**
 * 扫描百分比（**估算值**，T-11 addendum A9）。
 *
 * 定义：`已扫 / (已扫 + 待扫)`。BFS 的目录总数要一边扫一边才被发现，
 * 所以这不是精确进度，界面文案统一写「约 N%」。
 * 分母为 0 时：还没扫到任何东西 → 0；已经扫完且没有待扫 → 100。
 */
export function estimateScanPercent(scanned: number, pending: number): number {
  const total = Math.max(0, scanned) + Math.max(0, pending);
  if (total <= 0) return scanned > 0 ? 100 : 0;
  const percent = Math.round((Math.max(0, scanned) / total) * 100);
  return Math.max(0, Math.min(100, percent));
}

/** 常驻进度 Notice 的文案（T-11 addendum A9/A10）。 */
export function describeSyncProgressNotice(
  rootPath: string,
  scanned: number,
  pending: number,
  currentFolder: string
): string {
  const current = currentFolder && currentFolder !== "" ? currentFolder : "/";
  return `同步 ${describeRootPath(rootPath)}：已扫 ${scanned} · 待扫 ${pending} · 约 ${estimateScanPercent(
    scanned,
    pending
  )}% · 正在扫描 ${current}`;
}

/** 取消同步的文案（T-11 addendum A9）。 */
export function describeSyncCancel(scanned: number): string {
  return `已取消同步（已扫 ${scanned} 个目录，索引保留上一版）`;
}

/**
 * 同步完成文案：`已同步 N 条 · 新增 a · 变更 b · 删除 c · 耗时 Xs`（T-11 A5）。
 *
 * 库根不在这行里重复：同步全程的常驻 Notice 已带库根，设置页/确认框也各有一处，
 * 这里保持一行可扫读，Notice 5 秒自动消失。
 */
export function describeSyncResult(
  entryCount: number,
  diff: { added: number; changed: number; removed: number },
  seconds: string
): string {
  return `已同步 ${entryCount} 条 · 新增 ${diff.added} · 变更 ${diff.changed} · 删除 ${diff.removed} · 耗时 ${seconds}s`;
}

/**
 * ribbon 的 title（0.2.5 A6′）：图标固定 `refresh-cw`，**状态只用后缀文字表达**。
 *   - 未登录：`同步夸克 · 未登录`
 *   - 已登录：`同步夸克 · 已登录`
 *   - 同步中：`同步夸克 · 同步中 29% · /技术`
 *   - 已同步：`同步夸克 · 已同步（索引 15:40 · 128 条）`
 *   - 登录过期：`同步夸克 · 已登录（过期）`
 */
export function describeRibbonTooltip(snapshot: QuarkUiSnapshot): string {
  if (snapshot.indexing) {
    const current = snapshot.currentFolder && snapshot.currentFolder !== "" ? snapshot.currentFolder : "/";
    return `同步夸克 · 同步中 ${estimateScanPercent(
      snapshot.scannedFolders,
      snapshot.pendingFolders
    )}% · ${current}`;
  }
  if (snapshot.loginState === "active") {
    if (snapshot.indexCount > 0) {
      return `同步夸克 · 已同步（索引 ${formatBuiltAt(snapshot.builtAt)} · ${snapshot.indexCount} 条）`;
    }
    return "同步夸克 · 已登录";
  }
  if (snapshot.loginState === "expired") return "同步夸克 · 已登录（过期）· 需重新扫码";
  return "同步夸克 · 未登录";
}

/** ribbon 图标固定值（0.2.5 A6′：任何状态都不换图标）。 */
export const QUARK_RIBBON_ICON = "refresh-cw";

/** ribbon 相关的最小宿主（obsidian 的 `addRibbonIcon` / `setIcon` 形状）。 */
export interface QuarkRibbonHost {
  addRibbonIcon(icon: string, title: string, callback: (event: MouseEvent) => unknown): HTMLElement;
  setIcon?(el: HTMLElement, icon: string): void;
}

/**
 * 初始化 ribbon（0.2.5 A6′）：
 *   - 图标**只在这里**设置一次（`setIcon` 调用次数恒为 1），之后任何状态都不换；
 *   - 之后只改 `title`（后缀文字），见 `applyQuarkRibbonTitle`。
 */
export function initQuarkRibbon(options: {
  host: QuarkRibbonHost;
  snapshot: QuarkUiSnapshot;
  onClick: () => void;
}): { el: HTMLElement; setIconCalls: number } {
  const el = options.host.addRibbonIcon(
    QUARK_RIBBON_ICON,
    describeRibbonTooltip(options.snapshot),
    options.onClick
  );
  let setIconCalls = 0;
  if (typeof options.host.setIcon === "function") {
    options.host.setIcon(el, QUARK_RIBBON_ICON);
    setIconCalls = 1;
  }
  return { el, setIconCalls };
}

/** 之后每次只刷新 title（不碰图标、不重建 ribbon）。 */
export function applyQuarkRibbonTitle(el: HTMLElement, snapshot: QuarkUiSnapshot): void {
  el.setAttr("title", describeRibbonTooltip(snapshot));
}

/**
 * 状态栏文案（A5 三态）：
 *   - 未登录：`Quark 只读：未登录`
 *   - 已登录未挂载：`Quark 只读：已登录未挂载`
 *   - 已挂载：`Quark 只读：已挂载（索引 2026-11-20 15:40）`
 */
export function describeStatusBar(snapshot: QuarkUiSnapshot): string {
  if (snapshot.indexing) {
    const current = snapshot.currentFolder && snapshot.currentFolder !== "" ? snapshot.currentFolder : "/";
    return `Quark 只读：同步中 ${estimateScanPercent(
      snapshot.scannedFolders,
      snapshot.pendingFolders
    )}% · ${current}`;
  }
  if (snapshot.mounted) {
    return `Quark 只读：已挂载（索引 ${formatBuiltAt(snapshot.builtAt)}）`;
  }
  if (snapshot.loginState === "active" || snapshot.loginState === "expired") {
    return `Quark 只读：已登录未挂载`;
  }
  return `Quark 只读：未登录`;
}

/** 必经的选根被取消时的提示（0.2.2：终止流程，登录状态保留）。 */
export const QUARK_ROOT_REQUIRED_NOTICE = "夸克：需先选择知识库根目录（点左侧「同步夸克」图标）";

/** 触发流程下一步的输入：ribbon 点击、扫码结果、选根结果、确认框选择。 */
export type QuarkFlowEvent =
  | { type: "click"; snapshot: QuarkUiSnapshot }
  | { type: "login"; ok: boolean; snapshot: QuarkUiSnapshot }
  | { type: "root"; ok: boolean; returnToConfirm?: boolean }
  | { type: "confirm"; choice: "sync" | "change-root" | "cancel" };

/** 引擎要执行的一步；`stop` 表示终止（带提示时弹 Notice）。 */
export type QuarkFlowAction =
  | { action: "login" }
  | { action: "choose-root" }
  | { action: "confirm" }
  | { action: "sync"; reason: string }
  | { action: "stop"; notice: string | null };

/**
 * 点「同步夸克」后的状态机（0.2.2 顺序：**先扫码 → 再选根 → 自动同步**，A3/A4）：
 *
 * | 点之前的状态 | 点击后的流程 |
 * |---|---|
 * | 未登录 + 未选根 | 扫码 → 选根 → 选定即同步 |
 * | 未登录 + 已选根 | 扫码 → 成功即同步（不弹确认框） |
 * | 已登录 + 未选根 | 选根 → 选定即同步 |
 * | 已登录 + 已选根 | 确认框（现在同步 / 修改库根 / 取消） |
 *
 * 取消扫码 → 终止，不选根、不同步；取消选根 → 终止并提示必须选根（登录状态保留）。
 * 确认框里「修改库根」→ 选完回确认框，不直接开跑。
 */
/**
 * 点「同步夸克」后的状态机（0.2.7：**永远不自动同步**）：
 * 固定三段顺序「登录 → 选库根 → 确认框」，每段“已满足”就跳过；
 * 扫码成功、选根成功都**只推进到下一段**，绝不直接开跑，一律以确认框收尾。
 *
 * | 点之前的状态 | 点击后的流程 |
 * |---|---|
 * | 未登录 + 未选根 | 扫码 → 选根 → 确认框 |
 * | 未登录 + 已选根 | 扫码 → 确认框 |
 * | 已登录 + 未选根 | 选根 → 确认框 |
 * | 已登录 + 已选根 | 确认框 |
 *
 * 任何阶段取消 → 终止；确认框「修改库根」→ 选新根 → 回到确认框（不自动开跑）。
 */
export function reduceQuarkFlow(event: QuarkFlowEvent): QuarkFlowAction {
  switch (event.type) {
    case "click":
      if (event.snapshot.loginState !== "active") return { action: "login" };
      return event.snapshot.rootChosen ? { action: "confirm" } : { action: "choose-root" };
    case "login":
      if (!event.ok) return { action: "stop", notice: null };
      // 0.2.7：登录成功**不自动同步**，只推进到「选根」或「确认框」
      return event.snapshot.rootChosen ? { action: "confirm" } : { action: "choose-root" };
    case "root":
      if (!event.ok) return { action: "stop", notice: QUARK_ROOT_REQUIRED_NOTICE };
      // 0.2.7：选根成功也**不自动同步**，一律回到确认框
      return { action: "confirm" };
    case "confirm":
      if (event.choice === "cancel") return { action: "stop", notice: null };
      if (event.choice === "change-root") return { action: "choose-root" };
      return { action: "sync", reason: "手动同步" };
  }
}

interface SettingTabLike {
  app: App;
  containerEl: HTMLElement;
  display(): void;
  hide(): void;
}
type SettingTabCtor = new (app: App, plugin: Plugin) => SettingTabLike;

/**
 * 取运行期的 `PluginSettingTab` 基类（走命名空间访问，理由同 QuarkQrModal：
 * 单测里 `obsidian` 被最小 mock 时仍能加载本模块的纯函数）。
 */
function settingTabBase(): SettingTabCtor {
  const runtime = obsidianRuntime as unknown as { PluginSettingTab?: SettingTabCtor };
  if (runtime.PluginSettingTab) return runtime.PluginSettingTab;
  class StubSettingTab implements SettingTabLike {
    app: App;
    containerEl: HTMLElement;
    constructor(app: App) {
      this.app = app;
      this.containerEl = {} as HTMLElement;
    }
    display(): void {}
    hide(): void {}
  }
  return StubSettingTab;
}

/** 取运行期的 `Setting` 构造器；没有 UI 运行时返回 null（单测里不渲染界面）。 */
function settingConstructor(): (new (container: HTMLElement) => any) | null {
  const runtime = obsidianRuntime as unknown as { Setting?: new (container: HTMLElement) => any };
  return runtime.Setting ?? null;
}

export class QuarkSettingsTab extends settingTabBase() {
  private readonly host: Plugin & QuarkHost;

  constructor(app: App, host: Plugin & QuarkHost) {
    super(app, host);
    this.host = host;
  }

  display(): void {
    const Setting = settingConstructor();
    if (!Setting) return;
    const container = this.containerEl;
    container.empty();
    container.createEl("h2", { text: "Quark Vault（只读库）" });

    const snapshot = this.host.quarkSnapshot();

    new Setting(container)
      .setName("库根目录")
      .setDesc(describeRootState(snapshot))
      .addButton((button: any) =>
        button.setButtonText("修改库根").setCta().onClick(async () => {
          await this.host.quarkChooseRoot();
          this.display();
        })
      );

    new Setting(container)
      .setName("登录状态")
      .setDesc(describeLoginState(snapshot.loginState, snapshot.cookieNameCount))
      .addButton((button: any) =>
        button.setButtonText("重新扫码").setCta().onClick(async () => {
          await this.host.quarkOpenQrModal();
          this.display();
        })
      );

    // 0.2.15：凭据存储只允许 secretStorage（Obsidian 1.11.4+）
    new Setting(container)
      .setName("凭据存储")
      .setDesc(
        snapshot.secretAvailable
          ? "secretStorage（系统密钥链）"
          : "需要 Obsidian 1.11.4 及以上（当前 secretStorage 不可用），扫码登录已禁用"
      );

    new Setting(container)
      .setName("索引状态")
      .setDesc(describeIndexState(snapshot));

    // 0.2.5 A8：下载并发（1–6，默认 4）
    new Setting(container)
      .setName("下载并发（1–6，默认 4）")
      .setDesc(`当前 ${snapshot.downloadConcurrency} 路同时下载；超过后其余排队等待（FIFO）`)
      .addText((text: any) =>
        text
          .setPlaceholder("4")
          .setValue(String(snapshot.downloadConcurrency))
          .onChange(async (value: string) => {
            const parsed = Number.parseInt(String(value), 10);
            if (Number.isFinite(parsed)) await this.host.quarkSetDownloadConcurrency(parsed);
          })
      );

    // 0.2.13：按笔记精准预取（默认开；上限 0 = 不限）
    new Setting(container)
      .setName("预取当前笔记的图片（默认开）")
      .setDesc(
        snapshot.prefetchImages
          ? `打开 .md 时只预取这篇笔记真实引用的附件：本笔记 ${snapshot.lastNotePrefetch} 张，上限 ${snapshot.prefetchPerNote === 0 ? "不限" : snapshot.prefetchPerNote}，队列上限 8、并发 2`
          : "关闭：图片只有在文件树里手动点开时才下载"
      )
      .addToggle((toggle: any) =>
        toggle.setValue(snapshot.prefetchImages).onChange(async (value: boolean) => {
          await this.host.quarkSetPrefetchImages(value === true);
          this.display();
        })
      );

    new Setting(container)
      .setName("每篇笔记预取上限（0 = 不限）")
      .setDesc(`当前 ${snapshot.prefetchPerNote === 0 ? "不限" : snapshot.prefetchPerNote} 张；0 表示有多少取多少`)
      .addText((text: any) =>
        text
          .setPlaceholder("0")
          .setValue(String(snapshot.prefetchPerNote))
          .onChange(async (value: string) => {
            const parsed = Number.parseInt(String(value), 10);
            if (Number.isFinite(parsed)) await this.host.quarkSetPrefetchPerNote(parsed);
          })
      );

    // 0.2.13：全库 md 正文预取（内容搜索用，默认开）
    new Setting(container)
      .setName("预取全库 Markdown 正文（默认开）")
      .setDesc(
        snapshot.prefetchAllMarkdown
          ? `后台低优先级预取（供内容搜索）：${snapshot.bulkDone}/${snapshot.bulkTotal} · ${(snapshot.bulkBytes / (1024 * 1024)).toFixed(2)} MB · ${snapshot.bulkState}`
          : "关闭：全局搜索首次会现拉文件；只影响搜索速度，不影响打开笔记"
      )
      .addToggle((toggle: any) =>
        toggle.setValue(snapshot.prefetchAllMarkdown).onChange(async (value: boolean) => {
          await this.host.quarkSetPrefetchAllMarkdown(value === true);
          this.display();
        })
      )
      .addButton((button: any) =>
        button.setButtonText("取消正文预取").onClick(() => {
          this.host.quarkCancelBulkPrefetch();
          this.display();
        })
      );

    // 0.2.28/0.2.29：非 md 文件点击时跳夸克打开（两个开关，默认都开）
    new Setting(container)
      .setName("Office/压缩包/音视频：点击跳夸克（默认开）")
      .setDesc(
        snapshot.openUnpreviewableInQuark
          ? "点击 .docx / .xlsx / .zip / .epub / .mp4 等 Obsidian 不能预览的文件时，确认后打开它所在的夸克网盘目录"
          : "关闭：点击这些文件不弹确认、不打开浏览器（按只读占位静默处理）"
      )
      .addToggle((toggle: any) =>
        toggle.setValue(snapshot.openUnpreviewableInQuark).onChange(async (value: boolean) => {
          await this.host.quarkSetOpenUnpreviewableInQuark(value === true);
          this.display();
        })
      );

    new Setting(container)
      .setName("PDF：点击跳夸克（默认开）")
      .setDesc(
        snapshot.openMediaInQuark
          ? "点击 PDF 时确认后在夸克网页打开所在目录（Obsidian 内置 PDF 阅读器依赖本地 app:// 路径，虚拟库不可用）"
          : "关闭：点击 PDF 交回 Obsidian 尝试渲染（打开空白即平台限制）"
      )
      .addToggle((toggle: any) =>
        toggle.setValue(snapshot.openMediaInQuark).onChange(async (value: boolean) => {
          await this.host.quarkSetOpenMediaInQuark(value === true);
          this.display();
        })
      );

    new Setting(container)
      .setName("本次会话下载统计")
      .setDesc(
        `已下载 ${snapshot.sessionDownloads} 个文件 / ${(snapshot.sessionBytes / (1024 * 1024)).toFixed(2)} MB（正文与附件合计）`
      );

    // 0.2.4 A6′：「单文件上限」改成提醒阈值，只影响提示、不拦截下载
    new Setting(container)
      .setName("大文件提醒阈值（MB，默认 50，0 = 不提醒）")
      .setDesc(
        `超过 ${Math.round(snapshot.maxFileBytes / (1024 * 1024))} MB 时在下载提示里额外提醒；仅提示，不拦截下载`
      )
      .addText((text: any) =>
        text
          .setPlaceholder("50")
          .setValue(String(Math.round(snapshot.maxFileBytes / (1024 * 1024))))
          .onChange(async (value: string) => {
            const parsed = Number.parseFloat(String(value));
            if (Number.isFinite(parsed)) await this.host.quarkSetMaxFileMb(parsed);
          })
      );

    new Setting(container)
      .setName("内容缓存（内存，不落盘）")
      .setDesc(describeCacheState(snapshot.cacheBytes, snapshot.cacheMaxBytes))
      .addButton((button: any) =>
        button.setButtonText("清空缓存").onClick(() => {
          this.host.quarkClearCache();
          this.display();
        })
      );

    new Setting(container)
      .setName("正文缓存（磁盘 IndexedDB，仅 md）")
      .setDesc(
        `磁盘 ${(snapshot.mdBytes / (1024 * 1024)).toFixed(2)} MB / ${snapshot.mdCount} 篇 · 内存 ${(snapshot.cacheBytes / (1024 * 1024)).toFixed(2)} MB / ${(snapshot.cacheMaxBytes / (1024 * 1024)).toFixed(0)} MB`
      )
      .addButton((button: any) =>
        button.setButtonText("清空磁盘正文").setWarning().onClick(async () => {
          await this.host.quarkClearMdCache();
          this.display();
        })
      );

    new Setting(container)
      .setName("挂载状态")
      .setDesc(describeMountedState(snapshot.mounted))
      .addButton((button: any) =>
        button.setButtonText("退出只读模式").setWarning().onClick(async () => {
          await this.host.quarkExitReadOnly();
          this.display();
        })
      );

    container.createEl("p", {
      text: "只读：写操作一律拒绝；正文与附件只进内存（8 MB LRU），不占用本地空间。",
    });

    // 0.2.3 A7：出错时把最近 200 行诊断日志复制走（日志不含 cookie 与正文）
    // 0.2.19：日志路径随 configDir（不再写死 .obsidian）
    const diagPath = diagLogPath(this.app.vault.configDir);
    new Setting(container)
      .setName("诊断")
      .setDesc(`打开失败等异常会记到 ${diagPath}（不含 cookie 与正文）`)
      .addButton((button: any) =>
        button.setButtonText("导出诊断").onClick(async () => {
          await this.host.quarkExportDiagnostics();
        })
      );

    // 0.2.6：插件只注册这一个设置页（Google Drive 旧设置页不再注册），这里注明其功能仍可用
    container.createEl("p", {
      text: "Google Drive 旧功能仍可在命令面板使用（sync-now / flush-uploads / rebuild-cache）；其专属设置页已不再注册，避免设置里出现两个同名页面。",
    });
  }
}

/** 0.2.14：登录成功后的去向（有快照且库根一致 → 直接挂载，零网络）。 */
