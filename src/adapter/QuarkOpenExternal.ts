/**
 * 0.2.29/0.2.30：所有非 md 文件统一「点击跳夸克」。
 *
 * 背景（用户实测 0.2.28）：图片/PDF 的「框架」在，但内容始终空白；PDF 需要本地 `app://`
 * 路径，虚拟库给不了。0.2.30 起：
 *   - **图片恢复 Obsidian 内渲染**（0.2.30 修占位/换 URL/mtime，见 QuarkReadOnlyAdapter）；
 *   - **PDF 仍走「确认 → 打开夸克所在目录」**；
 *   - Office/压缩包/音视频等仍走「确认 → 打开夸克」；
 *   - 开关拆两个：「Office/压缩包/音视频」与「PDF」，默认都开。
 *
 * URL 实测（2026-11-26，官方网页版）：
 *   - `https://pan.quark.cn/list#/list/all/<folderFid>` 能进入该目录（rootFid 实测有效）；
 *   - `#/list/all/<folderFid>/<fileFid>` 与 `?fid=<fileFid>` 均无效 → 退一步打开所在目录。
 *
 * 本模块不 import `obsidian`（UI/剪贴板由 main 注入），可直接单测。
 */

import { normalizeVaultPath } from "../utils/pathUtils";

/** PDF（「PDF：点击跳夸克」开关）。0.2.30 起图片恢复 Obsidian 内渲染，不再跳转。 */
export const QUARK_UNPREVIEWABLE_MEDIA_EXTENSIONS: readonly string[] = ["pdf"];

/**
 * Office / 压缩包 / 音视频 / 电子书 / 安装包（原开关「Office/压缩包/音视频：点击跳夸克」）。
 * 注意：csv 也列入（Obsidian 只当纯文本，表格能力差），按产品要求走夸克。
 */
export const QUARK_UNPREVIEWABLE_OTHER_EXTENSIONS: readonly string[] = [
  // Office / 文档
  "doc",
  "docx",
  "xls",
  "xlsx",
  "ppt",
  "pptx",
  "pps",
  "ppsx",
  "odt",
  "ods",
  "odp",
  "rtf",
  "csv",
  // 压缩包 / 镜像
  "zip",
  "rar",
  "7z",
  "tar",
  "gz",
  "bz2",
  "xz",
  "iso",
  // 音视频
  "mp3",
  "mp4",
  "mov",
  "m4a",
  "m4v",
  "wav",
  "ogg",
  "webm",
  "mkv",
  "flac",
  "avi",
  "wmv",
  // 电子书
  "epub",
  "mobi",
  "azw",
  "azw3",
  "fb2",
  "djvu",
  // 设计 / 工程
  "psd",
  "ai",
  "indd",
  "sketch",
  "fig",
  "xd",
  "cdr",
  "dwg",
  "vsd",
  "vsdx",
  // Apple / Office 专有
  "pages",
  "numbers",
  "key",
  "one",
  "mpp",
  // 安装包 / 数据库 / 其它二进制
  "apk",
  "ipa",
  "exe",
  "msi",
  "dmg",
  "pkg",
  "deb",
  "rpm",
  "sqlite",
  "db",
  "dat",
  "bin",
  "torrent",
];

/** 全部不可预览扩展名（两个开关的并集；md/canvas/base 永不在内）。 */
export const QUARK_UNPREVIEWABLE_EXTENSIONS: readonly string[] = Array.from(
  new Set([...QUARK_UNPREVIEWABLE_MEDIA_EXTENSIONS, ...QUARK_UNPREVIEWABLE_OTHER_EXTENSIONS])
);

/** 不可预览文件的类别（决定用哪个设置开关）。 */
export type QuarkUnpreviewableCategory = "media" | "other";

