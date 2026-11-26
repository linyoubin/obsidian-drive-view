/**
 * 0.2.28：Obsidian 不能原生预览的文件（docx/xlsx/zip/epub…）—— 点击时提示「去夸克打开」。
 *
 * 为什么只给目录级 URL（实测依据，2026-11-26，`browser` 打开官方网页版）：
 *   - `https://pan.quark.cn/list#/list/all/<folderFid>` → 能进入该目录
 *     （用调试库 rootFid `4e5cda2d01544632b54129bf61c22abb` 实测：显示 `.obsidian / 20-notes / 10-sources …`；
 *      用 `0` 实测显示账号根目录「我的备份 / 个人空间 / 来自：分享 …」）；
 *   - `https://pan.quark.cn/list#/list/all/<folderFid>/<fileFid>` → 空目录视图（该路由段被当作目录，非文件）；
 *   - `https://pan.quark.cn/list#/list/all/<folderFid>?fid=<fileFid>` → 只显示目录列表，query 被忽略。
 * 因此采用「打开所在目录」：`buildQuarkFolderUrl(parentFid)`。
 *
 * 本模块不 import `obsidian`（UI/剪贴板由 main 注入），可直接单测。
 */

import { normalizeVaultPath } from "../utils/pathUtils";

/**
 * Obsidian 不能原生预览的扩展名（弹「在夸克打开」确认）。
 * 注意：csv 也列入（Obsidian 只当纯文本展示，编辑/表格能力差），按产品要求走夸克。
 */
export const QUARK_UNPREVIEWABLE_EXTENSIONS: readonly string[] = [
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

/** 取小写扩展名（无扩展名 → `""`）。 */
export function quarkExtensionOf(path: string): string {
  const clean = normalizeVaultPath(path ?? "");
  const slash = clean.lastIndexOf("/");
  const name = slash >= 0 ? clean.slice(slash + 1) : clean;
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot === name.length - 1) return "";
  return name.slice(dot + 1).toLowerCase();
}

/** 是否是「Obsidian 不能预览、建议去夸克打开」的文件。 */
export function isQuarkUnpreviewable(path: string): boolean {
  const extension = quarkExtensionOf(path);
  return extension !== "" && QUARK_UNPREVIEWABLE_EXTENSIONS.includes(extension);
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
  | "opened"
  | "copied"
  | "failed"
  | "cancelled"
  | "disabled"
  | "throttled"
  | "not-unpreviewable";

/** 流程宿主（main 注入 UI / 外部打开 / 剪贴板 / 日志）。 */
export interface UnpreviewableHost {
  /** 设置项「Docx/Office 等不可预览文件：点击时跳夸克打开」（默认开）。 */
  isEnabled(): boolean;
  /** 确认弹窗（Modal 或 Notice 按钮）；true = 去夸克打开。 */
  confirm(info: { path: string; extension: string; url: string }): boolean | Promise<boolean>;
  /** 优先桌面 `electron.shell.openExternal`，其次 `window.open`；返回是否成功。 */
  openExternal(url: string): boolean | Promise<boolean>;
  /** 打开失败时复制链接；返回是否成功。 */
  copyLink(url: string): boolean | Promise<boolean>;
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
 *   - 非不可预览扩展名 → `not-unpreviewable`（不弹、不记日志）；
 *   - 设置关闭 → `disabled`（不弹、不打开，只记日志）；
 *   - 同 path 30s 内重复点击 → `throttled`（不弹、不打开）；
 *   - 用户取消 → `cancelled`；
 *   - 打开成功 → `opened`；打开不可用但复制成功 → `copied`；都失败 → `failed`。
 */
export function createUnpreviewableOpenFlow(
  host: UnpreviewableHost
): (info: { path: string; fid?: string; parentFid?: string }) => Promise<UnpreviewableOpenResult> {
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
    if (!isQuarkUnpreviewable(clean)) return "not-unpreviewable";
    const fid = String(info.fid ?? "");
    const url = buildQuarkFolderUrl(info.parentFid ?? "");

    if (!host.isEnabled()) {
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

    let opened = false;
    try {
      opened = (await host.openExternal(url)) === true;
    } catch {
      opened = false;
    }
    if (opened) {
      writeLog(clean, fid, url, "opened");
      return "opened";
    }

    let copied = false;
    try {
      copied = (await host.copyLink(url)) === true;
    } catch {
      copied = false;
    }
    if (copied) {
      writeLog(clean, fid, url, "copied");
      return "copied";
    }
    writeLog(clean, fid, url, "failed");
    return "failed";
  };
}
