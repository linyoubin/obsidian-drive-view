/**
 * 0.2.32：打开夸克 App / 网页的三级回退 + 用户可粘贴 App 分享链接。
 *
 * 深链探测结论（2026-11-27 复核，证据见回执）：
 *   - **AASA 只登记了「夸克网盘」App**（`com.quark.clouddrive` 三个变体），
 *     而用户的「夸克-AI旗舰应用」App Store bundle id 是 **`com.quark.browser`**（iTunes Search API 实测），
 *     它**不在** AASA 里 → `https://pan.quark.cn/quarkcloud/*` 不会被它接管；
 *   - `pan.quark.cn/.well-known/assetlinks.json` 返回网页 HTML（无 Android App Links）；
 *     `www.quark.cn` 的 assetlinks 只有 UC 浏览器（com.UCMobile.intl / com.uc.browser.en），不含夸克；
 *   - 自定义 scheme（`quarkcloud://` 等）无任何页面/公开文档证据；
 *   - `/quarkcloud/*` 的 App 内行为（是否按 fid 定位目录）**未证实**；桌面访问该路径会跳 App Store。
 *
 * 因此：**默认模板置空**（不再硬塞一个唤不起的链接）；用户可从 App 内分享出链接，
 * 在设置页「从分享链接生成模板」粘贴，自动把 id 段替换成 `{fileFid}` / `{fid}` 占位符。
 * 打开顺序：App 深链（仅当模板非空）→ https 目录页 → 复制链接。
 */

import { buildQuarkFolderUrl } from "./QuarkOpenExternal";

/** 曾验证过的 Universal Link 前缀（只对「夸克网盘」com.quark.clouddrive 有效，默认不再使用）。 */
export const QUARK_APP_LINK_PREFIX = "https://pan.quark.cn/quarkcloud/";

/**
 * 默认深链模板：**空**。
 * 原因：用户装的「夸克-AI旗舰应用」= `com.quark.browser`，不在 pan.quark.cn 的 AASA 里，
 * 任何 pan.quark.cn 链接都不会被它接管；用错误链接只会跳浏览器/App Store。
 */
export const DEFAULT_DEEPLINK_TEMPLATE = "";

/** 打开方式：`app` = 先试深链（默认）；`browser` = 只用浏览器。 */
export type QuarkOpenMode = "app" | "browser";

/** 打开结果（对应 `stage=open-external result=...`）。 */
export type QuarkOpenTargetResult = "app" | "https" | "copied" | "failed";

/** 模板渲染上下文：`fid` = 目录 fid（parentFid），`fileFid` = 文件 fid。 */
export interface DeepLinkContext {
  fid?: string;
  fileFid?: string;
  rootFid?: string;
}

/** 渲染深链模板：替换 `{fid}` / `{fileFid}` / `{rootFid}`（URL 编码），空模板返回 `""`。 */
export function renderDeepLinkTemplate(template: string, info: DeepLinkContext = {}): string {
  const raw = String(template ?? "").trim();
  if (!raw) return "";
  const rootFid = String(info.rootFid ?? "").trim() || "0";
  const fid = String(info.fid ?? "").trim() || rootFid;
  const fileFid = String(info.fileFid ?? "").trim();
  return raw
    .replace(/\{fid\}/g, encodeURIComponent(fid))
    .replace(/\{fileFid\}/g, encodeURIComponent(fileFid))
    .replace(/\{rootFid\}/g, encodeURIComponent(rootFid));
}

export interface QuarkOpenTargetHost {
  /** 0.2.31：App 优先 / 只用浏览器。 */
  mode: QuarkOpenMode;
  /** 深链模板（含占位符）。 */
  template: string;
  /**
   * 0.2.32：模板来源（用户是否粘贴过 App 分享链接）——用于日志
   * `stage=open-external state=template-source=<default|user>`。
   */
  templateSource?: "default" | "user";
  /** 交给系统打开（electron.shell.openExternal / window.open）；返回是否成功发起。 */
  openUrl(url: string): boolean | Promise<boolean>;
  /** 打开失败时复制链接。 */
  copyLink(url: string): boolean | Promise<boolean>;
  /** 结果回调（main 转成 `stage=open-external result=...`）。 */
  log(entry: {
    path: string;
    fid: string;
    url: string;
    result: QuarkOpenTargetResult;
    templateSource?: "default" | "user";
  }): void;
}

