/**
 * 0.2.30：Obsidian 内显示图片（含正文内嵌 `![[x.jpeg]]`）。
 *
 * 主假设 H1：Obsidian 按 path 缓存 `getResourcePath` 结果；我们未命中时返回**固定占位串**，
 * 之后即使下载完成也可能不再来问 → 一直显示占位/空白。
 *
 * 对策（四条都验证）：
 *   ① 未命中占位**每次不同**（绕过按 path 的字符串缓存）；
 *   ② 下载完成后**换新 blob URL**（不复用旧 URL）；
 *   ③ 下载完成后 `stat().mtime` 递增（让 Obsidian 资源缓存失效）；
 *   ④ 重载前先换 URL / 主插件再触发一次 modify 事件（顺序由 warmup 用例断言）。
 */

import { describe, expect, test } from "bun:test";

import { ContentCache } from "../src/store/ContentCache";
import {
  QuarkReadOnlyAdapter,
  createAttachmentWarmup,
} from "../src/adapter/QuarkReadOnlyAdapter";
import type { RefreshableLeafLike } from "../src/adapter/QuarkReadOnlyAdapter";

const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]).buffer;

interface DiagEntry {
  stage?: string;
  path?: string;
  fields?: Record<string, unknown>;
}

function makeAdapter(options: { now?: () => number; diag?: (entry: DiagEntry) => void } = {}) {
  let seq = 0;
  const cache = new ContentCache({
    createObjectUrl: (_data: ArrayBuffer, path: string) => `blob:${path}#v${++seq}`,
  });
  let downloads = 0;
  const adapter = new QuarkReadOnlyAdapter({
    index: {
      entries: [{ path: "pics/a.png", type: "file", fid: "fid-png", parentFid: "", size: 4, mtime: 1 }],
    },
    cache,
    client: {
      downloadFile: async () => {
        downloads += 1;
        return pngBytes;
      },
    },
    baseAdapter: {} as never,
    allowPrefetch: () => false,
    diag: options.diag as never,
    now: options.now,
  });
  return { adapter, cache, downloads: () => downloads };
}

describe("0.2.30 图片渲染（H1：占位不再固定）", () => {
  test("未命中 → 占位每次不同、且不触发下载", () => {
    const { adapter, downloads } = makeAdapter();
    const first = adapter.getResourcePath("pics/a.png");
    const second = adapter.getResourcePath("pics/a.png");

    expect(first.startsWith("data:image/png;base64,")).toBe(true);
    expect(second.startsWith("data:image/png;base64,")).toBe(true);
    expect(second).not.toBe(first); // 关键：不再返回同一个固定占位串
    expect(downloads()).toBe(0);
  });

  test("下载完成后再问 → blob + MIME 正确，且与占位不同", async () => {
    const { adapter, cache } = makeAdapter();
    const placeholder = adapter.getResourcePath("pics/a.png");

    await adapter.readBinaryForUser("pics/a.png");

    const url = adapter.getResourcePath("pics/a.png");
    expect(url.startsWith("blob:")).toBe(true);
    expect(url).not.toBe(placeholder);
    expect(cache.peek("pics/a.png")?.mime).toBe("image/png");
  });

  test("同一图片连问 3 次：第 1 次占位，下载完成后第 2/3 次都是同一个 blob", async () => {
    const { adapter } = makeAdapter();
    const first = adapter.getResourcePath("pics/a.png");
    await adapter.readBinaryForUser("pics/a.png");
    const second = adapter.getResourcePath("pics/a.png");
    const third = adapter.getResourcePath("pics/a.png");

    expect(first.startsWith("data:")).toBe(true);
    expect(second.startsWith("blob:")).toBe(true);
    expect(third).toBe(second);
  });

  test("下载完成后 stat().mtime 比之前大（让 Obsidian 资源缓存失效）", async () => {
    const { adapter } = makeAdapter({ now: () => 1_700_000_000_000 });
    const before = await adapter.stat("pics/a.png");
    await adapter.readBinaryForUser("pics/a.png");
    const after = await adapter.stat("pics/a.png");

    expect(before).not.toBeNull();
    expect(after).not.toBeNull();
    expect(after!.mtime).toBeGreaterThan(before!.mtime);
  });

  test("H2：换 URL 时旧 blob 不立刻 revoke（延迟释放，避免重载前失效）", () => {
    const revoked: string[] = [];
    const scheduled: Array<() => void> = [];
    const cache = new ContentCache({
      createObjectUrl: (_data: ArrayBuffer, path: string) => `blob:${path}#${Math.random()}`,
      revokeObjectUrl: (url) => revoked.push(url),
      schedule: (callback) => scheduled.push(callback),
    });
    cache.put("pics/a.png", pngBytes);
    const oldUrl = cache.getResourceUrl("pics/a.png");

    const newUrl = cache.regenerateResourceUrl("pics/a.png");
    expect(newUrl).not.toBe(oldUrl);
    expect(revoked).toEqual([]); // 重载前不得 revoke
    scheduled.forEach((run) => run());
    expect(revoked).toContain(oldUrl);
  });

  test("warmup 顺序：download → refreshResource → notifyModified → reload", async () => {
    const order: string[] = [];
    const leaf: RefreshableLeafLike = {
      view: { file: { path: "pics/a.png" } },
      getViewState: () => ({ type: "image" }),
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
      notifyModified: () => {
        order.push("notify");
      },
      activeLeaf: () => leaf,
      openLeaves: () => [leaf],
    });

    await expect(warmup("pics/a.png")).resolves.toBe(true);
    order.push("done");
    expect(order).toEqual(["download", "refresh", "notify", "reload", "done"]);
  });

  test("H3：stage=view 区分 api=getResourcePath/readBinary，并记 result 与 askCount", async () => {
    let now = 10_000;
    const diag: DiagEntry[] = [];
    const { adapter } = makeAdapter({ now: () => now, diag: (entry) => diag.push(entry) });

    adapter.getResourcePath("pics/a.png"); // ask 1
    now += 3_000;
    await adapter.readBinaryForUser("pics/a.png");
    now += 3_000;
    adapter.getResourcePath("pics/a.png"); // ask 2

    const asks = diag.filter((entry) => entry.fields?.api === "getResourcePath");
    expect(asks).toHaveLength(2);
    expect(asks[0].fields).toMatchObject({ result: "placeholder", askCount: 1 });
    expect(asks[1].fields).toMatchObject({ result: "blob", askCount: 2 });
    expect(asks.every((entry) => String(entry.fields?.urlHead).length <= 20)).toBe(true);

    const read = diag.find((entry) => entry.fields?.api === "readBinary");
    expect(read).toBeDefined();
    expect(read!.fields).toMatchObject({ api: "readBinary", mime: "image/png", bytes: 4 });
    expect(String(read!.fields?.urlHead).startsWith("blob:")).toBe(true);
  });
});
