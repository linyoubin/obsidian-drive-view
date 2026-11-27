/**
 * 0.2.31：打开夸克 App 的三级回退（App 深链 → https → 复制）。
 *
 * 证据（详见回执）：
 *   - iOS Universal Link 已证实：`pan.quark.cn/.well-known/apple-app-site-association`
 *     → appID `6TFXDT6MK5.com.quark.clouddrive`，paths `["/quarkcloud/*"]`；
 *   - Android App Links 未配置（assetlinks.json 返回网页 HTML）；
 *   - 自定义 scheme（quarkcloud:// 等）无任何公开/页面证据 → 默认模板用 UL 前缀，可编辑。
 */

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_DEEPLINK_TEMPLATE,
  createQuarkOpenTarget,
  renderDeepLinkTemplate,
  templateFromShareLink,
} from "../src/adapter/QuarkDeepLink";

interface LogEntry {
  path: string;
  fid: string;
  url: string;
  result: string;
  templateSource?: string;
}

/** 0.2.32：显式模板（默认模板已置空，App 用例需自带模板）。 */
const APP_TEMPLATE = "https://pan.quark.cn/quarkcloud/{fid}";

function makeHost(
  options: {
    mode?: "app" | "browser";
    template?: string;
    openResults?: boolean[];
    copyResult?: boolean;
  } = {}
) {
  const opened: string[] = [];
  const copied: string[] = [];
  const logs: LogEntry[] = [];
  let openIndex = 0;
  const openResults = options.openResults ?? [true];
  const template = options.template ?? APP_TEMPLATE;
  const host = {
    mode: options.mode ?? "app",
    template,
    templateSource: template.trim() ? ("user" as const) : ("default" as const),
    openUrl: async (url: string) => {
      opened.push(url);
      const result = openResults[openIndex] ?? false;
      openIndex += 1;
      return result;
    },
    copyLink: async (url: string) => {
      copied.push(url);
      return options.copyResult ?? true;
    },
    log: (entry: LogEntry) => logs.push(entry),
  };
  return { host, opened, copied, logs };
}

describe("0.2.31 深链模板渲染", () => {
  test("模板含 {fid} → 渲染成实际目录 fid；{fileFid} 单独可用", () => {
    const template = "https://pan.quark.cn/quarkcloud/{fid}?file={fileFid}";
    const rendered = renderDeepLinkTemplate(template, {
      fid: "4e5cda2d01544632b54129bf61c22abb",
      fileFid: "7f941f87972c4dca9732e5272084080d",
    });
    expect(rendered).toBe(
      "https://pan.quark.cn/quarkcloud/4e5cda2d01544632b54129bf61c22abb?file=7f941f87972c4dca9732e5272084080d"
    );
    // 目录 fid 与文件 fid 各一例
    expect(renderDeepLinkTemplate(APP_TEMPLATE, { fid: "dir-fid" })).toBe(
      "https://pan.quark.cn/quarkcloud/dir-fid"
    );
    expect(renderDeepLinkTemplate("myapp://open?file={fileFid}", { fileFid: "file-fid" })).toBe(
      "myapp://open?file=file-fid"
    );
    // 0.2.32：默认模板为空（夸克-AI旗舰应用不在 AASA 名单里）
    expect(DEFAULT_DEEPLINK_TEMPLATE).toBe("");
    expect(renderDeepLinkTemplate(DEFAULT_DEEPLINK_TEMPLATE, { fid: "x" })).toBe("");
    // 空模板 / 无 fid 回落 rootFid → "0"
    expect(renderDeepLinkTemplate("", { fid: "x" })).toBe("");
    expect(renderDeepLinkTemplate(APP_TEMPLATE, {})).toBe(
      "https://pan.quark.cn/quarkcloud/0"
    );
  });

  test("0.2.32 从 App 分享链接生成模板：id 段替换为 {fileFid}/{fid}", () => {
    expect(templateFromShareLink("https://pan.quark.cn/s/abc123def")).toBe(
      "https://pan.quark.cn/s/{fileFid}"
    );
    expect(templateFromShareLink("pan.quark.cn/s/AbC-123_x")).toBe(
      "https://pan.quark.cn/s/{fileFid}"
    );
    expect(templateFromShareLink("https://pan.quark.cn/quarkcloud/4e5cda2d01544632b54129bf61c22abb")).toBe(
      "https://pan.quark.cn/quarkcloud/{fileFid}"
    );
    expect(
      templateFromShareLink("https://pan.quark.cn/list#/list/all/4e5cda2d01544632b54129bf61c22abb")
    ).toBe("https://pan.quark.cn/list#/list/all/{fid}");
    // 已是模板 / 无法识别
    expect(templateFromShareLink("https://pan.quark.cn/s/{fileFid}")).toBe(
      "https://pan.quark.cn/s/{fileFid}"
    );
    expect(templateFromShareLink("https://example.com/s/abc")).toBe("");
    expect(templateFromShareLink("")).toBe("");
  });

  test("0.2.32 模板为空（默认）→ 不尝试深链，直接 https，日志记 template-source=default", async () => {
    const { host, opened, logs } = makeHost({ mode: "app", template: "" });
    const target = createQuarkOpenTarget(host);

    const result = await target({ path: "docs/a.pdf", fid: "file-fid", parentFid: "dir-fid" });

    expect(result).toBe("https");
    expect(opened).toEqual(["https://pan.quark.cn/list#/list/all/dir-fid"]); // 没有 quarkcloud 尝试
    expect(logs[0]).toMatchObject({ result: "https", templateSource: "default" });
  });

  test("0.2.32 用户模板 → 日志 template-source=user", async () => {
    const { host, logs } = makeHost({ mode: "app", template: APP_TEMPLATE });
    await createQuarkOpenTarget(host)({ path: "a.docx", fid: "f", parentFid: "dir" });
    expect(logs[0]).toMatchObject({ result: "app", templateSource: "user" });
  });
});

