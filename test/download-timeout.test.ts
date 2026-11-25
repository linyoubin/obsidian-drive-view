/**
 * 0.2.19 SF4：真正的下载超时（默认 20s，可配）。
 *
 * 现状只有 transport 自己抛「超时」才走重试/超时映射；transport 永不 resolve 时，
 * `downloadFile` 永远挂着、inflight 表项永不释放。
 *
 * 断言：
 *   - 配 40ms 超时 → 抛 `QuarkDownloadTimeoutError`，且远早于 watchdog；
 *   - 超时后 `inflight` 表为空、闸门没有泄漏槽位；
 *   - adapter 日志记 `cause=timeout`（正文读取失败一次一条）。
 */

import { describe, expect, test } from "bun:test";

import { QuarkClient, QuarkDownloadTimeoutError, TokenBucket, type QuarkTransport } from "../src/client/QuarkClient";
import { QuarkReadOnlyAdapter } from "../src/adapter/QuarkReadOnlyAdapter";
import type { IndexEntry } from "../src/store/IndexStore";

const fastBucket = (): TokenBucket => new TokenBucket({ ratePerSecond: 10000, sleep: async () => undefined });
const fastSleep = async (): Promise<void> => undefined;

const ENTRIES: IndexEntry[] = [
  { path: "notes/a.md", type: "file", fid: "fa", parentFid: "", size: 9, mtime: 1 },
];

/** 第一跳立即给签名 URL，第二跳永不 resolve。 */
const hangingTransport: QuarkTransport = async (request) => {
  if (request.url.includes("/file/download")) {
    return {
      status: 200,
      headers: {},
      text: JSON.stringify({ code: 0, data: [{ download_url: "https://cdn.example/never-resolve" }] }),
    };
  }
  return await new Promise<never>(() => {
    /* 永不 resolve */
  });
};

function adapterWith(client: QuarkClient, diag: Array<{ stage?: string; cause?: string }>) {
  return new QuarkReadOnlyAdapter({
    index: { entries: ENTRIES },
    cache: {
      has: () => false,
      get: () => null,
      getResourceUrl: "",
      put: () => ({ cached: true }),
      enqueuePrefetch: () => undefined,
    },
    client,
    baseAdapter: {} as never,
    diag: (entry) => diag.push(entry as never),
    allowPrefetch: () => false,
  });
}

describe("0.2.19 SF4 下载超时", () => {
  test("transport 永不 resolve → 40ms 超时抛 QuarkDownloadTimeoutError，inflight 清空、闸门不泄漏", async () => {
    const client = new QuarkClient({
      transport: hangingTransport,
      limiter: fastBucket(),
      sleep: fastSleep,
      downloadTimeoutMs: 40,
    });

    const startedAt = Date.now();
    const outcome = await Promise.race([
      client.downloadFile("fid-1").then(
        () => "resolved",
        (error) => error
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("watchdog"), 500)),
    ]);

    expect(outcome).toBeInstanceOf(QuarkDownloadTimeoutError);
    expect((outcome as QuarkDownloadTimeoutError).retried).toBe(false);
    expect(client.inflightCount).toBe(0);
    expect(client.inflightKeys()).toEqual([]);
    expect(client.downloadGate.active).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(400);
  });

  test("adapter 读正文超时：日志 cause=timeout，且只记一条 error", async () => {
    const diag: Array<{ stage?: string; cause?: string }> = [];
    const client = new QuarkClient({
      transport: hangingTransport,
      limiter: fastBucket(),
      sleep: fastSleep,
      downloadTimeoutMs: 40,
    });
    const adapter = adapterWith(client, diag);

    const outcome = await Promise.race([
      adapter.read("notes/a.md").then(
        () => "resolved",
        (error) => error
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("watchdog"), 600)),
    ]);

    expect(outcome).toBeInstanceOf(QuarkDownloadTimeoutError);
    expect(diag.some((entry) => entry.cause === "timeout")).toBe(true);
    expect(client.inflightCount).toBe(0);
  });
});
