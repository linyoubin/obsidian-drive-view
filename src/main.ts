import { Notice, Platform, Plugin, requestUrl } from "obsidian";
import * as obsidianRuntime from "obsidian";
import type { DataAdapter } from "obsidian";
import { GoogleDriveDataAdapter } from "./adapter/GoogleDriveDataAdapter";
import { QuarkReadOnlyAdapter, createReadonlyRollback } from "./adapter/QuarkReadOnlyAdapter";
import type { ReadonlyRollbackLeaf } from "./adapter/QuarkReadOnlyAdapter";
import { VaultMounter } from "./adapter/VaultMounter";
import type { VaultMountable } from "./adapter/VaultMounter";
import { CookieStore } from "./auth/CookieStore";
import { GoogleOAuthManager } from "./auth/GoogleOAuth";
import { QuarkQrAuth } from "./auth/QuarkQrAuth";
import type { QuarkQrLoginResult, QuarkQrProgress } from "./auth/QuarkQrAuth";
import { VirtualVaultCache } from "./cache/IndexedDbCache";
import { QuarkClient } from "./client/QuarkClient";
import type { QuarkTransport } from "./client/QuarkClient";
import { DriveClient } from "./drive/DriveClient";
import { ContentCache, DEFAULT_CONTENT_CACHE_BYTES } from "./store/ContentCache";
import { IndexStore, createIdbBackend, indexDbNameForVault } from "./store/IndexStore";
import type { IndexEntry } from "./store/IndexStore";
import {
  DEFAULT_QUARK_SETTINGS,
  DEFAULT_SETTINGS,
  QUARK_COOKIE_STORAGE_KEY,
  SyncState,
} from "./types";
import type { GoogleDriveSettings, PluginSettings } from "./types";
import { QuarkFolderPickerModal } from "./ui/QuarkFolderPickerModal";
import { QuarkQrModal, QuarkSyncConfirmModal, describeSyncPrompt } from "./ui/QuarkQrModal";
import type { QuarkSyncChoice } from "./ui/QuarkQrModal";
import {
  EMPTY_QUARK_SNAPSHOT,
  QuarkSettingsTab,
  describeCacheState,
  describeIndexState,
  applyQuarkRibbonTitle,
  initQuarkRibbon,
  describeRibbonTooltip,
  describeRootPath,
  describeRootState,
  describeStatusBar,
  describeSyncCancel,
  describeSyncProgressNotice,
  describeSyncResult,
  reduceQuarkFlow,
} from "./ui/QuarkSettingsTab";
import type { QuarkFlowEvent, QuarkHost, QuarkUiSnapshot } from "./ui/QuarkSettingsTab";
import { GoogleDriveSettingTab } from "./ui/SettingsTab";
import { DownloadNoticeBook } from "./client/downloadUi";
import type { DownloadNoticeLike } from "./client/downloadUi";
import { createPathThrottle, normalizeVaultPath } from "./utils/pathUtils";
import { DIAG_LOG_PATH, DIAG_TAIL_LINES, DiagLogger, tailDiagLines } from "./utils/diagLog";
import type { DiagAdapterLike } from "./utils/diagLog";

/** 运行期 Notice 的扩展能力（obsidian.d.ts 只声明了构造函数）。 */
type NoticeWithMessage = {
  setMessage?: (message: string) => void;
  noticeEl?: { setText?: (text: string) => void };
  hide?: () => void;
};

/**
 * 模块级单例（0.2.3 A2）：同步进度**只用一个 Notice 实例**，每扫完一个目录
 * `setMessage` 更新文案。真机反馈「状态信息有时候没有弹出来」正是反复 `new Notice` 造成的。
 */
let quarkSyncNotice: (Notice & NoticeWithMessage) | null = null;
let quarkSyncNoticeTimer: number | null = null;

function setNoticeMessage(notice: Notice & NoticeWithMessage, message: string): void {
  if (typeof notice.setMessage === "function") notice.setMessage(message);
  else if (notice.noticeEl && typeof notice.noticeEl.setText === "function") {
    notice.noticeEl.setText(message);
  }
}

/** 显示/更新同一个进度 Notice（duration 0，直到结束才消失）。 */
function showQuarkSyncNotice(message: string): void {
  if (quarkSyncNoticeTimer !== null) {
    window.clearTimeout(quarkSyncNoticeTimer);
    quarkSyncNoticeTimer = null;
  }
  if (!quarkSyncNotice) {
    quarkSyncNotice = new Notice(message, 0) as Notice & NoticeWithMessage;
    return;
  }
  setNoticeMessage(quarkSyncNotice, message);
}

/** 结束时把单例 Notice 换成结果文案，`hideAfterMs` 后自动消失（默认 8 秒）。 */
function finishQuarkSyncNotice(message: string, hideAfterMs = 8000): void {
  showQuarkSyncNotice(message);
  const notice = quarkSyncNotice;
  quarkSyncNoticeTimer = window.setTimeout(() => {
    quarkSyncNoticeTimer = null;
    if (notice && typeof notice.hide === "function") notice.hide();
    if (quarkSyncNotice === notice) quarkSyncNotice = null;
  }, hideAfterMs);
}

function hideQuarkSyncNotice(): void {
  if (quarkSyncNoticeTimer !== null) {
    window.clearTimeout(quarkSyncNoticeTimer);
    quarkSyncNoticeTimer = null;
  }
  if (quarkSyncNotice && typeof quarkSyncNotice.hide === "function") quarkSyncNotice.hide();
  quarkSyncNotice = null;
}

/** 夸克网络出口：唯一的 `requestUrl` 调用点（QuarkClient 只拿到这个函数）。 */
const quarkTransport: QuarkTransport = async (request) => {
  const response = await requestUrl({
    url: request.url,
    method: request.method,
    headers: request.headers,
    body: request.body,
    throw: false,
  });
  return {
    status: response.status,
    headers: response.headers,
    text: response.text,
    arrayBuffer: response.arrayBuffer,
  };
};

