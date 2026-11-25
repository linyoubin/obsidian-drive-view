/**
 * ContentCache 单测：纯内存 LRU、blob URL 回收、预取闸门。
 *
 * 全部用假 blob URL 工厂（`blob:fake-N`），不碰真实 DOM/IDB/磁盘。
 */

import { describe, expect, test } from "bun:test";

import {
  ContentCache,
  DEFAULT_CONTENT_CACHE_BYTES,
  DEFAULT_PREFETCH_LIMIT,
  DEFAULT_PREFETCH_MAX_BYTES,
  type PrefetchItem,
} from "../src/store/ContentCache";

// ------------------------------------------------------------------ 工具

function buffer(bytes: number, fill = 7): ArrayBuffer {
  const view = new Uint8Array(bytes);
  view.fill(fill);
  return view.buffer;
}

interface Harness {
  cache: ContentCache;
  created: string[];
  revoked: string[];
  evicted: Array<{ path: string; bytes: number }>;
}

function makeCache(options: { maxBytes?: number; prefetchLimit?: number; prefetchMaxBytes?: number; revokeDelayMs?: number } = {}): Harness {
  const created: string[] = [];
  const revoked: string[] = [];
  const evicted: Array<{ path: string; bytes: number }> = [];
  const cache = new ContentCache({
    maxBytes: options.maxBytes ?? 100,
    prefetchLimit: options.prefetchLimit ?? DEFAULT_PREFETCH_LIMIT,
    prefetchMaxBytes: options.prefetchMaxBytes ?? DEFAULT_PREFETCH_MAX_BYTES,
    revokeDelayMs: options.revokeDelayMs ?? 0,
    createObjectUrl: () => {
      const url = `blob:fake-${created.length + 1}`;
      created.push(url);
      return url;
    },
    revokeObjectUrl: (url: string) => {
      revoked.push(url);
    },
    now: () => 1234,
    onEvict: (path, bytes) => {
      evicted.push({ path, bytes });
    },
  });
  return { cache, created, revoked, evicted };
}

// ------------------------------------------------------------------ 基本读写

describe("ContentCache：读写与上限", () => {
  test("默认上限 8MB / 预取 5 个 / 单文件 2MB", () => {
    const cache = new ContentCache();
    expect(cache.maxBytes).toBe(DEFAULT_CONTENT_CACHE_BYTES);
    expect(cache.maxBytes).toBe(8 * 1024 * 1024);
    expect(cache.prefetchLimit).toBe(DEFAULT_PREFETCH_LIMIT);
    expect(cache.prefetchLimit).toBe(5);
    expect(cache.prefetchMaxBytes).toBe(DEFAULT_PREFETCH_MAX_BYTES);
    expect(cache.prefetchMaxBytes).toBe(2 * 1024 * 1024);
  });

  test("put/get/has 正常往返，字节数累计正确", () => {
    const { cache } = makeCache();
    expect(cache.put("a.md", buffer(30)).cached).toBe(true);
    expect(cache.put("b.md", buffer(20)).cached).toBe(true);
    expect(cache.size).toBe(2);
    expect(cache.bytes).toBe(50);
    expect(cache.has("a.md")).toBe(true);
    const data = cache.get("a.md");
    expect(data).toBeInstanceOf(ArrayBuffer);
    expect(data!.byteLength).toBe(30);
    expect(new Uint8Array(data!)[0]).toBe(7);
    expect(cache.get("missing.md")).toBeNull();
  });

  test("同 path 覆盖写入：旧条目先释放，字节数不重复计", () => {
    const { cache, revoked } = makeCache();
    const first = cache.put("a.md", buffer(30));
    const firstUrl = cache.peek("a.md")!.url;
    expect(first.cached).toBe(true);
    cache.put("a.md", buffer(10));
    expect(cache.bytes).toBe(10);
    expect(cache.size).toBe(1);
    expect(revoked).toEqual([firstUrl]);
  });

  test("单条大于总上限 → 不缓存也不挤掉别人", () => {
    const { cache } = makeCache({ maxBytes: 100 });
    cache.put("small.md", buffer(40));
    const result = cache.put("big.bin", buffer(200));
    expect(result.cached).toBe(false);
    expect(cache.has("big.bin")).toBe(false);
    expect(cache.has("small.md")).toBe(true);
    expect(cache.bytes).toBe(40);
  });

  test("空路径不缓存；0 字节文件照常缓存（0.2.9，但不生成 blob URL）", () => {
    const { cache, created } = makeCache();
    expect(cache.put("", buffer(10)).cached).toBe(false);
    const empty = cache.put("empty.md", buffer(0));
    expect(empty.cached).toBe(true);
    expect(cache.size).toBe(1);
    expect(cache.bytes).toBe(0);
    expect(cache.peek("empty.md")!.url).toBe("");
    expect(cache.get("empty.md")!.byteLength).toBe(0);
    expect(created.length).toBe(0);
  });
});

