/**
 * 0.2.29 任务 B：图片/PDF 内容空白的排查与修复证据。
 *
 * 修复方向：
 *   ① 下载完成后**重新生成 blob URL**（不复用旧 URL）——Obsidian 可能缓存了旧的占位/空 blob；
 *   ② 在 `setViewState` 重载**之前**先换 URL（warmup 的 refreshResource 钩子顺序）；
 *   ③ `stage=view` 记录 `api=getResourcePath|readBinary` + `urlHead`（前 20 字符）+ MIME/字节数，
 *      下次真机可一眼判断渲染器到底走的哪条 API、拿到的 URL 是否 `blob:`。
 */

import { describe, expect, test } from "bun:test";

import { ContentCache } from "../src/store/ContentCache";
import {
  QuarkReadOnlyAdapter,
  createAttachmentWarmup,
} from "../src/adapter/QuarkReadOnlyAdapter";
import type { RefreshableLeafLike } from "../src/adapter/QuarkReadOnlyAdapter";

const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer;

interface DiagEntry {
  stage?: string;
  path?: string;
  fields?: Record<string, unknown>;
}

function makeAdapter(options: { now?: () => number; diag?: (entry: DiagEntry) => void } = {}) {
  let urlSeq = 0;
  const cache = new ContentCache({
    createObjectUrl: (_data: ArrayBuffer, path: string) => `blob:${path}#${++urlSeq}`,
  });
  const adapter = new QuarkReadOnlyAdapter({
    index: {
      entries: [{ path: "files/a.pdf", type: "file", fid: "fid-pdf", parentFid: "", size: 4, mtime: 1 }],
    },
    cache,
    client: { downloadFile: async () => pdfBytes },
    baseAdapter: {} as never,
    allowPrefetch: () => false,
    diag: options.diag as never,
    now: options.now,
  });
  return { adapter, cache };
}

describe("0.2.29 任务 B：blob URL 刷新", () => {
  test("ContentCache.regenerateResourceUrl：返回新 URL、内容不变、旧 URL 延迟 revoke", () => {
    const revoked: string[] = [];
    const scheduled: Array<() => void> = [];
    const cache = new ContentCache({
      createObjectUrl: (_data: ArrayBuffer, path: string) => `blob:${path}#${Math.random()}`,
      revokeObjectUrl: (url) => revoked.push(url),
      schedule: (callback) => scheduled.push(callback),
    });
    cache.put("files/a.pdf", pdfBytes);
    const first = cache.peek("files/a.pdf")!.url;

    const second = cache.regenerateResourceUrl("files/a.pdf");
    expect(second).not.toBe(first);
    expect(second.startsWith("blob:files/a.pdf#")).toBe(true);
    // 内容不丢
    expect(cache.get("files/a.pdf")).not.toBeNull();
    // 旧 URL 不是立刻 revoke（避免渲染器正持有它）
    expect(revoked).toEqual([]);
    scheduled.forEach((run) => run());
    expect(revoked).toContain(first);
    // 未知路径返回空串
    expect(cache.regenerateResourceUrl("nope.pdf")).toBe("");
  });

  test("adapter.refreshResourceUrl：readBinary 之后再刷新，getResourcePath 给出不同的新 URL", async () => {
    const { adapter } = makeAdapter();
    await adapter.readBinary("files/a.pdf");
    const oldUrl = adapter.getResourcePath("files/a.pdf");
    const newUrl = adapter.refreshResourceUrl("files/a.pdf");
    expect(newUrl).not.toBe(oldUrl);
    expect(adapter.getResourcePath("files/a.pdf")).toBe(newUrl);
  });

  test("warmup：下载完成后先 refreshResource 换 URL，再 setViewState 重载（顺序断言）", async () => {
    const order: string[] = [];
    const leaf: RefreshableLeafLike = {
      view: { file: { path: "files/a.pdf" } },
      getViewState: () => ({ type: "pdf" }),
      setViewState: async () => {
        order.push("reload");
      },
    };
    const warmup = createAttachmentWarmup({
      readBinary: async () => {
        order.push("download");
      },
      refreshResource: () => {
        order.push("refresh");
      },
      activeLeaf: () => leaf,
      openLeaves: () => [leaf],
    });

    await expect(warmup("files/a.pdf")).resolves.toBe(true);
    order.push("done");
    expect(order).toEqual(["download", "refresh", "reload", "done"]);
  });

  test("stage=view：getResourcePath 命中记 api=getResourcePath + urlHead（同 path 2s 内只记一次）", async () => {
    let now = 10_000;
    const diag: DiagEntry[] = [];
    const { adapter } = makeAdapter({ now: () => now, diag: (entry) => diag.push(entry) });
    await adapter.readBinary("files/a.pdf");

    const url = adapter.getResourcePath("files/a.pdf");
    adapter.getResourcePath("files/a.pdf"); // 2s 内 → 不重复记

    const views = diag.filter((entry) => entry.stage === "view" && entry.fields?.api === "getResourcePath");
    expect(views).toHaveLength(1);
    expect(views[0].path).toBe("files/a.pdf");
    expect(views[0].fields).toMatchObject({
      api: "getResourcePath",
      mime: "application/pdf",
      bytes: 4,
    });
    expect(String(views[0].fields?.urlHead)).toBe(url.slice(0, 20));
    expect(String(views[0].fields?.urlHead).startsWith("blob:")).toBe(true);

    now += 2_001;
    adapter.getResourcePath("files/a.pdf");
    expect(diag.filter((entry) => entry.fields?.api === "getResourcePath")).toHaveLength(2);
  });

  test("stage=view：readBinaryForUser 记 api=readBinary + urlHead", async () => {
    const diag: DiagEntry[] = [];
    const { adapter } = makeAdapter({ diag: (entry) => diag.push(entry) });
    await adapter.readBinaryForUser("files/a.pdf");
    const view = diag.find((entry) => entry.stage === "view" && entry.fields?.api === "readBinary");
    expect(view).toBeDefined();
    expect(view!.fields).toMatchObject({ kind: "pdf", mime: "application/pdf", bytes: 4 });
    expect(String(view!.fields?.urlHead).startsWith("blob:")).toBe(true);
  });
});