export default class GoogleDriveVaultPlugin extends Plugin implements QuarkHost {
  public settings: PluginSettings = { ...DEFAULT_SETTINGS, ...DEFAULT_QUARK_SETTINGS };
  public oauth!: GoogleOAuthManager;
  public driveClient!: DriveClient;
  public cache!: VirtualVaultCache;
  public driveAdapter!: GoogleDriveDataAdapter;
  public mounter!: VaultMounter;

  public currentSyncState: SyncState = "disconnected";
  public currentSyncDetail = "Not connected";

  // ---- 夸克一期（只读库）状态 ----
  public quarkCookieStore!: CookieStore;
  public quarkClient!: QuarkClient;
  public quarkIndex!: IndexStore;
  public quarkCache!: ContentCache;
  public quarkAdapter!: QuarkReadOnlyAdapter;
  public quarkMounted = false;

  private quarkStatusBarEl: HTMLElement | null = null;
  private quarkModal: QuarkQrModal | null = null;
  private quarkIndexing = false;
  private quarkScanSignal: { aborted: boolean } | null = null;
  private quarkProgress = { scanned: 0, pending: 0, current: "" };
  private lastPersistedQuarkCookie = "";
  private quarkRibbonEl: HTMLElement | null = null;
  private quarkDiag: DiagLogger | null = null;
  private quarkSettingsTab: QuarkSettingsTab | null = null;
  private lastQuarkLoginState: QuarkUiSnapshot["loginState"] | null = null;
  private lastRibbonTitleAt = 0;
  private quarkDownloadBook: DownloadNoticeBook | null = null;
  private quarkAuthExpired = false;
  private quarkRollback: ((info: { operation: string; path: string }) => void) | null = null;
  private readonly quarkPreviewThrottle = createPathThrottle(1000);
  private lastSettingsRefreshAt = 0;

  private statusBarItemEl: HTMLElement | null = null;
  private pollIntervalId: number | null = null;
  private isPolling = false;