// ------------------------------------------------------------------ LRU 与 blob 回收

describe("ContentCache：LRU 逐出与 blob 回收", () => {
  test("超限时逐出最久未用，并 revoke 它的 blob URL", () => {
    const { cache, revoked, evicted } = makeCache({ maxBytes: 100 });
    cache.put("a.md", buffer(40));
    cache.put("b.md", buffer(40));
    const aUrl = cache.peek("a.md")!.url;
    const bUrl = cache.peek("b.md")!.url;

    const result = cache.put("c.md", buffer(40));
    expect(result.cached).toBe(true);
    // 100 上限：a+b=80，再放 40 需要先逐出 a（最旧）
    expect(result.evicted).toEqual(["a.md"]);
    expect(cache.has("a.md")).toBe(false);
    expect(cache.has("b.md")).toBe(true);
    expect(cache.has("c.md")).toBe(true);
    expect(cache.bytes).toBe(80);
    expect(revoked).toEqual([aUrl]);
    expect(evicted).toEqual([{ path: "a.md", bytes: 40 }]);
    expect(aUrl).not.toBe(bUrl);
  });

  test("get 命中会刷新 LRU 顺序，最久未用的不再是它", () => {
    const { cache, revoked } = makeCache({ maxBytes: 100 });
    cache.put("a.md", buffer(40));
    cache.put("b.md", buffer(40));
    expect(cache.keys()).toEqual(["a.md", "b.md"]);

    cache.get("a.md"); // 刷新 a
    expect(cache.keys()).toEqual(["b.md", "a.md"]);

    const aUrl = cache.peek("a.md")!.url;
    const result = cache.put("c.md", buffer(40));
    expect(result.evicted).toEqual(["b.md"]); // 逐出的是 b 而不是 a
    expect(cache.has("a.md")).toBe(true);
    expect(revoked.length).toBe(1);
    expect(revoked[0]).not.toBe(aUrl);
  });

  test("getResourceUrl：命中给 blob URL 且刷新 LRU，未命中给空串", () => {
    const { cache } = makeCache({ maxBytes: 100 });
    cache.put("a.md", buffer(10));
    cache.put("b.md", buffer(10));
    const url = cache.getResourceUrl("a.md");
    expect(url.startsWith("blob:fake-")).toBe(true);
    expect(cache.keys()).toEqual(["b.md", "a.md"]);
    expect(cache.getResourceUrl("nope.md")).toBe("");
  });

  test("delete 与 clear 都会 revoke", () => {
    const { cache, revoked } = makeCache({ maxBytes: 100 });
    cache.put("a.md", buffer(10));
    cache.put("b.md", buffer(10));
    const aUrl = cache.peek("a.md")!.url;
    const bUrl = cache.peek("b.md")!.url;

    expect(cache.delete("a.md")).toBe(true);
    expect(cache.delete("a.md")).toBe(false);
    expect(revoked).toEqual([aUrl]);

    cache.clear();
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
    expect(revoked).toEqual([aUrl, bUrl]);
  });
});

// ------------------------------------------------------------------ 预取