/** 是否为「像 id 的路径段」（32 位 hex / 分享码等）。 */
function looksLikeId(segment: string): boolean {
  return /^[A-Za-z0-9_-]{6,64}$/.test(segment) && !/^(list|all|s|quarkcloud)$/i.test(segment);
}

/**
 * 0.2.32：把「App 内分享出来的链接」转换成深链模板（把 id 段换成占位符）。
 *
 * 支持：
 *   - `https://pan.quark.cn/s/<code>` → `https://pan.quark.cn/s/{fileFid}`
 *   - `https://pan.quark.cn/quarkcloud/<id>` → `https://pan.quark.cn/quarkcloud/{fileFid}`
 *   - `https://pan.quark.cn/list#/list/all/<fid>` → `https://pan.quark.cn/list#/list/all/{fid}`
 *   - 已含 `{fid}` / `{fileFid}` 的模板原样返回
 * 无法识别返回 `""`（设置页提示用户换一条链接）。
 */
export function templateFromShareLink(link: string): string {
  const raw = String(link ?? "").trim();
  if (!raw) return "";
  if (/\{fid\}|\{fileFid\}/.test(raw)) return raw;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return "";
  }
  if (url.hostname !== "pan.quark.cn") return "";
  const origin = "https://pan.quark.cn";

  // 分享链接：/s/<code>
  const shareMatch = /^\/s\/([^/]+)\/?$/.exec(url.pathname);
  if (shareMatch && looksLikeId(shareMatch[1])) {
    return `${origin}/s/{fileFid}`;
  }

  // Universal Link 路径：/quarkcloud/<id>
  if (url.pathname.startsWith("/quarkcloud/")) {
    const last = url.pathname.split("/").filter(Boolean).pop() ?? "";
    if (looksLikeId(last)) return `${origin}/quarkcloud/{fileFid}`;
    return "";
  }

  // 网页目录：/list#/list/all/<fid>
  const hashMatch = /^#\/list\/all\/([^/?#]+)/.exec(url.hash);
  if (hashMatch && looksLikeId(hashMatch[1])) {
    return `${origin}/list#/list/all/{fid}`;
  }

  // 普通 /list/all/<fid>（无 hash）也接受
  if (url.pathname === "/list/all" || url.pathname.startsWith("/list/all/")) {
    return `${origin}/list#/list/all/{fid}`;
  }
  return "";
}

/**
 * 创建打开链：App 深链（模板）→ https 目录页 → 复制链接。
 *
 * 返回最终结果：`app` / `https` / `copied` / `failed`。
 * `mode="browser"` 时跳过 App 深链，直接 https。
 */
export function createQuarkOpenTarget(
  host: QuarkOpenTargetHost
): (info: { path: string; fid?: string; fileFid?: string; parentFid?: string; rootFid?: string }) => Promise<QuarkOpenTargetResult> {
  const log = (path: string, fid: string, url: string, result: QuarkOpenTargetResult): void => {
    try {
      host.log({ path, fid, url, result, templateSource: host.templateSource });
    } catch {
      /* 日志失败不影响打开 */
    }
  };

  return async (info) => {
    const clean = String(info.path ?? "");
    const fid = String(info.fid ?? "");
    const folderUrl = buildQuarkFolderUrl(info.parentFid ?? "", info.rootFid ?? "0");

    // 0.2.32：模板为空（默认）→ 不尝试 App 深链，直接 https（不再硬塞错误链接）
    if (host.mode === "app" && String(host.template ?? "").trim()) {
      const appUrl = renderDeepLinkTemplate(host.template, {
        fid: info.parentFid,
        fileFid: info.fileFid,
        rootFid: info.rootFid,
      });
      if (appUrl) {
        let opened = false;
        try {
          opened = (await host.openUrl(appUrl)) === true;
        } catch {
          opened = false;
        }
        if (opened) {
          log(clean, fid, appUrl, "app");
          return "app";
        }
      }
    }

    let httpsOpened = false;
    try {
      httpsOpened = (await host.openUrl(folderUrl)) === true;
    } catch {
      httpsOpened = false;
    }
    if (httpsOpened) {
      log(clean, fid, folderUrl, "https");
      return "https";
    }

    let copied = false;
    try {
      copied = (await host.copyLink(folderUrl)) === true;
    } catch {
      copied = false;
    }
    if (copied) {
      log(clean, fid, folderUrl, "copied");
      return "copied";
    }
    log(clean, fid, folderUrl, "failed");
    return "failed";
  };
}