describe("0.2.31 三级回退", () => {
  test("App 优先：深链打开成功 → result=app，只开一次", async () => {
    const { host, opened, logs } = makeHost({ mode: "app" });
    const target = createQuarkOpenTarget(host);

    const result = await target({ path: "docs/a.docx", fid: "file-fid", parentFid: "dir-fid" });

    expect(result).toBe("app");
    expect(opened).toEqual(["https://pan.quark.cn/quarkcloud/dir-fid"]);
    expect(logs[0]).toMatchObject({ result: "app", fid: "file-fid" });
  });

  test("只用浏览器：不尝试深链，直接 https 目录页 → result=https", async () => {
    const { host, opened, logs } = makeHost({ mode: "browser" });
    const target = createQuarkOpenTarget(host);

    const result = await target({ path: "docs/a.pdf", fid: "file-fid", parentFid: "dir-fid" });

    expect(result).toBe("https");
    expect(opened).toEqual(["https://pan.quark.cn/list#/list/all/dir-fid"]);
    expect(logs[0].result).toBe("https");
  });

  test("深链抛错 → 回落 https；https 抛错 → 复制链接；都失败 → failed", async () => {
    // 深链抛错（openUrl 第一次抛）
    const thrown = makeHost({ mode: "app" });
    const throwingHost = {
      ...thrown.host,
      openUrl: async (url: string) => {
        if (url.includes("/quarkcloud/")) throw new Error("no app");
        thrown.opened.push(url);
        return true;
      },
    };
    await expect(createQuarkOpenTarget(throwingHost)({ path: "a.docx", fid: "f", parentFid: "dir" })).resolves.toBe(
      "https"
    );

    // https 失败 → copied
    const copyHost = makeHost({ mode: "browser", openResults: [false], copyResult: true });
    const copied = await createQuarkOpenTarget(copyHost.host)({ path: "a.docx", fid: "f", parentFid: "dir" });
    expect(copied).toBe("copied");
    expect(copyHost.copied).toEqual(["https://pan.quark.cn/list#/list/all/dir"]);

    // 都失败 → failed
    const failHost = makeHost({ mode: "browser", openResults: [false], copyResult: false });
    const failed = await createQuarkOpenTarget(failHost.host)({ path: "a.docx", fid: "f", parentFid: "dir" });
    expect(failed).toBe("failed");
    expect(failHost.logs[0].result).toBe("failed");
  });

  test("日志 result 四种各一例（app / https / copied / failed）", async () => {
    const app = makeHost({ mode: "app" });
    await createQuarkOpenTarget(app.host)({ path: "a", fid: "f", parentFid: "dir" });
    const https = makeHost({ mode: "browser" });
    await createQuarkOpenTarget(https.host)({ path: "a", fid: "f", parentFid: "dir" });
    const copied = makeHost({ mode: "browser", openResults: [false], copyResult: true });
    await createQuarkOpenTarget(copied.host)({ path: "a", fid: "f", parentFid: "dir" });
    const failed = makeHost({ mode: "browser", openResults: [false], copyResult: false });
    await createQuarkOpenTarget(failed.host)({ path: "a", fid: "f", parentFid: "dir" });

    expect([app.logs[0].result, https.logs[0].result, copied.logs[0].result, failed.logs[0].result]).toEqual([
      "app",
      "https",
      "copied",
      "failed",
    ]);
  });
});
