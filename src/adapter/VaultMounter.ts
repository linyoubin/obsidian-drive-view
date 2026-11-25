import type { App, DataAdapter, MarkdownView, TFile, TFolder } from "obsidian";
import { getParentPath, isConfigOrInternalPath } from "../utils/pathUtils";
import type { ObsidianVaultRawEvent } from "./GoogleDriveDataAdapter";

/**
 * 运行期不 import `obsidian` 的值（`TFile/TFolder/MarkdownView` 改成结构判定）：
 * 这样 VaultMounter 能在单测里直接 import，不需要整进程 mock Obsidian。
 */
function isFolderNode(node: unknown): boolean {
  return Boolean(node) && Array.isArray((node as { children?: unknown }).children);
}

interface MarkdownViewLike {
  file?: { path?: string } | null;
  getViewData(): string;
  setViewData(data: string, clear: boolean): void;
}

function isMarkdownViewLike(view: unknown): view is MarkdownViewLike {
  if (!view || typeof view !== "object") return false;
  const candidate = view as { getViewData?: unknown; setViewData?: unknown };
  return typeof candidate.getViewData === "function" && typeof candidate.setViewData === "function";
}

/**
 * VaultMounter 实际只依赖这三样能力，因此入口参数不再绑定 Google Drive 的具体类（T-10 放宽）：
 * 夸克只读适配器也能挂载，且调用方不需要任何类型断言。
 */
export interface VaultMountable {
  createProxiedAdapter(): DataAdapter;
  cache: { getAllEntries(): unknown[] };
  flushAllPendingUploads?(): Promise<void> | void;
}

/** `cache.getAllEntries()` 返回的树条目（只用到这几个字段）。 */
interface VaultTreeEntry {
  path: string;
  type: "file" | "folder";
  ctime?: number;
  mtime?: number;
  size?: number;
}

type InternalVault = App["vault"] & {
  fileMap?: Record<string, TFile | TFolder>;
  onChange?: (
    type:
      | "folder-created"
      | "file-created"
      | "modified"
      | "file-removed"
      | "folder-removed"
      | "renamed"
      | "raw"
      | "closed",
    path: string,
    oldPathOrRealPath?: string,
    stat?: { ctime: number; mtime: number; size: number }
  ) => void;
};

type InternalMetadataCache = App["metadataCache"] & {
  initialize?: () => void;
};

export class VaultMounter {
  private mounted = false;
  private originalAdapter: DataAdapter | null = null;

  constructor(private readonly app: App) {}

  public isMounted(): boolean {
    return this.mounted;
  }

  public getOriginalAdapter(): DataAdapter {
    return this.originalAdapter || this.app.vault.adapter;
  }

  /**
   * Swaps `app.vault.adapter` with the proxied adapter (Google Drive or Quark) and reconciles
   * Obsidian's Vault fileMap and MetadataCache with the virtual file tree.
   */
  public async mount(mountable: VaultMountable): Promise<void> {
    if (!this.originalAdapter) {
      this.originalAdapter = this.app.vault.adapter;
    }

    // Stop local filesystem watcher on the stub folder while virtual adapter is active
    await this.stopLocalWatch();

    this.app.vault.adapter = mountable.createProxiedAdapter();
    this.mounted = true;

    await this.reconcileFullVault(mountable);
  }

  /**
   * Flushes pending writes and restores the original native `DataAdapter`.
   *
   * 0.2.19 B3：只换回 adapter 不够 —— 云端合成节点会留在 `Vault.fileMap`、
   * 本地文件也回不来。顺序：停监听 → 恢复 base adapter → 按本地磁盘重建 fileMap → 重启本地监听。
   */
  public async unmount(mountable?: VaultMountable): Promise<void> {
    if (!this.mounted || !this.originalAdapter) return;

    try {
      await mountable?.flushAllPendingUploads?.();
    } catch (err) {
      console.warn("[VaultMounter] Error flushing pending uploads on unmount:", err);
    }

    await this.stopLocalWatch();
    this.app.vault.adapter = this.originalAdapter;
    this.mounted = false;
    await this.rebuildFileMapFromLocal();
    this.startLocalWatch();
  }

