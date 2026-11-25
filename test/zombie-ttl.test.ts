/**
 * 0.2.21 S1/S2：僵尸请求的 TTL、上限与复用。
 *
 * S1：僵尸永不 settle 时，`fidZombies` 无 TTL 会把该 fid 永久毒化（后续调用只等不发请求）。
 * S2：等待僵尸的上限曾等于整段下载超时，重试必然再吃一次超时；且僵尸成功后结果被丢弃。
 *
 * 全部用「永不 settle 的 transport」复现真实僵尸场景：
 *   - S1 用例：TTL 到期 → 新调用重新发请求（transport 计数增长）；
 *   - S2 用例①：僵尸在等待期内成功 → 等待者复用同一 buffer，transport 不再发请求；
 *   - S2 用例②：僵尸超期（等待上限）→ 等待者按上限返回并自行发起。
 */

import { describe, expect, test } from "bun:test";

import {
  QuarkClient,
  QuarkDownloadTimeoutError,
  TokenBucket,
  type QuarkHttpResponse,
  type QuarkTransport,
} from "../src/client/QuarkClient";

const fastBucket = (): TokenBucket => new TokenBucket({ ratePerSecond: 10000, sleep: async () => undefined });
const fastSleep = async (): Promise<void> => undefined;

function jsonResponse(body: unknown): QuarkHttpResponse {
  return { status: 200, headers: {}, text: JSON.stringify(body) };
}

function fileResponse(text: string): QuarkHttpResponse {
  return { status: 200, headers: {}, arrayBuffer: new TextEncoder().encode(text).buffer as ArrayBuffer };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("waitFor timeout");
    await delay(5);
  }
}

const HOP1 = (): QuarkHttpResponse =>
  jsonResponse({ code: 0, data: [{ download_url: "https://cdn.example/zombie" }] });

describe("0.2.21 S1 僵尸 TTL 与上限", () => {
  test("僵尸永不 settle + TTL 到期 → 新调用能重新发请求（transport 计数增长）", async () => {
    const calls: string[] = [];
    const transport: QuarkTransport = async (request) => {
      if (request.url.includes("/file/download")) {
        calls.push("hop1");
        return HOP1();
      }
      calls.push("hop2");
      return await new Promise<QuarkHttpResponse>(() => {
        /* 永不 settle */
      });
    };
    const client = new QuarkClient({
      transport,
      limiter: fastBucket(),
      sleep: fastSleep,
      downloadTimeoutMs: 40,
      zombieTtlMs: 120,
    });

    const first = await client.downloadFile("fid-ttl").then(
      () => "resolved",
      (error) => error
    );
    expect(first).toBeInstanceOf(QuarkDownloadTimeoutError);
    expect(calls.length).toBe(2);

    await delay(160); // 超过 zombieTtlMs：僵尸必须被强制清理

    // 第二次调用必须重新发请求；改前会一直等（或直接超时）而不发
    void client.downloadFile("fid-ttl").then(
      () => undefined,
      () => undefined
    );
    await waitFor(() => calls.length >= 4, 1500);
    expect(calls.length).toBeGreaterThanOrEqual(4);
  });
});

describe("0.2.21 S2 等待上限与结果复用", () => {
  test("僵尸在等待期内成功 → 等待者拿到同一 buffer，transport 不再发请求", async () => {
    let hop2Count = 0;
    let releaseFirst!: () => void;
    const transport: QuarkTransport = async (request) => {
      if (request.url.includes("/file/download")) return HOP1();
      hop2Count += 1;
      if (hop2Count === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
        return fileResponse("zombie-body");
      }
      return fileResponse("fresh-body");
    };
    const client = new QuarkClient({
      transport,
      limiter: fastBucket(),
      sleep: fastSleep,
      downloadTimeoutMs: 40,
      zombieTtlMs: 5000,
    });

    const first = await client.downloadFile("fid-reuse").then(
      () => "resolved",
      (error) => error
    );
    expect(first).toBeInstanceOf(QuarkDownloadTimeoutError);
    expect(hop2Count).toBe(1);

    const second = client.downloadFile("fid-reuse").then(
      (buffer) => ({ ok: true as const, body: new TextDecoder().decode(buffer) }),
      (error) => ({ ok: false as const, error })
    );
    await delay(60); // 第二调用进入等待
    setTimeout(releaseFirst, 90); // 僵尸在等待期内（~150ms）成功
    const outcome = await Promise.race([second, delay(2000).then(() => ({ ok: "watchdog" as const }))]);

    expect(outcome.ok).toBe(true);
    if (outcome.ok === true) expect(outcome.body).toBe("zombie-body");
    expect(hop2Count).toBe(1); // 复用，不再发第二份请求
  });

  test("僵尸超期（等待上限 min(ttl,3s)）→ 等待者按上限返回并自行发起新请求", async () => {
    const calls: string[] = [];
    const transport: QuarkTransport = async (request) => {
      if (request.url.includes("/file/download")) {
        calls.push("hop1");
        return HOP1();
      }
      calls.push("hop2");
      return await new Promise<QuarkHttpResponse>(() => {
        /* 永不 settle */
      });
    };
    const client = new QuarkClient({
      transport,
      limiter: fastBucket(),
      sleep: fastSleep,
      downloadTimeoutMs: 200,
      zombieTtlMs: 5000,
      zombieWaitMs: 400, // 等价于 min(ttl, 3s) 的测试替身
    });

    const first = await client.downloadFile("fid-bound").then(
      () => "resolved",
      (error) => error
    );
    expect(first).toBeInstanceOf(QuarkDownloadTimeoutError);
    expect(calls.length).toBe(2);

    void client.downloadFile("fid-bound").then(
      () => undefined,
      () => undefined
    );
    // 新实现：还在等待上限内（400ms）→ 不发请求
    await delay(300);
    expect(calls.length).toBe(2);

    // 到点后放弃等待、自行发起（hop1 + hop2）
    await waitFor(() => calls.length >= 4, 1500);
  });
});