/** 取小写扩展名（无扩展名 → `""`）。 */
export function quarkExtensionOf(path: string): string {
  const clean = normalizeVaultPath(path ?? "");
  const slash = clean.lastIndexOf("/");
  const name = slash >= 0 ? clean.slice(slash + 1) : clean;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/** 类别判定：`media` = 图片/PDF；`other` = Office/压缩包/音视频等；`null` = 可预览（md 等）。 */
export function quarkUnpreviewableCategory(path: string): QuarkUnpreviewableCategory | null {
  const extension = quarkExtensionOf(path);
  if (!extension) return null;
  if (QUARK_UNPREVIEWABLE_MEDIA_EXTENSIONS.includes(extension)) return "media";
  if (QUARK_UNPREVIEWABLE_OTHER_EXTENSIONS.includes(extension)) return "other";
  return null;
}

/** 是否是「Obsidian 不能预览、建议去夸克打开」的文件（任一类别）。 */
export function isQuarkUnpreviewable(path: string): boolean {
  return quarkUnpreviewableCategory(path) !== null;
}

/** 目录级网页地址前缀（实测能进入指定目录）。 */
export const QUARK_FOLDER_URL_PREFIX = "https://pan.quark.cn/list#/list/all/";

/**
 * 拼「所在目录」的夸克网页地址。
 *
 * `parentFid` 来自索引条目的 `parentFid`（列目录时记录的父目录 fid）；
 * 为空时回落到 `rootFid`（库根），再回落到 `"0"`（账号根目录）。
 */
export function buildQuarkFolderUrl(parentFid: string, rootFid: string = "0"): string {
  const fid = String(parentFid ?? "").trim() || String(rootFid ?? "").trim() || "0";
  return `${QUARK_FOLDER_URL_PREFIX}${encodeURIComponent(fid)}`;
}

/** 一次「去夸克打开」的结果（用于日志/单测）。 */
export type UnpreviewableOpenResult =
  | "app"
  | "https"
  | "copied"
  | "failed"
  | "cancelled"
  | "disabled"
  | "throttled"
  | "not-unpreviewable";

/** 流程宿主（main 注入 UI / 打开链 / 日志）。 */
export interface UnpreviewableHost {
  /** 按类别读取设置开关（media = PDF；other = Office/压缩包/音视频）。 */
  isEnabled(category: QuarkUnpreviewableCategory): boolean;
  /** 确认弹窗（Modal 或 Notice 按钮）；true = 去夸克打开。 */
  confirm(info: { path: string; extension: string; url: string }): boolean | Promise<boolean>;
  /**
   * 0.2.31：打开链（App 深链 → https → 复制），实现见 `QuarkDeepLink.createQuarkOpenTarget`。
   * 返回最终结果，供日志记录 `result=app|https|copied|failed`。
   */
  openTarget(info: {
    path: string;
    fid: string;
    fileFid: string;
    parentFid: string;
    rootFid?: string;
  }): Promise<"app" | "https" | "copied" | "failed">;
  /** 诊断日志（`stage=open-external`，URL 已打码为域名 + 长度）。 */
  log(entry: {
    path: string;
    fid: string;
    domain: string;
    length: number;
    result: UnpreviewableOpenResult;
  }): void;
  /** 时间源（单测注入），默认 `Date.now`。 */
  now?: () => number;
  /** 同 path 去重窗口（默认 30s）。 */
  windowMs?: number;
}

/** URL 打码：只保留域名 + 总长度（不记 fid/完整路径，避免日志泄漏库结构）。 */
function describeUrl(url: string): { domain: string; length: number } {
  let domain = "pan.quark.cn";
  try {
    const parsed = new URL(url);
    domain = parsed.hostname;
  } catch {
    /* 非常规 URL：保留默认域名 */
  }
  return { domain, length: url.length };
}

/**
 * 创建「不可预览文件 → 去夸克打开」流程。
 *
 * 语义：
 *   - 可预览扩展名（md 等）→ `not-unpreviewable`（不弹、不记日志）；
 *   - 对应类别开关关闭 → `disabled`（不弹、不打开，只记日志）；
 *   - 同 path 30s 内重复点击 → `throttled`（不弹、不打开）；
 *   - 用户取消 → `cancelled`；
 *   - 打开成功 → `opened`；打开不可用但复制成功 → `copied`；都失败 → `failed`。
 */
export function createUnpreviewableOpenFlow(
  host: UnpreviewableHost
): (info: {
  path: string;
  fid?: string;
  parentFid?: string;
  /** 0.2.31：文件自身 fid（深链模板可用 `{fileFid}`）。 */
  fileFid?: string;
  /** 0.2.31：库根 fid（parentFid 为空时回落）。 */
  rootFid?: string;
}) => Promise<UnpreviewableOpenResult> {
  const now = host.now ?? ((): number => Date.now());
  const windowMs = Math.max(0, host.windowMs ?? 30_000);
  const lastAt = new Map<string, number>();

  const writeLog = (
    path: string,
    fid: string,
    url: string,
    result: UnpreviewableOpenResult
  ): void => {
    try {
      host.log({ path, fid, ...describeUrl(url), result });
    } catch {
      /* 日志失败不影响打开流程 */
    }
  };

  return async (info) => {
    const clean = normalizeVaultPath(info.path ?? "");
    const category = quarkUnpreviewableCategory(clean);
    if (!category) return "not-unpreviewable";
    const fid = String(info.fid ?? "");
    const url = buildQuarkFolderUrl(info.parentFid ?? "");

    if (!host.isEnabled(category)) {
      writeLog(clean, fid, url, "disabled");
      return "disabled";
    }

    const at = now();
    const previous = lastAt.get(clean);
    if (previous !== undefined && at - previous < windowMs) return "throttled";
    lastAt.set(clean, at);

    let confirmed = false;
    try {
      confirmed = (await host.confirm({ path: clean, extension: quarkExtensionOf(clean), url })) === true;
    } catch {
      confirmed = false;
    }
    if (!confirmed) {
      writeLog(clean, fid, url, "cancelled");
      return "cancelled";
    }

    // 0.2.31：App 深链 → https → 复制（三级回退在 openTarget 内实现并记 result）
    let result: "app" | "https" | "copied" | "failed" = "failed";
    try {
      result = await host.openTarget({
        path: clean,
        fid,
        fileFid: String(info.fileFid ?? ""),
        parentFid: String(info.parentFid ?? ""),
        rootFid: info.rootFid,
      });
    } catch {
      result = "failed";
    }
    writeLog(clean, fid, url, result);
    return result;
  };
}