  /** 停掉本地文件监听（mount/unmount 都调用；不支持此能力的平台静默忽略）。 */
  private async stopLocalWatch(): Promise<void> {
    const original = this.originalAdapter as (DataAdapter & { stopWatch?: () => Promise<void> | void }) | null;
    if (!original) return;
    try {
      await original.stopWatch?.();
    } catch {
      // Ignore if stopWatch is not supported on this platform
    }
  }

  /** 重启本地文件监听（unmount 还原后必须重新盯本地磁盘）。 */
  private startLocalWatch(): void {
    const original = this.originalAdapter as (DataAdapter & {
      startWatch?: () => Promise<void> | void;
    }) | null;
    if (!original) return;
    try {
      void original.startWatch?.();
    } catch {
      // Ignore if startWatch is not supported on this platform
    }
  }

  /**
   * 0.2.19 B3 / 0.2.21 N4-N5：把 `Vault.fileMap` 对齐到**本地磁盘**，增量执行。
   *
   * - 只删「云端独有」（fileMap 有、本地没有）的节点，两边都有的**不动**（避免闪白）；
   * - 只补「本地缺失」（本地有、fileMap 没有）的节点；
   * - 跳过 `configDir` / `.trash`（0.2.21 N5），且不做全库 `stat`（移动端不卡退出）。
   */
  public async rebuildFileMapFromLocal(): Promise<void> {
    const internalVault = this.app.vault as InternalVault;
    if (!internalVault.fileMap) return;

    const entries = await this.collectLocalEntries();
    const localPaths = new Set(entries.map((entry) => entry.path));

    // 1) 只删云端独有（子路径先删，父目录后删）
    const stale = Object.keys(internalVault.fileMap)
      .filter((path) => path !== "/" && !localPaths.has(path))
      .sort((a, b) => b.length - a.length);
    for (const path of stale) {
      const item = internalVault.fileMap[path];
      internalVault.onChange?.(isFolderNode(item) ? "folder-removed" : "file-removed", path);
    }

    // 2) 只补本地缺失（父目录先于子项）
    const missing = entries
      .filter((entry) => !internalVault.fileMap?.[entry.path])
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
        return a.path.split("/").length - b.path.split("/").length;
      });
    for (const entry of missing) {
      this.applyLocalEntry(entry, internalVault);
    }

    this.refreshFileExplorerViews();
  }

  /** 0.2.21 N5：配置目录与回收站不参与本地树还原。 */
  private isSkippedLocalPath(path: string): boolean {
    const configDir = String(this.app.vault.configDir ?? "");
    if (configDir && (path === configDir || path.startsWith(`${configDir}/`))) return true;
    return path === ".trash" || path.startsWith(".trash/");
  }

  /**
   * 递归列出本地磁盘条目（非递归 `list` 逐层展开，带 visited 防环）。
   *
   * 0.2.21 N5：跳过 configDir / `.trash`；**不调用 `adapter.stat`**（移动端全库 stat 会卡退出，
   * 这里放弃 mtime 精确恢复，退出后再由 Obsidian 自己的监听补上）。
   */
  private async collectLocalEntries(): Promise<VaultTreeEntry[]> {
    const adapter = this.originalAdapter;
    if (!adapter) return [];
    const entries: VaultTreeEntry[] = [];
    const queue: string[] = [""];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const dir = queue.shift() as string;
      if (visited.has(dir)) continue;
      visited.add(dir);
      let listed: { files?: string[]; folders?: string[] };
      try {
        listed = await adapter.list(dir);
      } catch {
        continue; // 目录读不到：跳过该层，不让还原失败
      }
      for (const path of listed.folders ?? []) {
        if (!path || visited.has(path) || this.isSkippedLocalPath(path)) continue;
        entries.push({ path, type: "folder" });
        queue.push(path);
      }
      for (const path of listed.files ?? []) {
        if (!path || this.isSkippedLocalPath(path)) continue;
        entries.push({ path, type: "file" });
      }
    }
    return entries;
  }

  /** 把一个本地条目写回 fileMap（不过滤配置目录，与 `applyVaultRawEvent` 的过滤策略不同）。 */
  private applyLocalEntry(entry: VaultTreeEntry, internalVault: InternalVault): void {
    if (entry.type === "folder") {
      this.ensureParentFoldersInVault(entry.path, internalVault);
      if (!this.app.vault.getAbstractFileByPath(entry.path)) {
        internalVault.onChange?.("folder-created", entry.path);
      }
      return;
    }
    this.ensureParentFoldersInVault(entry.path, internalVault);
    const stat = { ctime: entry.ctime ?? 0, mtime: entry.mtime ?? 0, size: entry.size ?? 0 };
    internalVault.onChange?.("raw", entry.path, entry.path, stat);
    if (!this.app.vault.getAbstractFileByPath(entry.path)) {
      internalVault.onChange?.("file-created", entry.path, entry.path, stat);
    }
  }

  /**
   * Synchronously applies a low-level adapter event (`file-created`, `folder-created`, `modified`,
   * `file-removed`, `folder-removed`, `renamed`) to Obsidian's internal `Vault.onChange`.
   *
   * Note: Must run synchronously when called from `adapter.write()` / `adapter.mkdir()` so that
   * `Vault.create()` immediately finds the newly created `TFile` in `vault.fileMap`!
   */
  public applyVaultRawEvent(evt: ObsidianVaultRawEvent): void {
    const internalVault = this.app.vault as InternalVault;
    if (typeof internalVault.onChange !== "function") return;

    const configDir = this.app.vault.configDir;
    if (evt.type === "renamed") {
      if (
        isConfigOrInternalPath(evt.newPath, configDir) ||
        isConfigOrInternalPath(evt.oldPath, configDir)
      ) {
        return;
      }
    } else if (isConfigOrInternalPath(evt.path, configDir)) {
      return;
    }

    if (evt.type === "folder-created") {
      this.ensureParentFoldersInVault(evt.path, internalVault);
      if (!this.app.vault.getAbstractFileByPath(evt.path)) {
        internalVault.onChange("folder-created", evt.path);
      }
      return;
    }

    if (evt.type === "file-created") {
      this.ensureParentFoldersInVault(evt.path, internalVault);
      internalVault.onChange("raw", evt.path, evt.path, evt.stat);
      if (!this.app.vault.getAbstractFileByPath(evt.path)) {
        internalVault.onChange("file-created", evt.path, evt.path, evt.stat);
      } else {
        void this.syncOpenViewsAndNotifyModified(evt.path, evt.stat, internalVault);
      }
      return;
    }

    if (evt.type === "modified") {
      internalVault.onChange("raw", evt.path, evt.path, evt.stat);
      if (this.app.vault.getAbstractFileByPath(evt.path)) {
        if (evt.remote) {
          void this.syncOpenViewsAndNotifyModified(evt.path, evt.stat, internalVault);
        } else {
          internalVault.onChange("modified", evt.path, evt.path, evt.stat);
        }
      } else {
        this.ensureParentFoldersInVault(evt.path, internalVault);
        internalVault.onChange("file-created", evt.path, evt.path, evt.stat);
      }
      return;
    }

    if (evt.type === "file-removed" || evt.type === "folder-removed") {
      if (this.app.vault.getAbstractFileByPath(evt.path)) {
        internalVault.onChange(evt.type, evt.path);
      }
      return;
    }

    if (evt.type === "renamed") {
      this.ensureParentFoldersInVault(evt.newPath, internalVault);
      if (this.app.vault.getAbstractFileByPath(evt.oldPath)) {
        internalVault.onChange("renamed", evt.newPath, evt.oldPath);
      }
      return;
    }
  }

  private ensureParentFoldersInVault(path: string, internalVault: InternalVault): void {
    const parentPath = getParentPath(path);
    if (!parentPath) return;

    const parts = parentPath.split("/");
    let current = "";
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.app.vault.getAbstractFileByPath(current)) {
        internalVault.onChange?.("folder-created", current);
      }
    }
  }

  /**
   * Reconciles Obsidian's `Vault.fileMap` with all entries in `mountable.cache`.
   */
  public async reconcileFullVault(mountable: VaultMountable): Promise<void> {
    const internalVault = this.app.vault as InternalVault;
    const configDir = this.app.vault.configDir;

    const entries = (mountable.cache.getAllEntries() as VaultTreeEntry[]).filter(
      (e) => !isConfigOrInternalPath(e.path, configDir)
    );
    const virtualPaths = new Set(entries.map((e) => e.path));

    // 1. Remove any stale files or accidentally-indexed config folders from Vault.fileMap
    if (internalVault.fileMap) {
      const existingPaths = Object.keys(internalVault.fileMap).filter((p) => p !== "/");
      // Sort longest paths first so children are removed before parents
      existingPaths.sort((a, b) => b.length - a.length);
      for (const path of existingPaths) {
        if (!virtualPaths.has(path) || isConfigOrInternalPath(path, configDir)) {
          const item = internalVault.fileMap[path];
          const isFolder = isFolderNode(item);
          internalVault.onChange?.(isFolder ? "folder-removed" : "file-removed", path);
        }
      }
    }

    // 2. Sort folders first by depth so parent folders are registered in Vault.fileMap before children
    const sorted = [...entries].sort((a, b) => {
      if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
      return a.path.split("/").length - b.path.split("/").length;
    });

    for (const entry of sorted) {
      if (entry.type === "folder") {
        this.applyVaultRawEvent({ type: "folder-created", path: entry.path });
      } else {
        this.applyVaultRawEvent({
          type: "file-created",
          path: entry.path,
          stat: { ctime: entry.ctime ?? 0, mtime: entry.mtime ?? 0, size: entry.size ?? 0 },
        });
      }
    }

    // 3. Re-initialize MetadataCache if needed and refresh File Explorer UI
    const internalMeta = this.app.metadataCache as InternalMetadataCache;
    try {
      internalMeta.initialize?.();
    } catch {
      // Ignore
    }

    this.refreshFileExplorerViews();
  }

  private async syncOpenViewsAndNotifyModified(
    normalizedPath: string,
    stat: { ctime: number; mtime: number; size: number },
    internalVault: InternalVault
  ): Promise<void> {
    try {
      const content = await this.app.vault.adapter.read(normalizedPath);
      const leaves = this.app.workspace.getLeavesOfType("markdown");

      for (const leaf of leaves) {
        const view = leaf.view;
        if (isMarkdownViewLike(view) && (view as { file?: { path?: string } | null }).file?.path === normalizedPath) {
          const anyView = view as MarkdownView & {
            data?: string;
            lastSavedData?: string;
            dirty?: boolean;
            requestSave?: { cancel?: () => void };
          };
          const currentViewData = view.getViewData();
          if (currentViewData !== content) {
            anyView.lastSavedData = content;
            anyView.data = content;
            anyView.dirty = false;
            view.setViewData(content, false);
            anyView.dirty = false;
            anyView.requestSave?.cancel?.();
          } else {
            anyView.lastSavedData = content;
            anyView.data = content;
          }
        }
      }
    } catch {
      // Ignore if file was deleted concurrently
    }

    internalVault.onChange?.("modified", normalizedPath, normalizedPath, stat);
  }

  private refreshFileExplorerViews(): void {
    const leaves = this.app.workspace.getLeavesOfType("file-explorer");
    for (const leaf of leaves) {
      const anyView = leaf.view as { requestSort?: () => void };
      anyView.requestSort?.();
    }
  }
}