describe("ContentCache：预取闸门与批大小", () => {
  test("入队时跳过：已缓存、重复、已知 >2MB", () => {
    const { cache } = makeCache({ maxBytes: 8 * 1024 * 1024 });
    cache.put("cached.md", buffer(10));
    const queued = cache.enqueuePrefetch([
      { path: "cached.md" },
      { path: "big.bin", size: 3 * 1024 * 1024 },
      { path: "ok.md", size: 1024 },
      { path: "ok.md", size: 1024 },
      { path: "" },
    ]);
    expect(queued).toEqual({ queued: 1, skipped: 4 });
    expect(cache.pendingPrefetch).toBe(1);
    expect(cache.keys()).toEqual(["cached.md"]);
  });

  test("runPrefetch 把内容放进缓存，超过上限的条目被跳过", async () => {
    const { cache } = makeCache({ maxBytes: 100, prefetchMaxBytes: 50 });
    cache.enqueuePrefetch([{ path: "a.md", size: 20 }, { path: "too-big.md", size: 999 }]);
    const loaded: string[] = [];
    const result = await cache.runPrefetch(async (path) => {
      loaded.push(path);
      return buffer(20);
    });
    expect(loaded).toEqual(["a.md"]);
    expect(result.loaded).toBe(1);
    expect(result.bytes).toBe(20);
    expect(cache.has("a.md")).toBe(true);
    expect(cache.pendingPrefetch).toBe(0);
  });

  test("一次最多 5 个并发（prefetchLimit 生效）", async () => {
    const { cache } = makeCache({ maxBytes: 8 * 1024 * 1024, prefetchLimit: 5 });
    const paths: PrefetchItem[] = Array.from({ length: 12 }, (_, index) => ({ path: `f${index}.md` }));
    cache.enqueuePrefetch(paths);

    let active = 0;
    let peak = 0;
    const result = await cache.runPrefetch(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return buffer(16);
    });

    expect(peak).toBe(5);
    expect(result.loaded).toBe(12);
    expect(cache.size).toBe(12);
  });

  test("prefetchLimit 可配成 2：峰值并发不超过 2", async () => {
    const { cache } = makeCache({ maxBytes: 8 * 1024 * 1024, prefetchLimit: 2 });
    cache.enqueuePrefetch([{ path: "a" }, { path: "b" }, { path: "c" }]);
    let active = 0;
    let peak = 0;
    await cache.runPrefetch(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return buffer(8);
    });
    expect(peak).toBe(2);
  });

  test("加载失败计数 failed，不写缓存、不重试", async () => {
    const { cache } = makeCache({ maxBytes: 100 });
    cache.enqueuePrefetch([{ path: "bad.md" }, { path: "good.md" }]);
    const result = await cache.runPrefetch(async (path) => {
      if (path === "bad.md") throw new Error("download failed");
      return buffer(10);
    });
    expect(result.failed).toBe(1);
    expect(result.loaded).toBe(1);
    expect(cache.has("bad.md")).toBe(false);
    expect(cache.pendingPrefetch).toBe(0);
  });

  test("prefetch() 便捷方法 = 入队 + 执行", async () => {
    const { cache } = makeCache({ maxBytes: 100 });
    const result = await cache.prefetch([{ path: "a.md" }], async () => buffer(9));
    expect(result.loaded).toBe(1);
    expect(cache.bytes).toBe(9);
  });

  test("clearPrefetch 清空待办，不再触发加载", async () => {
    const { cache } = makeCache({ maxBytes: 100 });
    cache.enqueuePrefetch([{ path: "a.md" }]);
    cache.clearPrefetch();
    let called = 0;
    const result = await cache.runPrefetch(async () => {
      called += 1;
      return buffer(4);
    });
    expect(called).toBe(0);
    expect(result.loaded).toBe(0);
  });
});

// ------------------------------------------------------------------ 预取循环与延迟 revoke（0.2.9）

describe("ContentCache：预取循环（0.2.9）", () => {
  test("startPrefetchLoop 幂等启动并消化队列；stopPrefetchLoop 停止；每个附件成功后回调", async () => {
    const { cache } = makeCache({ prefetchLimit: 2 });
    const loaded: string[] = [];
    cache.enqueuePrefetch([{ path: "img/a.png" }, { path: "img/b.png" }]);
    const loader = async (path: string) => buffer(10);
    cache.startPrefetchLoop(loader, { onLoaded: (path) => loaded.push(path) });
    cache.startPrefetchLoop(loader); // 幂等：不应重复启动
    expect(cache.prefetchRunning).toBe(true);
    for (let i = 0; i < 400; i += 1) {
      if (cache.has("img/a.png") && cache.has("img/b.png")) break;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(cache.has("img/a.png")).toBe(true);
    expect(cache.has("img/b.png")).toBe(true);
    expect(cache.pendingPrefetch).toBe(0);
    expect(loaded.sort()).toEqual(["img/a.png", "img/b.png"]);
    cache.stopPrefetchLoop();
    expect(cache.prefetchRunning).toBe(false);
  });

  test("0 字节附件也会被预取缓存（不再因 bytes<=0 跳过）", async () => {
    const { cache } = makeCache();
    cache.enqueuePrefetch([{ path: "empty.md" }]);
    const result = await cache.runPrefetch(async () => buffer(0));
    expect(result.loaded).toBe(1);
    expect(cache.has("empty.md")).toBe(true);
    expect(cache.peek("empty.md")!.url).toBe("");
  });
});

describe("ContentCache：blob URL 延迟 revoke（0.2.9）", () => {
  test("逐出后 60s 才 revoke（期间不立刻释放，避免已渲染图片变破图）", () => {
    const created: string[] = [];
    const revoked: string[] = [];
    const scheduled: Array<{ callback: () => void; ms: number }> = [];
    const cache = new ContentCache({
      maxBytes: 60,
      createObjectUrl: () => {
        const url = `blob:fake-${created.length + 1}`;
        created.push(url);
        return url;
      },
      revokeObjectUrl: (url: string) => revoked.push(url),
      revokeDelayMs: 60_000,
      schedule: (callback, ms) => scheduled.push({ callback, ms }),
    });
    cache.put("a.md", buffer(40));
    const aUrl = cache.peek("a.md")!.url;
    cache.put("b.md", buffer(40)); // 超限 → 逐出 a
    expect(cache.has("a.md")).toBe(false);
    expect(revoked).toEqual([]); // 还没释放
    expect(scheduled.length).toBe(1);
    expect(scheduled[0].ms).toBe(60_000);
    scheduled[0].callback(); // 60s 后
    expect(revoked).toEqual([aUrl]);
  });
});
