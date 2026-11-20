/**
 * QuarkSettingsTab —— 夸克只读库的设置页（登录态 / 索引态 / 缓存态 + 三个动作）。
 *
 * 与 Google Drive 的设置页并存（各自 `addSettingTab`），互不影响。
 * 状态文案全部走纯函数，便于单测；界面只显示 cookie **名称个数**，不出现任何 cookie 值。
 */

import * as obsidianRuntime from "obsidian";
import type { App, Plugin } from "obsidian";

/** 登录态：未登录 / 已登录 / 已过期（有 cookie 但缺 `__pus` 判据）。 */
export type QuarkLoginState = "none" | "active" | "expired";

/** 状态快照（设置页 / 状态栏 / ribbon 分支判定共用）。 */
export interface QuarkUiSnapshot {
  loginState: QuarkLoginState;
  cookieNameCount: number;
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
}

/** 主插件暴露给设置页/弹窗的最小接口（避免 UI 直接操作 store/client）。 */
export interface QuarkHost {
  quarkSnapshot(): QuarkUiSnapshot;
  quarkOpenQrModal(): Promise<void>;
  quarkChooseRoot(): Promise<void>;
  quarkClearCache(): void;
  quarkExitReadOnly(): Promise<void>;
}

export const EMPTY_QUARK_SNAPSHOT: QuarkUiSnapshot = {
  loginState: "none",
  cookieNameCount: 0,
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
  const progress = snapshot.indexing
    ? ` · 索引中：已扫 ${snapshot.scannedFolders} 个目录、待扫 ${snapshot.pendingFolders} 个`
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

/** ribbon tooltip 三态（A6）：手机端看不到状态栏，靠这个 title 看状态。 */
export function describeRibbonTooltip(snapshot: QuarkUiSnapshot): string {
  if (snapshot.mounted) {
    return `同步夸克 · 已挂载（索引 ${formatBuiltAt(snapshot.builtAt)}）`;
  }
  if (snapshot.loginState === "active" || snapshot.loginState === "expired") {
    return "同步夸克 · 已登录";
  }
  return "同步夸克 · 未登录";
}

/**
 * 状态栏文案（A5 三态）：
 *   - 未登录：`Quark 只读：未登录`
 *   - 已登录未挂载：`Quark 只读：已登录未挂载`
 *   - 已挂载：`Quark 只读：已挂载（索引 2026-11-20 15:40）`
 */
export function describeStatusBar(snapshot: QuarkUiSnapshot): string {
  if (snapshot.indexing) {
    return `Quark 只读：索引中 ${snapshot.scannedFolders}/${
      snapshot.scannedFolders + snapshot.pendingFolders
    } 个目录`;
  }
  if (snapshot.mounted) {
    return `Quark 只读：已挂载（索引 ${formatBuiltAt(snapshot.builtAt)}）`;
  }
  if (snapshot.loginState === "active" || snapshot.loginState === "expired") {
    return `Quark 只读：已登录未挂载`;
  }
  return `Quark 只读：未登录`;
}

/**
 * ribbon 点击分支（A3/A4 的判定逻辑，纯函数便于单测）：
 *   - 未登录 / 登录已过期 → `"login"`（先扫码，登录成功后自动同步）
 *   - 已登录 → `"sync"`（先弹确认框，确认后才同步）
 */
export function planQuarkRibbonAction(snapshot: QuarkUiSnapshot): "login" | "sync" {
  return snapshot.loginState === "active" ? "sync" : "login";
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
    container.createEl("h2", { text: "Quark（只读库）" });

    const snapshot = this.host.quarkSnapshot();

    new Setting(container)
      .setName("库根目录")
      .setDesc(describeRootState(snapshot))
      .addButton((button: any) =>
        button.setButtonText("选择库根目录").setCta().onClick(async () => {
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

    new Setting(container)
      .setName("索引状态")
      .setDesc(describeIndexState(snapshot));

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
  }
}
