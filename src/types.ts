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
   * 夸克根目录 fid（一期固定 `"0"`）。
   */
  quarkRootFid: string;
  /**
   * 最近一次索引建立的毫秒时间戳（0 = 从未建立）。
   */
  quarkLastIndexBuiltAt: number;
}

export const DEFAULT_QUARK_SETTINGS: QuarkSettings = {
  quarkCookie: "",
  quarkRootFid: "0",
  quarkLastIndexBuiltAt: 0,
};

/** CookieStore 在 `data.json` 里使用的键名（与插件设置同文件）。 */
export const QUARK_COOKIE_STORAGE_KEY = "quarkCookie";

/** 本插件完整设置：Google Drive 那套 + 夸克那套。 */
export type PluginSettings = GoogleDriveSettings & QuarkSettings;
