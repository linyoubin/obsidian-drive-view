import { Notice, Platform, Plugin, requestUrl } from "obsidian";
import type { DataAdapter } from "obsidian";
import { GoogleDriveDataAdapter } from "./adapter/GoogleDriveDataAdapter";
import { QuarkReadOnlyAdapter } from "./adapter/QuarkReadOnlyAdapter";
import { VaultMounter } from "./adapter/VaultMounter";
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
import { QuarkQrModal, QuarkSyncConfirmModal, describeSyncPrompt } from "./ui/QuarkQrModal";
import {
  EMPTY_QUARK_SNAPSHOT,
  QuarkSettingsTab,
  describeCacheState,
  describeIndexState,
  describeStatusBar,
  planQuarkRibbonAction,
} from "./ui/QuarkSettingsTab";
import type { QuarkHost, QuarkUiSnapshot } from "./ui/QuarkSettingsTab";
import { GoogleDriveSettingTab } from "./ui/SettingsTab";
import { normalizeVaultPath } from "./utils/pathUtils";

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
  private quarkProgress = { scanned: 0, pending: 0 };
  private lastPersistedQuarkCookie = "";

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

    this.addRibbonIcon("cloud", "Drive View: Sync now", async () => {
      await this.syncNow();
    });

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

    this.addSettingTab(new GoogleDriveSettingTab(this.app, this));

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
      loadData: async () => this.settings as unknown as Record<string, unknown>,
      saveData: async (data) => {
        // 只在 Cookie 真变化时落盘，避免每个响应都写 data.json
        const next = data[QUARK_COOKIE_STORAGE_KEY];
        if (typeof next === "string" && next === this.lastPersistedQuarkCookie) return;
        this.lastPersistedQuarkCookie = typeof next === "string" ? next : "";
        await this.updateSettings(data as Partial<PluginSettings>);
      },
      onPersistError: (error) => console.warn("[Quark] cookie persist failed:", error),
    });
    await this.quarkCookieStore.load();

    this.quarkClient = new QuarkClient({ transport: quarkTransport, cookieStore: this.quarkCookieStore });
    this.quarkCache = new ContentCache({ maxBytes: DEFAULT_CONTENT_CACHE_BYTES });
    this.quarkIndex = new IndexStore({
      createBackend: createIdbBackend({ dbName: indexDbNameForVault(this.app.vault.getName()) }),
      onStatusChange: () => this.updateQuarkStatusBar(),
    });
    this.quarkAdapter = new QuarkReadOnlyAdapter({
      index: this.quarkIndex,
      cache: this.quarkCache,
      client: this.quarkClient,
      baseAdapter: this.mounter.getOriginalAdapter(),
    });

    this.quarkStatusBarEl = this.addStatusBarItem();
    this.updateQuarkStatusBar();

    // 唯一交互入口：左侧 ribbon
    this.addRibbonIcon("refresh-cw", "同步夸克", () => {
      void this.onQuarkRibbonClick().catch((error) => {
        console.error("[Quark] ribbon action failed:", error);
        new Notice(`夸克同步失败：${error instanceof Error ? error.message : String(error)}`);
      });
    });

    // 命令面板只作内部兜底（不暴露扫码/挂载等主流程）
    this.addCommand({
      id: "quark-sync",
      name: "Quark: 同步（兜底入口）",
      callback: async () => {
        await this.onQuarkRibbonClick();
      },
    });

    this.addSettingTab(new QuarkSettingsTab(this.app, this));

    this.app.workspace.onLayoutReady(async () => {
      try {
        await this.bootstrapQuark();
      } catch (error) {
        console.warn("[Quark] bootstrap failed:", error);
        this.updateQuarkStatusBar();
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
    this.updateQuarkStatusBar();
  }

  /** ribbon 点击（A3/A4 的分支判定走纯函数，便于单测）。 */
  public async onQuarkRibbonClick(): Promise<void> {
    const action = planQuarkRibbonAction(this.quarkSnapshot());
    if (action === "login") {
      await this.quarkOpenQrModal();
      return;
    }
    const confirmed = await this.confirmQuarkSync();
    if (!confirmed) return;
    await this.quarkSync("手动同步");
  }

  /** 确认框：显示上次同步时间与条目数（A4）。 */
  private confirmQuarkSync(): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const modal = new QuarkSyncConfirmModal({
        app: this.app,
        body: describeSyncPrompt(this.quarkSnapshot()),
        onChoose: (confirmed) => {
          if (settled) return;
          settled = true;
          resolve(confirmed);
        },
      });
      modal.open();
    });
  }

  /** 扫码弹窗（QuarkHost）。登录成功 → 自动继续同步（A3）。 */
  public async quarkOpenQrModal(): Promise<void> {
    const modal = new QuarkQrModal({
      app: this.app,
      createAuth: (onProgress: (progress: QuarkQrProgress) => void) =>
        new QuarkQrAuth({ client: this.quarkClient, onProgress }),
      onDone: async (result: QuarkQrLoginResult) => {
        if (result.state !== "success") return;
        await this.quarkCookieStore.save();
        this.lastPersistedQuarkCookie = this.quarkCookieStore.getHeader();
        this.updateQuarkStatusBar();
        new Notice(`夸克已登录（${result.cookieNames?.length ?? 0} 条 cookie），开始同步索引…`, 4000);
        // 不打断、不再确认：登录成功即连续同步（A3）
        await this.quarkSync("登录后自动同步");
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
    this.quarkProgress = { scanned: 0, pending: 0 };
    const startedAt = Date.now();
    this.updateQuarkStatusBar();
    new Notice(`夸克：开始同步（${reason}）…`, 3000);

    try {
      const result = await this.quarkIndex.scan({
        rootFid: this.settings.quarkRootFid || "0",
        signal: this.quarkScanSignal,
        list: (folder) => this.listQuarkFolder(folder.path, folder.fid),
        onProgress: (progress) => {
          this.quarkProgress = {
            scanned: progress.scannedFolders.length,
            pending: progress.pendingFolders.length,
          };
          this.updateQuarkStatusBar();
        },
      });

      const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
      if (result.aborted) {
        new Notice(`夸克：同步已取消（已扫 ${result.progress.scannedFolders.length} 个目录，进度已保存）`, 6000);
        return;
      }

      const diff = result.diff;
      new Notice(
        `夸克：已同步 ${this.quarkIndex.entryCount} 条 / 耗时 ${seconds}s（新增 ${diff.added.length}、变更 ${diff.changed.length}、删除 ${diff.removed.length}）`,
        6000
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
      new Notice(`夸克：同步失败（${error instanceof Error ? error.message : String(error)}）`, 8000);
    } finally {
      this.quarkIndexing = false;
      this.quarkScanSignal = null;
      this.updateQuarkStatusBar();
    }
  }

  /** 列目录：BFS 的唯一网络出口（IndexStore.scan 的回调）。 */
  private async listQuarkFolder(folderPath: string, folderFid: string): Promise<IndexEntry[]> {
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
      this.updateQuarkStatusBar();
      return;
    }
    if (this.quarkIndex.entryCount === 0) return;
    await this.mounter.mount(this.createQuarkMountFacade());
    this.quarkMounted = true;
    this.updateQuarkStatusBar();
    new Notice(`夸克：只读库已挂载（${this.quarkIndex.entryCount} 条）`, 5000);
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
    this.quarkCache.clear();
    this.updateQuarkStatusBar();
  }

  public quarkClearCache(): void {
    this.quarkCache.clear();
    new Notice("夸克：内存缓存已清空");
    this.updateQuarkStatusBar();
  }

  /**
   * `VaultMounter.mount()` 的入参在类型上是 `GoogleDriveDataAdapter`，运行时只用到
   * `createProxiedAdapter()` / `cache.getAllEntries()` / `flushAllPendingUploads()`。
   * 这里用一个最小 facade 满足它，从而既走 `VaultMounter.mount()`（不改其源码），
   * 又不需要让 Quark 适配器继承 Drive 的类。
   */
  private createQuarkMountFacade(): GoogleDriveDataAdapter {
    const adapter = this.quarkAdapter as unknown as DataAdapter;
    const index = this.quarkIndex;
    const facade = {
      createProxiedAdapter: (): DataAdapter => adapter,
      cache: {
        getAllEntries: () =>
          index.entries.map((entry) => ({
            path: entry.path,
            name: entry.path.split("/").pop() ?? entry.path,
            type: entry.type,
            ctime: entry.mtime,
            mtime: entry.mtime,
            size: entry.size,
            driveId: entry.fid,
            parentId: entry.parentFid,
            dirty: false,
            contentCached: false,
          })),
      },
      flushAllPendingUploads: async (): Promise<void> => undefined,
    };
    return facade as unknown as GoogleDriveDataAdapter;
  }

  /** 状态快照（设置页 / 状态栏 / ribbon 分支判定共用）。 */
  public quarkSnapshot(): QuarkUiSnapshot {
    if (!this.quarkCookieStore || !this.quarkIndex || !this.quarkCache) return EMPTY_QUARK_SNAPSHOT;
    const cookieNames = this.quarkCookieStore.names();
    const loginState = this.quarkCookieStore.isEmpty
      ? "none"
      : this.quarkCookieStore.hasLoginCookie()
        ? "active"
        : "expired";
    const meta = this.quarkIndex.metaInfo;
    const status = this.quarkIndex.status;
    return {
      loginState,
      cookieNameCount: cookieNames.length,
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
    };
  }

  private updateQuarkStatusBar(): void {
    if (!this.quarkStatusBarEl || !this.quarkIndex || !this.quarkCache) return;
    const snapshot = this.quarkSnapshot();
    this.quarkStatusBarEl.setText(describeStatusBar(snapshot));
    this.quarkStatusBarEl.setAttr(
      "title",
      `夸克只读 · ${describeIndexState(snapshot)} · 缓存 ${describeCacheState(
        snapshot.cacheBytes,
        snapshot.cacheMaxBytes
      )}`
    );
  }
}
