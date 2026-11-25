/**
 * bulkPrefetch（0.2.13）：进度、跳过、取消、并发窗口、连续失败暂停。
 */

import { describe, expect, test } from "bun:test";

import { runBulkPrefetch } from "../src/prefetch/bulkPrefetch";

const bytes = (n: number): ArrayBuffer => new Uint8Array(n).buffer as ArrayBuffer;

describe("runBulkPrefetch：全库 md 正文预取", () => {
  test("进度统计：已下载/总数/字节", async () => {
    const progress: Array<{ done: number; total: number; bytes: number }> = [];
    const result = await runBulkPrefetch({
      paths: ["a.md", "b.md", "c.md"],
      load: async () => bytes(10),
      isCached: () => false,
      shouldStop: () => false,
      onProgress: (p) => progress.push({ ...p }),
    });
    expect(result.downloaded).toBe(3);
    expect(result.bytes).toBe(30);
    expect(result.total).toBe(3);
    expect(progress[progress.length - 1]).toMatchObject({ done: 3, total: 3, bytes: 30 });
  });

  test("已缓存 / 在途的跳过", async () => {
    const loaded: string[] = [];
    const result = await runBulkPrefetch({
      paths: ["cached.md", "inflight.md", "new.md"],
      load: async (path) => {
        loaded.push(path);
        return bytes(1);
      },
      isCached: (path) => path === "cached.md",
      isInFlight: (path) => path === "inflight.md",
      shouldStop: () => false,
    });
    expect(result.skipped).toBe(2);
    expect(result.downloaded).toBe(1);
    expect(loaded).toEqual(["new.md"]);
  });

  test("取消后不再发起新任务", async () => {
    let stop = false;
    const loaded: string[] = [];
    const result = await runBulkPrefetch({
      paths: ["a.md", "b.md", "c.md", "d.md"],
      load: async (path) => {
        loaded.push(path);
        stop = true; // 第一个完成后取消
        return bytes(1);
      },
      isCached: () => false,
      shouldStop: () => stop,
      concurrency: 1,
    });
    expect(result.canceled).toBe(true);
    expect(loaded).toEqual(["a.md"]);
  });

  test("并发窗口默认 2", async () => {
    let active = 0;
    let peak = 0;
    await runBulkPrefetch({
      paths: ["a.md", "b.md", "c.md", "d.md", "e.md"],
      load: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 2));
        active -= 1;
        return bytes(1);
      },
      isCached: () => false,
      shouldStop: () => false,
    });
    expect(peak).toBe(2);
  });

  test("连续失败 5 次暂停（注入 sleep 观察）", async () => {
    const pauses: number[] = [];
    const result = await runBulkPrefetch({
      paths: Array.from({ length: 6 }, (_, i) => `f${i}.md`),
      load: async () => {
        throw new Error("boom");
      },
      isCached: () => false,
      shouldStop: () => false,
      concurrency: 1,
      pauseMs: 60_000,
      sleep: async (ms) => {
        pauses.push(ms);
      },
    });
    expect(result.failed).toBe(6);
    expect(pauses).toEqual([60_000]);
  });
});
