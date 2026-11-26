/**
 * 0.2.26：md 读取优先级竞态。
 *
 * 真机现象：手机上打开 md 长时间空白。怀疑 Obsidian 先 `read()` 再触发 `file-open`，
 * 这次 read 被判成 bulk，排在后台队列里等。
 *
 * 两个兜底一起做：
 *   ① `file-open` 把 path 记入 `recentOpened`（TTL 5s），TTL 内读 → interactive；
 *   ② md 读在没有 file-open 记录时，若 interactive 通道还有预算 → interactive（reason=md-default），
 *      预算满则回落 bulk（避免启动扫描把交互通道占满）；`readForBulk` 永远 bulk。
 *
 * 顺带把判定来源写进 gate 事件（`reason=recentOpened|active|md-default|bulk|bg|bg-user`）。
 */

import { describe, expect, test } from "bun:test";

import { QuarkReadOnlyAdapter } from "../src/adapter/QuarkReadOnlyAdapter";
import { DownloadGate } from "../src/client/downloadGate";
import type { IndexEntry } from "../src/store/IndexStore";

interface DownloadCall {
  path: string;
  priority?: string;
  reason?: string;
}

function entries(count: number): IndexEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    path: `notes/n${index}.md`,
    type: "file" as const,
    fid: `fid-${index}`,
    parentFid: "",
    size: 10,
    mtime: 1,
  }));
}

function makeAdapter(
  options: {
    count?: number;
    now?: () => number;
    interactiveBudget?: () => boolean;
    calls?: DownloadCall[];
    gate?: DownloadGate;
  } = {}
) {
  const calls: DownloadCall[] = options.calls ?? [];
  const gate = options.gate;
  const client = {
    downloadFile: async (
      _fid: string,
      opts?: { path?: string; priority?: string; reason?: string }
    ) => {
      calls.push({ path: opts?.path ?? "", priority: opts?.priority, reason: opts?.reason });
      if (gate) {
        await gate.run(
          async () => {
            await new Promise((resolve) => setTimeout(resolve, 2));
          },
          { priority: (opts?.priority ?? "background") as never, path: opts?.path ?? "", reason: opts?.reason }
        );
      }
      return new TextEncoder().encode("md").buffer as ArrayBuffer;
    },
  };
  const adapter = new QuarkReadOnlyAdapter({
    index: { entries: entries(options.count ?? 4) },
    cache: {
      has: () => false,
      get: () => null,
      getResourceUrl: "",
      put: () => ({ cached: true }),
      enqueuePrefetch: () => undefined,
    },
    client: client as never,
    baseAdapter: {} as never,
    allowPrefetch: () => false,
    now: options.now,
    interactiveBudget: options.interactiveBudget,
  });
  return { adapter, calls };
}

describe("0.2.26 md 读取优先级竞态", () => {
  test("未触发 file-open 前 read('a.md') → interactive（改前 bulk）", async () => {
    const calls: DownloadCall[] = [];
    const { adapter } = makeAdapter({ calls, interactiveBudget: () => true });

    await adapter.read("notes/n0.md");

    expect(calls).toHaveLength(1);
    expect(calls[0].priority).toBe("interactive");
    expect(calls[0].reason).toBe("md-default");
  });

  test("readForBulk 强制 bulk，且不经过 read()", async () => {
    const calls: DownloadCall[] = [];
    const { adapter } = makeAdapter({ calls, interactiveBudget: () => true });
    let readCalls = 0;
    const originalRead = adapter.read.bind(adapter);
    adapter.read = async (path: string) => {
      readCalls += 1;
      return await originalRead(path);
    };

    await adapter.readForBulk("notes/n0.md");

    expect(calls).toHaveLength(1);
    expect(calls[0].priority).toBe("bulk");
    expect(readCalls).toBe(0);
  });

  test("file-open 后 5s 内反复读仍 interactive；过期且不再 active → bulk", async () => {
    let now = 1_000;
    const calls: DownloadCall[] = [];
    const { adapter } = makeAdapter({
      calls,
      now: () => now,
      // 模拟交互通道已满：此时只应依赖 recentOpened，不应 md-default
      interactiveBudget: () => false,
    });

    adapter.markNoteOpened("notes/n0.md");
    now = 2_000;
    await adapter.read("notes/n0.md");
    now = 5_500; // markNoteOpened + 4500ms，仍在 5s 窗内
    await adapter.read("notes/n0.md");
    expect(calls.map((call) => call.priority)).toEqual(["interactive", "interactive"]);
    expect(calls.every((call) => call.reason === "recentOpened")).toBe(true);

    now = 6_001; // 超过 5s，activeNotePath 仍为空 → 回落 bulk
    await adapter.read("notes/n0.md");
    expect(calls[2].priority).toBe("bulk");
    expect(calls[2].reason).toBe("bulk");
  });

  test("启动扫描 200 个 md：interactive 同时在跑 ≤2，且 bulk 仍能推进", async () => {
    const gate = new DownloadGate({ concurrency: 4 });
    const calls: DownloadCall[] = [];
    let interactiveRunning = 0;
    let interactivePeak = 0;
    const { adapter } = makeAdapter({
      count: 200,
      calls,
      gate,
      interactiveBudget: () =>
        gate.interactiveActiveCount + gate.interactivePendingCount < gate.interactiveLimit,
    });

    // 在 fake client 外层观测 interactive 并发（gate 已限 2，这里再验证一次峰值）
    const originalDownload = adapter["client"] as unknown as {
      downloadFile: (fid: string, opts?: { path?: string; priority?: string; reason?: string }) => Promise<ArrayBuffer>;
    };
    const inner = originalDownload.downloadFile.bind(originalDownload);
    originalDownload.downloadFile = async (fid, opts) => {
      const isInteractive = opts?.priority === "interactive";
      if (isInteractive) {
        interactiveRunning += 1;
        interactivePeak = Math.max(interactivePeak, interactiveRunning);
      }
      try {
        return await inner(fid, opts);
      } finally {
        if (isInteractive) interactiveRunning -= 1;
      }
    };

    await Promise.all(Array.from({ length: 200 }, (_, index) => adapter.read(`notes/n${index}.md`)));

    const interactiveCount = calls.filter((call) => call.priority === "interactive").length;
    const bulkCount = calls.filter((call) => call.priority === "bulk").length;
    expect(interactiveCount).toBeGreaterThan(0);
    expect(interactiveCount).toBeLessThanOrEqual(gate.interactiveLimit); // ≤2
    expect(interactivePeak).toBeLessThanOrEqual(gate.interactiveLimit);
    expect(bulkCount).toBeGreaterThan(0); // 扫描的其余读仍走 bulk 并推进
    expect(gate.peak).toBeLessThanOrEqual(4);
  });

  test("gate 事件带 reason（recentOpened / md-default / bulk）", async () => {
    const events: Array<{ path: string; priority: string; reason?: string }> = [];
    const gate = new DownloadGate({ concurrency: 2, onEvent: (event: any) => events.push(event) });
    const calls: DownloadCall[] = [];
    const { adapter } = makeAdapter({
      calls,
      gate,
      now: () => 1_000,
      interactiveBudget: () => true,
    });

    adapter.markNoteOpened("notes/n0.md");
    await adapter.read("notes/n0.md"); // recentOpened
    await adapter.read("notes/n1.md"); // md-default
    await adapter.readForBulk("notes/n2.md"); // bulk

    expect(events.some((event) => event.reason === "recentOpened")).toBe(true);
    expect(events.some((event) => event.reason === "md-default")).toBe(true);
    expect(events.some((event) => event.reason === "bulk")).toBe(true);
  });
});
