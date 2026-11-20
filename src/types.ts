export type SyncState =
  | "disconnected"
  | "authenticating"
  | "indexing"
  | "synced"
  | "syncing"
  | "offline"
  | "error";

export interface GoogleDriveSettings {
  /**
   * OAuth 2.0 Access Token
   */
  accessToken: string;
  /**
   * OAuth 2.0 Refresh Token
   */
  refreshToken: string;
  /**
   * Expiration timestamp in ms
   */
  tokenExpiresAt: number;
  /**
   * Google Drive Folder ID acting as the root of this vault
   */
  rootFolderId: string;
  /**
   * Name of the root folder in Google Drive
   */
  rootFolderName: string;
  /**
   * Whether the Google Drive DataAdapter is actively mounted as the vault backend
   */
  adapterEnabled: boolean;
  /**
   * Debounce time (ms) before uploading local edits to Google Drive
   */
  writeDebounceMs: number;
  /**
   * Interval (seconds) for polling Google Drive changes.list
   */
  pollIntervalSec: number;
  /**
   * Whether to prefetch binary attachments to create instant blob: URLs for getResourcePath
   */
  prefetchBinaries: boolean;
  /**
   * Max file size (in MB) to prefetch automatically for blob URLs
   */
  maxPrefetchBinarySizeMB: number;
  /**
   * Whether to sync the `.obsidian` configuration and plugins directory with Google Drive
   */
  syncConfigDir: boolean;
  /**
   * Whether to use user-supplied Google OAuth Client ID and Secret (for full Drive & shared folder access)
   */
  useCustomCredentials: boolean;
  /**
   * User-supplied Google OAuth 2.0 Web Client ID
   */
  customClientId: string;
  /**
   * User-supplied Google OAuth 2.0 Web Client Secret
   */
  customClientSecret: string;
}

export const DEFAULT_SETTINGS: GoogleDriveSettings = {
  accessToken: "",
  refreshToken: "",
  tokenExpiresAt: 0,
  rootFolderId: "",
  rootFolderName: "ObsidianDriveVault",
  adapterEnabled: true,
  writeDebounceMs: 2500,
  pollIntervalSec: 30,
  prefetchBinaries: true,
  maxPrefetchBinarySizeMB: 25,
  syncConfigDir: false,
  useCustomCredentials: false,
  customClientId: "",
  customClientSecret: "",
};

export interface VirtualEntry {
  /**
   * Normalized vault-relative path (e.g. "Folder/Note.md" or "Folder")
   */
  path: string;
  /**
   * Base file or folder name (e.g. "Note.md")
   */
  name: string;
  /**
   * Entry type
   */
  type: "file" | "folder";
  /**
   * Creation timestamp (ms)
   */
  ctime: number;
  /**
   * Last modification timestamp (ms)
   */
  mtime: number;
  /**
   * Byte size for files, 0 for folders
   */
  size: number;
  /**
   * Google Drive file/folder ID
   */
  driveId?: string;
  /**
   * Google Drive parent folder ID
   */
  parentId?: string;
  /**
   * MD5 checksum from Google Drive (for binary/non-Google-Doc files)
   */
  md5Checksum?: string;
  /**
   * MIME type on Google Drive
   */
  mimeType?: string;
  /**
   * Whether this entry has local modifications pending upload to Google Drive
   */
  dirty?: boolean;
  /**
   * Whether the file's full content is currently cached in IndexedDB/memory
   */
  contentCached?: boolean;
}

export interface DriveFileMetadata {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  createdTime?: string;
  modifiedTime?: string;
  size?: string;
  md5Checksum?: string;
  trashed?: boolean;
}

export interface DriveChangeItem {
  fileId: string;
  removed?: boolean;
  file?: DriveFileMetadata;
}

/**
 * 夸克一期：只读库设置（与 Google Drive 共用同一个 `data.json`）。
 * 字段名带 `quark` 前缀，避免和 Drive 的设置冲突。
 */
export interface QuarkSettings {
  /**
   * 登录态 Cookie 字符串（`k=v; k2=v2`）。运行期 `secretStorage` 可用时优先存那里，这里是回退。
   */
  quarkCookie: string;
  /**
   * 库根目录的夸克 fid（默认 `"0"` = 整个网盘根；用户选了目录则是那个目录的 fid）。
   */
  quarkRootFid: string;
  /**
   * 库根目录的展示路径，如 `/知识库_云端`（默认 `"/"`）。
   */
  quarkRootPath: string;
  /**
   * 用户最近一次选择库根的时间戳（0 = 从未选过）。ribbon 首次点击据此先弹目录选择器。
   */
  quarkRootChosenAt: number;
  /**
   * 最近一次索引建立的毫秒时间戳（0 = 从未建立）。
   */
  quarkLastIndexBuiltAt: number;
  /**
   * 下载并发上限（1–3，默认 2；真机并发风暴后加，0.2.4）。
   */
  quarkDownloadConcurrency: number;
  /**
   * 大文件**提醒阈值**（字节，默认 50 MB，0 = 不提醒）；**仅影响提示文案，不拦截下载**（0.2.4 A6′）。
   */
  quarkMaxFileBytes: number;
}

export const DEFAULT_QUARK_SETTINGS: QuarkSettings = {
  quarkCookie: "",
  quarkRootFid: "0",
  quarkRootPath: "/",
  quarkRootChosenAt: 0,
  quarkLastIndexBuiltAt: 0,
  quarkDownloadConcurrency: 2,
  quarkMaxFileBytes: 50 * 1024 * 1024,
};

/** CookieStore 在 `data.json` 里使用的键名（与插件设置同文件）。 */
export const QUARK_COOKIE_STORAGE_KEY = "quarkCookie";

/** 本插件完整设置：Google Drive 那套 + 夸克那套。 */
export type PluginSettings = GoogleDriveSettings & QuarkSettings;
