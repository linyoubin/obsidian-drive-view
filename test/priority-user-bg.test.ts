/**
 * 0.2.21 S3：用户点开的附件与预取同队。
 *
 * 期望：给 background 通道保留 1 个槽位专门给「用户点开的附件」——
 * 用户点击的下载排在同优先级预取之前，不被预取堵住；但**不提高** bg 总上限（限速不失效）。
 */

import { describe, expect, test } from "bun:test";

import { DownloadGate } from "../src/client/downloadGate";
import { QuarkReadOnlyAdapter } from "../src/adapter/QuarkReadOnlyAdapter";
import type { IndexEntry } from "../src/store/IndexStore";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("0.2.21 S3 用户点击附件优先", () => {
  test("预取占满常规槽位时，用户点开的附件仍先启动（不被预取堵住）", async () => {
    const gate = new DownloadGate({ concurrency: 4, backgroundLimit: 2 });
    const order: string[] = [];
    const releaseBg0 = deferred<void>();
    const releaseBg1 = deferred<void>();
    const releaseUser = deferred<void>();
    const run = (name: string, priority: "background" | "background-user", release: { promise: Promise<void> }) =>
      gate.run(
        async () => {
          order.push(name);
          await release.promise;
        },
        { priority }
      );

    const bg0 = run("bg0", "background", releaseBg0);
    const bg1 = run("bg1", "background", releaseBg1);
    const user = run("user", "background-user", releaseUser);
    await delay(10);

    // 改前：bg1 先占第 2 个槽位 → user 排在后面
    expect(order.slice(0, 2)).toEqual(["bg0", "user"]);
    expect(gate.peak).toBeLessThanOrEqual(2); // bg 总上限没被抬高

    releaseBg0.resolve();
    releaseBg1.resolve();
    releaseUser.resolve();
    await Promise.all([bg0, bg1, user]);
    expect(order).toContain("bg1");
  });

  test("adapter.readBinaryForUser 按 background-user 记账（预取 loop 仍用 readBinary）", async () => {
    const entries: IndexEntry[] = [
      { path: "img/a.jpeg", type: "file", fid: "fid-img", parentFid: "", size: 6, mtime: 1 },
    ];
    const priorities: Array<string | undefined> = [];
    const adapter = new QuarkReadOnlyAdapter({
      index: { entries },
      cache: {
        has: () => false,
        get: () => null,
        getResourceUrl: () => "",
        put: () => ({ cached: true }),
        enqueuePrefetch: () => undefined,
      },
      client: {
        downloadFile: async (_fid: string, options?: { priority?: string }) => {
          priorities.push(options?.priority);
          return new TextEncoder().encode("binary").buffer as ArrayBuffer;
        },
      },
      baseAdapter: {} as never,
      allowPrefetch: () => false,
    });

    await adapter.readBinaryForUser("img/a.jpeg");
    expect(priorities).toEqual(["background-user"]);
  });
});