  public async onload(): Promise<void> {
    await this.loadSettings();

    this.oauth = new GoogleOAuthManager(
      () => this.settings,
      async (partial) => {
        await this.updateSettings(partial);
      }
    );

    this.driveClient = new DriveClient(this.oauth);
    this.cache = new VirtualVaultCache(this.app.vault.getName());
    await this.cache.open();

    this.mounter = new VaultMounter(this.app);

    this.driveAdapter = new GoogleDriveDataAdapter(
      this.mounter.getOriginalAdapter(),
      this.cache,
      this.driveClient,
      () => this.settings,
      this.app.vault.configDir,
      (state, detail) => this.setSyncState(state, detail),
      (evt) => {
        this.mounter.applyVaultRawEvent(evt);
      }
    );

    if (Platform.isDesktopApp) {
      this.statusBarItemEl = this.addStatusBarItem();
      this.updateStatusBarUi();
    }


    this.addCommand({
      id: "sync-now",
      name: "Sync now with Google Drive",
      callback: async () => {
        await this.syncNow();
      },
    });

    this.addCommand({
      id: "flush-uploads",
      name: "Flush pending uploads immediately",
      callback: async () => {
        await this.driveAdapter.flushAllPendingUploads();
        new Notice("All pending uploads flushed to Google Drive.");
      },
    });

    this.addCommand({
      id: "rebuild-cache",
      name: "Rebuild local IndexedDB cache from Google Drive",
      callback: async () => {
        await this.rebuildCacheFromDrive();
      },
    });

    // 0.2.6：**只注册一个设置页**（夸克页在 initQuark 里注册）。
    // Google Drive 旧设置页 `GoogleDriveSettingTab`（src/ui/SettingsTab.ts）保留但**不再注册**：
    // Obsidian 设置侧边栏按插件名列出条目，注册两个就会并排出现两个「Quark Vault」，
    // 改页面内标题治不了。Google Drive 功能仍可通过命令面板使用
    // （sync-now / flush-uploads / rebuild-cache），不影响业务代码。

    await this.initQuark();

    this.registerObsidianProtocolHandler("drive-view-auth", async (params) => {
      try {
        new Notice("Connecting to Google Drive...");
        await this.oauth.handleDeepLinkCallback(params);
        new Notice("Connected to Google Drive!");
        await this.connectAndMountDriveVault();
      } catch (err) {
        console.error("[DriveView] Protocol handler error:", err);
        new Notice(
          `Google Sign-In failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    });

    // Mount immediately from IndexedDB cache if already configured, then sync with Drive
    this.app.workspace.onLayoutReady(async () => {
      if (this.oauth.isAuthenticated()) {
        await this.connectAndMountDriveVault();
      } else {
        this.setSyncState(
          "disconnected",
          "Sign in to Google Drive in plugin settings"
        );
      }
    });
  }

  public async onunload(): Promise<void> {
    this.stopPollingTimer();
    hideQuarkSyncNotice();
    // 0.2.9：预取循环随插件卸载停止
    this.quarkCache?.stopPrefetchLoop();
    await this.mounter.unmount(this.driveAdapter);
    // 夸克只读库：若是我们挂的，随插件卸载一起还原原生 adapter
    if (this.quarkMounted) {
      try {
        await this.mounter.unmount(this.createQuarkMountFacade());
      } catch (error) {
        console.warn("[Quark] unmount on unload failed:", error);
      }
      this.quarkMounted = false;
    }
    try {
      await this.quarkIndex?.close();
    } catch {
      /* 关闭失败不影响卸载 */
    }
    this.cache.close();
  }

  public async loadSettings(): Promise<void> {
    const raw = (await this.loadData()) as Partial<PluginSettings> | null;
    this.settings = { ...DEFAULT_SETTINGS, ...DEFAULT_QUARK_SETTINGS, ...(raw ?? {}) };
  }

  public async updateSettings(partial: Partial<PluginSettings>): Promise<void> {
    this.settings = Object.assign({}, this.settings, partial);
    // Always persist plugin settings through the original local adapter so data.json stays in .obsidian
    await this.saveData(this.settings);
  }

  public async connectAndMountDriveVault(forceFolderLookup = false): Promise<void> {
    if (!this.oauth.isAuthenticated()) {
      this.setSyncState("disconnected", "Not signed in to Google Drive");
      return;
    }

    try {
      // 1. If we already have cached entries in IndexedDB, mount the virtual adapter right away for instant startup
      if (this.cache.hasEntries() && !this.mounter.isMounted()) {
        await this.mounter.mount(this.driveAdapter);
      }

      // 2. Ensure root folder exists on Google Drive
      this.setSyncState("indexing", "Connecting to Google Drive root folder...");
      const rootMeta = await this.driveClient.ensureRootFolder(
        this.settings.rootFolderName || "ObsidianDriveVault",
        forceFolderLookup ? this.settings.rootFolderId : this.settings.rootFolderId
      );

      if (rootMeta.id !== this.settings.rootFolderId) {
        await this.updateSettings({ rootFolderId: rootMeta.id, rootFolderName: rootMeta.name });
      }

      // 3. Fetch latest file tree and prefetch text/markdown content
      await this.driveAdapter.initializeFromDrive(rootMeta.id, false);

      // 4. Mount or reconcile the full vault in Obsidian
      if (!this.mounter.isMounted()) {
        await this.mounter.mount(this.driveAdapter);
      } else {
        await this.mounter.reconcileFullVault(this.driveAdapter);
      }

      this.restartPollingTimer();
      this.setSyncState("synced", `Connected to "${rootMeta.name}"`);
    } catch (err) {
      console.error("[GoogleDriveVaultPlugin] Failed to connect and mount Drive vault:", err);
      this.setSyncState(
        "error",
        err instanceof Error ? err.message : "Failed to connect to Google Drive"
      );
      new Notice(
        `Google Drive Vault error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  public async unmountDriveVault(): Promise<void> {
    this.stopPollingTimer();
    await this.mounter.unmount(this.driveAdapter);
    this.setSyncState("disconnected", "Google Drive adapter unmounted");
    new Notice("Unmounted Google Drive backend and restored local adapter.");
  }

  public async syncNow(): Promise<void> {
    if (!this.oauth.isAuthenticated() || !this.settings.rootFolderId) {
      new Notice("Google Drive Vault is not connected yet.");
      return;
    }

    if (this.isPolling) return;
    this.isPolling = true;

    try {
      this.setSyncState("syncing", "Syncing changes with Google Drive...");
      await this.driveAdapter.flushAllPendingUploads();
      const applied = await this.driveAdapter.pollRemoteChanges(this.settings.rootFolderId);
      if (this.settings.syncConfigDir) {
        await this.driveAdapter.reconcileConfigDirWithDrive();
      }
      this.setSyncState(
        "synced",
        applied > 0 ? `Pulled ${applied} remote change(s)` : "Up to date"
      );
    } catch (err) {
      console.error("[GoogleDriveVaultPlugin] Sync error:", err);
      this.setSyncState("error", err instanceof Error ? err.message : "Sync error");
    } finally {
      this.isPolling = false;
    }
  }

  public async rebuildCacheFromDrive(): Promise<void> {
    if (!this.oauth.isAuthenticated() || !this.settings.rootFolderId) {
      new Notice("Please sign in and connect a Google Drive folder first.");
      return;
    }

    try {
      new Notice("Rebuilding local cache from Google Drive...");
      await this.driveAdapter.flushAllPendingUploads();
      await this.cache.clearAll();
      await this.driveAdapter.initializeFromDrive(this.settings.rootFolderId, true);
      await this.mounter.reconcileFullVault(this.driveAdapter);
      new Notice("Successfully rebuilt vault cache from Google Drive!");
    } catch (err) {
      new Notice(`Failed to rebuild cache: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  public restartPollingTimer(): void {
    this.stopPollingTimer();
    if (!this.oauth.isAuthenticated()) return;

    const intervalMs = Math.max(10, this.settings.pollIntervalSec || 30) * 1000;
    this.pollIntervalId = window.setInterval(() => {
      if (!this.isPolling && this.mounter.isMounted() && this.settings.rootFolderId) {
        void this.syncNow();
      }
    }, intervalMs);
    this.registerInterval(this.pollIntervalId);
  }

  private stopPollingTimer(): void {
    if (this.pollIntervalId !== null) {
      window.clearInterval(this.pollIntervalId);
      this.pollIntervalId = null;
    }
  }

  private setSyncState(state: SyncState, detail?: string): void {
    this.currentSyncState = state;
    if (detail) {
      this.currentSyncDetail = detail;
    }
    this.updateStatusBarUi();
  }

  private updateStatusBarUi(): void {
    if (!this.statusBarItemEl) return;
    const labels: Record<SyncState, string> = {
      disconnected: "Drive: Disconnected",
      authenticating: "Drive: Signing in...",
      indexing: "Drive: Indexing...",
      synced: "Drive: Synced",
      syncing: "Drive: Syncing...",
      offline: "Drive: Offline",
      error: "Drive: Error",
    };
    this.statusBarItemEl.setText(labels[this.currentSyncState] || "Drive");
    this.statusBarItemEl.setAttr("title", this.currentSyncDetail);
  }

  // ================================================================ 夸克一期（只读库）
  //
  // 入口只有一个：左侧 ribbon「同步夸克」图标（A2）。
  //   未登录 → 扫码弹窗 → 登录成功自动继续同步（A3）
  //   已登录 → 确认框「现在同步夸克索引？」→ 确认才同步（A4）
  // 同步完成若未挂载则自动挂载；已挂载只更新索引并 reconcile（A7）。

  /** 建依赖、挂 ribbon、挂设置页、监听首次启动（A9 分支写在 bootstrapQuark 里）。 */
  private async initQuark(): Promise<void> {
    this.quarkCookieStore = new CookieStore({
      app: this.app,
      storageKey: QUARK_COOKIE_STORAGE_KEY,
      loadData: async () => ({ [QUARK_COOKIE_STORAGE_KEY]: this.settings.quarkCookie }),
      saveData: async (data) => {
        // 只在 Cookie 真变化时落盘，避免每个响应都写 data.json
        const raw = data[QUARK_COOKIE_STORAGE_KEY];
        const next = typeof raw === "string" ? raw : "";
        if (next === this.lastPersistedQuarkCookie) return;
        this.lastPersistedQuarkCookie = next;
        await this.updateSettings({ quarkCookie: next });
      },
      onPersistError: (error) => console.warn("[Quark] cookie persist failed:", error),
    });
    await this.quarkCookieStore.load();

    // 0.2.4 A4′：下载中「正在下载 … [取消]」单例提示（取消 = 丢弃结果 + 不重试 + 不写缓存）
    this.quarkDownloadBook = new DownloadNoticeBook(
      {
        create: (message) => new Notice(message, 0),
        attachCancel: (notice, onCancel) => this.attachDownloadCancel(notice, onCancel),
      },
      { thresholdBytes: () => this.settings.quarkMaxFileBytes }
    );
    this.quarkClient = new QuarkClient({
      transport: quarkTransport,
      cookieStore: this.quarkCookieStore,
      downloadConcurrency: this.settings.quarkDownloadConcurrency,
      // 401：清队列 + 暂停 60s，同一失效期只回调一次 → 这里只弹一次提醒
      onAuthExpired: () => this.onQuarkAuthExpired(),
    });
    this.quarkCache = new ContentCache({ maxBytes: DEFAULT_CONTENT_CACHE_BYTES });
    this.quarkIndex = new IndexStore({
      createBackend: createIdbBackend({ dbName: indexDbNameForVault(this.app.vault.getName()) }),
      onStatusChange: () => this.refreshQuarkUi(),
    });
    // 诊断日志（0.2.3 A5）：写 `<vault>/.obsidian/plugins/drive-view/quark-debug.log`，
    // 走原生 adapter（`.obsidian/**` 已转发），不引 fs/node 依赖；失败绝不影响主流程。
    this.initQuarkRollback();
    this.quarkDiag = new DiagLogger({
      adapter: this.mounter.getOriginalAdapter() as unknown as DiagAdapterLike,
      onError: (error) => console.warn("[Quark] diag write failed:", error),
    });
    this.quarkAdapter = new QuarkReadOnlyAdapter({
      index: this.quarkIndex,
      cache: this.quarkCache,
      client: this.quarkClient,
      baseAdapter: this.mounter.getOriginalAdapter(),
      // 只在 adapter 的 catch 分支被调用：记录 path/fid/阶段（不改读写行为）
      diag: (entry) => this.quarkDiag?.log(entry),
      downloadUi: {
        begin: (info) => this.quarkDownloadBook!.begin(info),
        end: (token, outcome) => this.quarkDownloadBook!.end(token, outcome),
      },
      // 0.2.8：写操作仍 reject ReadOnlyError；拒绝前回调这里做「回滚视图到云端版本」
      onReadonlyWrite: (info) => this.quarkRollback?.(info),
    });

    this.quarkStatusBarEl = this.addStatusBarItem();
    this.refreshQuarkUi();

    // 唯一交互入口：左侧 ribbon（title 四态，手机端靠它看状态；每次状态变化刷新）
    // 0.2.5 A6′：图标固定 refresh-cw，只在初始化 setIcon 一次；状态全靠 title 后缀文字
    this.quarkRibbonEl = initQuarkRibbon({
      host: {
        addRibbonIcon: (icon, title, callback) => this.addRibbonIcon(icon, title, callback),
        setIcon: (el, icon) => {
          const setIconFn = (obsidianRuntime as unknown as { setIcon?: (element: HTMLElement, name: string) => void })
            .setIcon;
          if (typeof setIconFn === "function") setIconFn(el, icon);
        },
      },
      snapshot: this.quarkSnapshot(),
      onClick: () => {
        void this.onQuarkRibbonClick().catch((error) => {
          console.error("[Quark] ribbon action failed:", error);
          new Notice(
            `夸克同步失败：${error instanceof Error ? error.message : String(error)}\n详情见 ${DIAG_LOG_PATH}`
          );
        });
      },
    }).el;

    this.updateQuarkRibbonTooltip();

    // 命令面板只作内部兜底（不暴露扫码/挂载等主流程）
    this.addCommand({
      id: "quark-sync",
      name: "Quark: 同步（兜底入口）",
      callback: async () => {
        await this.onQuarkRibbonClick();
      },
    });

    this.quarkSettingsTab = new QuarkSettingsTab(this.app, this);
    this.addSettingTab(this.quarkSettingsTab);

    this.app.workspace.onLayoutReady(async () => {
      try {
        await this.bootstrapQuark();
      } catch (error) {
        console.warn("[Quark] bootstrap failed:", error);
        this.refreshQuarkUi();
      }
    });
  }

  /**
   * 首次启动（A9）：
   *   - 有快照 → 只读 IDB，**零网络请求**，直接挂载可用；
   *   - 无快照 → 不自动跑，只提示用户点侧边栏。
   */
  private async bootstrapQuark(): Promise<void> {
    const hadSnapshot = await this.quarkIndex.load();
    if (hadSnapshot) {
      await this.mountQuark();
      return;
    }
    if (this.quarkCookieStore.hasLoginCookie()) {
      new Notice("夸克：点左侧「同步夸克」图标开始同步索引", 6000);
    } else {
      new Notice("夸克：点左侧「同步夸克」图标扫码登录", 6000);
    }
    this.refreshQuarkUi();
  }

  /**
   * ribbon 点击（0.2.2 顺序：**先扫码 → 再选根 → 自动同步**，状态机判定走纯函数）。
   * 只有「已登录 + 已选根」才弹确认框；登录/选根刚补齐时不再打断用户。
   */
  public async onQuarkRibbonClick(): Promise<void> {
    await this.runQuarkFlow({ type: "click", snapshot: this.quarkSnapshot() });
  }

  /**
   * 流程引擎：`reduceQuarkFlow` 决定下一步，这里只做 UI/IO。
   * 取消任意一步都由状态机返回 `stop`（扫码取消不选根、选根取消不同步）。
   */
  private async runQuarkFlow(event: QuarkFlowEvent): Promise<void> {
    let action = reduceQuarkFlow(event);
    for (;;) {
      switch (action.action) {
        case "stop":
          if (action.notice) new Notice(action.notice, 8000);
          return;
        case "sync":
          await this.quarkSync(action.reason);
          return;
        case "login":
          // 扫码弹窗自己管生命周期；登录成功后从 onDone 回灌 `{ type: "login" }` 继续走「选根 → 确认框」
          await this.quarkOpenQrModal();
          return;
        case "choose-root": {
          const chosen = await this.pickQuarkRoot();
          action = reduceQuarkFlow({ type: "root", ok: chosen });
          break;
        }
        case "confirm": {
          const choice = await this.confirmQuarkSync();
          if (choice === "change-root") {
            const chosen = await this.pickQuarkRoot();
            // 0.2.7：修改库根后一律回到确认框，不自动开跑
            action = reduceQuarkFlow({ type: "root", ok: chosen });
          } else {
            action = reduceQuarkFlow({ type: "confirm", choice });
          }
          break;
        }
      }
    }
  }

  /** 设置页按钮入口：打开目录选择器。 */
  public async quarkChooseRoot(): Promise<void> {
    await this.pickQuarkRoot();
  }

  /** 目录选择器：true = 选定并已应用；false = 取消。 */
  private pickQuarkRoot(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const modal = new QuarkFolderPickerModal({
        app: this.app,
        client: this.quarkClient,
        initialFid: this.settings.quarkRootFid || "0",
        initialPath: this.settings.quarkRootPath || "/",
        onChoose: async (fid, path) => {
          // 先落设置（改根时还会清旧索引），再 resolve —— 否则调用方会在库根还没生效时就开始同步
          try {
            await this.applyQuarkRoot(fid, path);
          } finally {
            finish(true);
          }
        },
        onCancel: () => finish(false),
      });
      modal.open();
    });
  }

  /**
   * 应用新的库根（A4）：改了库根 → 先卸载旧库、清空旧快照（含 meta.rootFid）、
   * 再按新库根重建索引；两个库的条目绝不混在一起。
   */
  private async applyQuarkRoot(fid: string, path: string): Promise<void> {
    const previousFid = this.settings.quarkRootFid || "0";
    const previousPath = this.settings.quarkRootPath || "/";
    await this.updateSettings({ quarkRootFid: fid, quarkRootPath: path, quarkRootChosenAt: Date.now() });
    this.refreshQuarkUi();
    if (fid === previousFid && path === previousPath) return;

    new Notice(`夸克：库根已切换到 ${describeRootPath(path)}，索引将重建`, 8000);
    if (this.quarkMounted) {
      await this.mounter.unmount(this.createQuarkMountFacade());
      this.quarkMounted = false;
    }
    // 0.2.9：改库根时停止预取（旧库的附件不该再下载）
    this.quarkCache.stopPrefetchLoop();
    await this.quarkIndex.clearAll();
    this.quarkCache.clear();
    await this.updateSettings({ quarkLastIndexBuiltAt: 0 });
    this.refreshQuarkUi();
    // T-11：改库根后**不自动同步**，由用户确认后再跑（回到确认框 / 点同步）
  }

  /** 确认框：三行正文（库根/上次同步/将执行）+ 三按钮（现在同步/修改库根/取消）。 */
  private confirmQuarkSync(): Promise<QuarkSyncChoice> {
    return new Promise<QuarkSyncChoice>((resolve) => {
      let settled = false;
      const modal = new QuarkSyncConfirmModal({
        app: this.app,
        body: describeSyncPrompt(this.quarkSnapshot()),
        onChoose: (choice) => {
          if (settled) return;
          settled = true;
          resolve(choice);
        },
      });
      modal.open();
    });
  }

  /**
   * 扫码弹窗（QuarkHost）。0.2.2 顺序：登录成功后**先看库根**（未选则弹选择器），
   * 选定立即同步；已选根则直接同步；扫码取消/失败则整条流程终止（不选根、不同步）。
   * 弹窗在登录成功时已自行关闭（A7），同步在后台继续。
   */
  public async quarkOpenQrModal(): Promise<void> {
    const modal = new QuarkQrModal({
      app: this.app,
      createAuth: (onProgress: (progress: QuarkQrProgress) => void) =>
        new QuarkQrAuth({ client: this.quarkClient, onProgress }),
      onDone: async (result: QuarkQrLoginResult) => {
        const ok = result.state === "success";
        if (ok) {
          await this.quarkCookieStore.save();
          this.lastPersistedQuarkCookie = this.quarkCookieStore.getHeader();
          // 重新扫码成功：解除 401 熔断与「已过期」状态
          this.quarkAuthExpired = false;
          this.quarkClient.resetAuth();
          this.refreshQuarkUi();
          new Notice(`夸克已登录（${result.cookieNames?.length ?? 0} 条 cookie），继续…`, 4000);
        }
        await this.runQuarkFlow({ type: "login", ok, snapshot: this.quarkSnapshot() }).catch((error) => {
          console.error("[Quark] flow after login failed:", error);
          new Notice(`夸克同步失败：${error instanceof Error ? error.message : String(error)}`);
        });
      },
    });
    modal.open();
  }

  /** 同步索引（A8）：BFS 走 client.listDir，进度进状态栏，可取消。 */
  public async quarkSync(reason: string): Promise<void> {
    if (this.quarkIndexing) {
      if (this.quarkScanSignal) this.quarkScanSignal.aborted = true;
      new Notice("夸克：正在取消本次同步…");
      return;
    }
    if (!this.quarkCookieStore.hasLoginCookie()) {
      new Notice("夸克：请先点左侧「同步夸克」图标扫码登录");
      return;
    }

    this.quarkIndexing = true;
    this.quarkScanSignal = { aborted: false };
    this.quarkProgress = { scanned: 0, pending: 0, current: "/" };
    const startedAt = Date.now();
    // 变化点②同步开始：统一刷新（ribbon title 立即刷一次 / 状态栏 / 设置页）
    this.refreshQuarkUi(true);
    // 0.2.3 A2：同步进度走模块级单例 Notice —— 只 new 一次，之后每扫完一个目录 setMessage
    showQuarkSyncNotice(describeSyncProgressNotice(this.settings.quarkRootPath, 0, 0, "/"));

    try {
      const result = await this.quarkIndex.scan({
        rootFid: this.settings.quarkRootFid || "0",
        signal: this.quarkScanSignal,
        list: (folder) => this.listQuarkFolder(folder.path, folder.fid),
        onProgress: (progress) => {
          this.quarkProgress = {
            scanned: progress.scannedFolders.length,
            pending: progress.pendingFolders.length,
            current: this.quarkProgress.current,
          };
          this.refreshQuarkUi();
          showQuarkSyncNotice(
            describeSyncProgressNotice(
              this.settings.quarkRootPath,
              this.quarkProgress.scanned,
              this.quarkProgress.pending,
              this.quarkProgress.current
            )
          );
        },
      });

      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      if (result.aborted) {
        finishQuarkSyncNotice(describeSyncCancel(result.progress.scannedFolders.length), 8000);
        return;
      }

      // 0.2.7 索引诊断：entries/dirs/sample（用户反馈「只能看到一个文件」，先看索引里到底有什么）
      this.logQuarkIndexDiag();
      const diff = result.diff;
      // 完成：同一个 Notice 实例换成结果文案，8 秒后自动消失
      finishQuarkSyncNotice(
        describeSyncResult(
          this.quarkIndex.entryCount,
          { added: diff.added.length, changed: diff.changed.length, removed: diff.removed.length },
          seconds
        ),
        8000
      );
      await this.updateSettings({ quarkLastIndexBuiltAt: this.quarkIndex.metaInfo.builtAt });

      if (!this.mounter.isMounted()) {
        await this.mountQuark();
      } else if (this.quarkMounted) {
        // 已挂载：只把新树灌进 Obsidian，不重复 mount（A7）
        await this.mounter.reconcileFullVault(this.createQuarkMountFacade());
      }
    } catch (error) {
      console.error("[Quark] sync failed:", error);
      // 同一个单例 Notice 换成失败文案；附诊断日志位置（A5）
      finishQuarkSyncNotice(
        `夸克：同步失败（${error instanceof Error ? error.message : String(error)}）\n详情见 ${DIAG_LOG_PATH}`,
        8000
      );
    } finally {
      this.quarkIndexing = false;
      this.quarkScanSignal = null;
      // 变化点③同步结束：title 立即刷新（从「同步中」回到「已同步」）
      this.refreshQuarkUi(true);
    }
  }

  /**
   * 启动预取循环（0.2.9）：`getResourcePath` 未命中时 adapter 会入队，但之前没人消费，
   * 图片/PDF 永远拿不到 blob URL。这里用 adapter.readBinary 作为 loader（下载即写缓存），
   * 每成功预取一个附件就触发一次**节流**的轻量重绘，让 `<img>` 重新取 getResourcePath。
   */
  private startQuarkPrefetch(): void {
    if (!this.quarkCache || !this.quarkAdapter) return;
    this.quarkCache.startPrefetchLoop((path) => this.quarkAdapter.readBinary(path), {
      onLoaded: () => this.refreshQuarkPreviews(),
    });
  }

  /** 预取完成后的轻量重绘：优先 `previewMode.rerender(true)`，拿不到时回退 `setViewState(getViewState())`。同一文件 1s 内最多 1 次。 */
  private refreshQuarkPreviews(): void {
    const workspace = this.app.workspace as unknown as {
      iterateAllLeaves(callback: (leaf: unknown) => void): void;
    };
    try {
      workspace.iterateAllLeaves((raw) => {
        const leaf = raw as {
          view?: {
            file?: { path?: string } | null;
            previewMode?: { rerender?: (force?: boolean) => void } | null;
          } | null;
          getViewState?: () => unknown;
          setViewState?: (state: unknown) => Promise<void>;
        };
        const path = leaf?.view?.file?.path ?? "";
        if (!this.quarkPreviewThrottle(path)) return;
        try {
          const previewMode = leaf.view?.previewMode;
          if (previewMode && typeof previewMode.rerender === "function") {
            previewMode.rerender(true);
            return;
          }
          if (typeof leaf.getViewState === "function" && typeof leaf.setViewState === "function") {
            void leaf.setViewState(leaf.getViewState());
          }
        } catch {
          /* 重绘失败不影响预取 */
        }
      });
    } catch {
      /* workspace 不可用：忽略 */
    }
  }

  /** 索引诊断（0.2.7）：同步完成后记录条目数 / 目录数 / 前 5 条路径，便于对照真机表现。 */
  private logQuarkIndexDiag(): void {
    try {
      const entries = this.quarkIndex.entries;
      const dirs = entries.filter((entry) => entry.type === "folder").length;
      const sample = entries.slice(0, 5).map((entry) => entry.path).join(",");
      this.quarkDiag?.log({
        level: "info",
        stage: "index",
        path: this.settings.quarkRootPath || "/",
        fid: "-",
        message: `entries=${entries.length} dirs=${dirs} sample=${sample}`,
      });
    } catch (error) {
      console.warn("[Quark] index diag failed:", error);
    }
  }

  /** 列目录：BFS 的唯一网络出口（IndexStore.scan 的回调）。 */
  private async listQuarkFolder(folderPath: string, folderFid: string): Promise<IndexEntry[]> {
    // 记录「正在扫描」的目录（含根 `/`），供常驻 Notice / tooltip / 设置页显示
    this.quarkProgress = { ...this.quarkProgress, current: folderPath || "/" };
    const page = await this.quarkClient.listDir(folderFid, { all: true });
    const prefix = folderPath ? `${folderPath}/` : "";
    return page.items.map((item) => ({
      path: normalizeVaultPath(`${prefix}${item.name}`),
      type: item.isFolder ? "folder" : "file",
      fid: item.fid,
      parentFid: folderFid,
      size: item.size,
      mtime: item.updatedAt,
    }));
  }

  /** 挂载的唯一调用点（A7）：带 `mounted` 保护，走 VaultMounter。 */
  private async mountQuark(): Promise<void> {
    if (this.mounter.isMounted()) {
      this.quarkMounted = this.mounter.isMounted();
      this.refreshQuarkUi();
      return;
    }
    if (this.quarkIndex.entryCount === 0) return;
    await this.mounter.mount(this.createQuarkMountFacade());
    this.quarkMounted = true;
    this.refreshQuarkUi();
    new Notice(`夸克：只读库已挂载（${this.quarkIndex.entryCount} 条）`, 5000);
    // 0.2.9：挂载成功后启动预取循环（getResourcePath 未命中入队的附件由这里消化）
    this.startQuarkPrefetch();
  }

  /** 卸载（QuarkHost 的「退出只读模式」）：还原原生 adapter 并释放内存缓存。 */
  public async quarkExitReadOnly(): Promise<void> {
    if (this.quarkMounted) {
      await this.mounter.unmount(this.createQuarkMountFacade());
      this.quarkMounted = false;
      new Notice("夸克：已退出只读模式，恢复原生库");
    } else {
      new Notice("夸克：只读库当前未挂载");
    }
    // 0.2.9：卸载时停止预取循环（不再往已卸载的库下载附件）
    this.quarkCache.stopPrefetchLoop();
    this.quarkCache.clear();
    this.refreshQuarkUi();
  }

  public quarkClearCache(): void {
    this.quarkCache.clear();
    new Notice("夸克：内存缓存已清空");
    this.refreshQuarkUi();
  }

  /**
   * `VaultMounter.mount()` 的入参在类型上是 `GoogleDriveDataAdapter`，运行时只用到
   * `createProxiedAdapter()` / `cache.getAllEntries()` / `flushAllPendingUploads()`。
   * 这里用一个最小 facade 满足它，从而既走 `VaultMounter.mount()`（不改其源码），
   * 又不需要让 Quark 适配器继承 Drive 的类。
   */
  private createQuarkMountFacade(): VaultMountable {
    const adapter = this.quarkAdapter;
    const index = this.quarkIndex;
    const facade = {
      createProxiedAdapter: (): DataAdapter => adapter,
      cache: {
        getAllEntries: () =>
          index.entries.map((entry) => ({
            path: entry.path,
            type: entry.type,
            ctime: entry.mtime,
            mtime: entry.mtime,
            size: entry.size,
          })),
      },
      flushAllPendingUploads: async (): Promise<void> => undefined,
    };
    return facade;
  }

  /** 状态快照（设置页 / 状态栏 / ribbon 分支判定共用）。 */
  public quarkSnapshot(): QuarkUiSnapshot {
    if (!this.quarkCookieStore || !this.quarkIndex || !this.quarkCache) return EMPTY_QUARK_SNAPSHOT;
    const cookieNames = this.quarkCookieStore.names();
    const loginState = this.quarkAuthExpired
      ? "expired"
      : this.quarkCookieStore.isEmpty
        ? "none"
        : this.quarkCookieStore.hasLoginCookie()
          ? "active"
          : "expired";
    const meta = this.quarkIndex.metaInfo;
    const status = this.quarkIndex.status;
    return {
      loginState,
      cookieNameCount: cookieNames.length,
      rootPath: this.settings.quarkRootPath || "/",
      rootChosen: (this.settings.quarkRootChosenAt ?? 0) > 0,
      indexCount: this.quarkIndex.entryCount,
      builtAt: meta.builtAt || this.settings.quarkLastIndexBuiltAt,
      version: meta.version,
      cacheBytes: this.quarkCache.bytes,
      cacheMaxBytes: this.quarkCache.maxBytes,
      mounted: this.quarkMounted,
      degraded: status.degraded,
      indexing: this.quarkIndexing,
      scannedFolders: this.quarkProgress.scanned,
      pendingFolders: this.quarkProgress.pending,
      currentFolder: this.quarkProgress.current,
      downloadConcurrency: this.settings.quarkDownloadConcurrency,
      maxFileBytes: this.settings.quarkMaxFileBytes,
    };
  }

  /**
   * 写失败 → 回滚视图（0.2.8）。用户要的是「保存失败就回滚掉，然后可以继续操作其它文件」：
   * 同一 path 10 秒内只回滚一次、只提示一次；回滚 = 按 adapter 内容强制重载视图。
   * 找不到打开着的视图（后台保存）只记日志。
   */
  private initQuarkRollback(): void {
    // obsidian.d.ts 未声明 iterateAllLeaves，运行期从 workspace 取
    const workspace = this.app.workspace as unknown as {
      iterateAllLeaves(callback: (leaf: unknown) => void): void;
    };
    this.quarkRollback = createReadonlyRollback({
      workspace: {
        iterateAllLeaves: (callback: (leaf: ReadonlyRollbackLeaf) => void) =>
          workspace.iterateAllLeaves((leaf) => callback(leaf as ReadonlyRollbackLeaf)),
      },
      onRollback: ({ path, reloaded }) => {
        if (reloaded) {
          new Notice("只读库：该文件已回滚到云端版本（修改未保存）", 8000);
        }
        try {
          this.quarkDiag?.log({
            level: "info",
            stage: "write",
            path: path || "/",
            fid: "-",
            message: "rollback cause=readonly",
          });
        } catch {
          /* 日志失败不影响回滚 */
        }
      },
    });
  }

  /** 在下载提示里追加「取消」按钮（A4′）：点一下只标记 canceled，不假装中断 TCP。 */
  private attachDownloadCancel(notice: DownloadNoticeLike, onCancel: () => void): void {
    const el = notice.noticeEl as
      | { createEl?: (tag: string, options?: { text?: string }) => HTMLElement }
      | undefined;
    if (!el || typeof el.createEl !== "function") return;
    try {
      const button = el.createEl("button", { text: "取消" });
      button.addEventListener("click", (event) => {
        event.preventDefault();
        onCancel();
      });
    } catch (error) {
      console.warn("[Quark] attach download cancel failed:", error);
    }
  }

  /** 401 熔断回调（同一失效期客户端只回调一次）：只弹一次提醒并刷新 tooltip。 */
  private onQuarkAuthExpired(): void {
    if (!this.quarkAuthExpired) {
      new Notice("夸克：登录已失效，请重新扫码（点左侧「同步夸克」图标）", 10000);
    }
    this.quarkAuthExpired = true;
    this.refreshQuarkUi();
  }

  /** 设置页：下载并发（1–6，默认 4）改完立即生效。 */
  public async quarkSetDownloadConcurrency(value: number): Promise<void> {
    const numeric = Number.isFinite(value) ? Math.round(value) : 4;
    const concurrency = Math.min(6, Math.max(1, numeric));
    await this.updateSettings({ quarkDownloadConcurrency: concurrency });
    this.quarkClient?.setDownloadConcurrency(concurrency);
    this.refreshQuarkUi();
  }


  /** 设置页：大文件提醒阈值（MB，仅提示，不拦截）。 */
  public async quarkSetMaxFileMb(mb: number): Promise<void> {
    const numeric = Number.isFinite(mb) ? mb : 50;
    const safeMb = Math.max(0, Math.min(10240, numeric));
    await this.updateSettings({ quarkMaxFileBytes: Math.round(safeMb * 1024 * 1024) });
    this.refreshQuarkUi();
  }

  /**
   * 只刷新 ribbon 的 title（0.2.5 A6′：图标固定，不换）。
   * 同步中每次进度回调都会走到这里，按 ≥300ms 节流；`force=true`（同步开始/结束）立即刷新。
   */
  private updateQuarkRibbonTooltip(force = false): void {
    if (!this.quarkRibbonEl) return;
    const now = Date.now();
    if (!force && now - this.lastRibbonTitleAt < 300) return;
    this.lastRibbonTitleAt = now;
    applyQuarkRibbonTitle(this.quarkRibbonEl, this.quarkSnapshot());
  }

  /**
   * 统一状态刷新点（0.2.3 A3）：一次更新 ribbon title + 状态栏 + 设置页（节流 1 秒）。
   * 六个变化点都调它：登录成功、同步开始、同步结束、挂载完成、卸载、cookie 过期。
   */
  private refreshQuarkUi(force = false): void {
    if (!this.quarkIndex || !this.quarkCache) return;
    const snapshot = this.quarkSnapshot();
    // 第六个变化点：cookie 过期（登录态从 active 掉到 expired 时提示一次）
    if (snapshot.loginState === "expired" && this.lastQuarkLoginState === "active") {
      new Notice("夸克：登录已过期，请重新扫码（点左侧「同步夸克」图标）", 8000);
    }
    this.lastQuarkLoginState = snapshot.loginState;

    if (this.quarkStatusBarEl) {
      this.quarkStatusBarEl.setText(describeStatusBar(snapshot));
      this.quarkStatusBarEl.setAttr(
        "title",
        `夸克只读 · ${describeIndexState(snapshot)} · 缓存 ${describeCacheState(
          snapshot.cacheBytes,
          snapshot.cacheMaxBytes
        )}`
      );
    }
    this.updateQuarkRibbonTooltip(force);
    this.refreshQuarkSettingsTab();
  }

  /** 设置页若正打开着，按 1 秒节流重绘（同步中每目录刷新会太频繁）。 */
  private refreshQuarkSettingsTab(): void {
    const tab = this.quarkSettingsTab;
    if (!tab) return;
    const container = (tab as unknown as { containerEl?: HTMLElement }).containerEl;
    if (!container || !container.isConnected) return;
    const now = Date.now();
    if (now - this.lastSettingsRefreshAt < 1000) return;
    this.lastSettingsRefreshAt = now;
    try {
      tab.display();
    } catch (error) {
      console.warn("[Quark] settings refresh failed:", error);
    }
  }

  /** 设置页「导出诊断」：最近 200 行复制到剪贴板（A7），剪贴板不可用时报错不崩。 */
  public async quarkExportDiagnostics(): Promise<void> {
    try {
      const adapter = this.mounter.getOriginalAdapter();
      const text = (await adapter.exists(DIAG_LOG_PATH)) ? await adapter.read(DIAG_LOG_PATH) : "";
      const tail = tailDiagLines(text, DIAG_TAIL_LINES);
      if (!tail) {
        new Notice("夸克：诊断日志为空（还没有失败记录）", 5000);
        return;
      }
      const lines = tail.split("\n").length;
      try {
        await navigator.clipboard.writeText(tail);
        new Notice(`夸克：已复制最近 ${lines} 行诊断日志`, 5000);
      } catch (error) {
        new Notice(
          `夸克：剪贴板不可用，请手动打开 ${DIAG_LOG_PATH}（${error instanceof Error ? error.message : String(error)}）`,
          10000
        );
      }
    } catch (error) {
      new Notice(`夸克：导出诊断失败（${error instanceof Error ? error.message : String(error)}）`, 8000);
    }
  }
}
