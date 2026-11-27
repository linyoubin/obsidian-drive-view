/**
 * 0.2.31：打开夸克 App / 网页的三级回退。
 *
 * 深链探测结论（2026-11-27，证据见回执）：
 *   - **iOS Universal Link 已证实**：`https://pan.quark.cn/.well-known/apple-app-site-association`
 *     返回 appID `6TFXDT6MK5.com.quark.clouddrive`（等三个）且 `paths: ["/quarkcloud/*"]`
 *     → `https://pan.quark.cn/quarkcloud/<...>` 在装了夸克的 iOS 上会被 App 接管；
 *   - **Android App Links 未配置**：`pan.quark.cn/.well-known/assetlinks.json` 返回的是网页 HTML（无配置）
 *     → 安卓上 https 链接不会自动进 App；
 *   - **自定义 scheme 无法证实**：页面/JS 里搜不到 `quarkcloud://`，公开检索也无官方文档；
 *     UC 工具包里的 `"com.quark.clouddrive":"quarkcloud"` 是 UC 唤端服务的路径段，不是 scheme。
 *
 * 因此默认模板用已证实的 Universal Link 前缀 `https://pan.quark.cn/quarkcloud/{fid}`；
 * 子路径语义（App 是否按 fid 定位目录）无法离线证实，模板可被用户改成自己实测有效的链接
 * （支持 `{fid}` / `{fileFid}` / `{rootFid}` 占位符）。
 */

import { buildQuarkFolderUrl } from "./QuarkOpenExternal";

/** 已证实的 Universal Link 前缀（AASA: paths=["/quarkcloud/*"]）。 */
export const QUARK_APP_LINK_PREFIX = "https://pan.quark.cn/quarkcloud/";

/** 默认深链模板：优先 App（iOS Universal Link），带 `{fid}` 占位符。 */
export const DEFAULT_DEEPLINK_TEMPLATE = `${QUARK_APP_LINK_PREFIX}{fid}`;

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
  /** 交给系统打开（electron.shell.openExternal / window.open）；返回是否成功发起。 */
  openUrl(url: string): boolean | Promise<boolean>;
  /** 打开失败时复制链接。 */
  copyLink(url: string): boolean | Promise<boolean>;
  /** 结果回调（main 转成 `stage=open-external result=...`）。 */
  log(entry: { path: string; fid: string; url: string; result: QuarkOpenTargetResult }): void;
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
      host.log({ path, fid, url, result });
    } catch {
      /* 日志失败不影响打开 */
    }
  };

  return async (info) => {
    const clean = String(info.path ?? "");
    const fid = String(info.fid ?? "");
    const folderUrl = buildQuarkFolderUrl(info.parentFid ?? "", info.rootFid ?? "0");

    if (host.mode === "app") {
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
