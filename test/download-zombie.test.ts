/**
 * 0.2.20 N3：超时后的僵尸请求。
 *
 * 现状：外层超时只让调用方拿到 `QuarkDownloadTimeoutError`，底层 `downloadWithRetry`
 * 还在跑：① 超时后仍会退避重试、继续发后续跳（累计请求继续增长）；
 * ② 同 fid 的新调用立刻另起一份，真实并发可达 2×配置。
 *
 * 断言：
 *   ① 超时后 transport 调用计数不再增长（不重试、不发第二跳）；
 *   ② 超时后同 fid 重试与前一个僵尸串行，不产生并发 2 份。
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

describe("0.2.20 N3 超时后不再发后续请求", () => {
  test("超时后 transport 调用计数不再增长（不重试、不发第二跳）", async () => {
    const calls: string[] = [];
    const transport: QuarkTransport = async (request) => {
      if (request.url.includes("/file/download")) {
        calls.push("hop1");
        return jsonResponse({ code: 0, data: [{ download_url: "https://cdn.example/zombie" }] });
      }
      calls.push("hop2");
      await delay(100); // 比外层超时（30ms）慢，模拟「僵尸还在跑」
      throw new Error("Request failed. 请求超时");
    };
    const client = new QuarkClient({
      transport,
      limiter: fastBucket(),
      sleep: fastSleep,
      downloadTimeoutMs: 30,
    });

    const outcome = await client.downloadFile("fid-zombie").then(
      () => "resolved",
      (error) => error
    );
    expect(outcome).toBeInstanceOf(QuarkDownloadTimeoutError);
    const callsAtTimeout = calls.length;
    expect(callsAtTimeout).toBe(2); // hop1 + hop2

    await delay(250); // 等僵尸的 hop2 超时并「本该重试」的窗口过去
    // 改前：僵尸在 100ms 处超时 → 退避（fastSleep）→ 再发 hop1+hop2 → 4
    expect(calls.length).toBe(callsAtTimeout);
  });

  test("超时后同 fid 重试与前一个僵尸串行，不产生并发 2 份", async () => {
    let hop2Count = 0;
    let cdnActive = 0;
    let maxCdnActive = 0;
    let releaseFirst!: () => void;
    const transport: QuarkTransport = async (request) => {
      if (request.url.includes("/file/download")) {
        return jsonResponse({ code: 0, data: [{ download_url: "https://cdn.example/same" }] });
      }
      hop2Count += 1;
      cdnActive += 1;
      maxCdnActive = Math.max(maxCdnActive, cdnActive);
      try {
        if (hop2Count === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
          return fileResponse("first-body");
        }
        return fileResponse("second-body");
      } finally {
        cdnActive -= 1;
      }
    };
    const client = new QuarkClient({
      transport,
      limiter: fastBucket(),
      sleep: fastSleep,
      downloadTimeoutMs: 300,
    });

    const first = client.downloadFile("fid-same", { priority: "interactive" }).then(
      () => "resolved",
      (error) => error
    );
    await waitFor(() => hop2Count === 1);
    const firstOutcome = await first;
    expect(firstOutcome).toBeInstanceOf(QuarkDownloadTimeoutError);

    // 超时后用户重试同一个 fid：必须排队等前一个僵尸结束，而不是立刻再发一份
    const second = client.downloadFile("fid-same").then(
      (buffer) => ({ ok: true as const, body: new TextDecoder().decode(buffer) }),
      (error) => ({ ok: false as const, error })
    );
    await delay(60);
    // 改前：第二次调用立刻进入 hop2 → maxCdnActive 变成 2
    expect(maxCdnActive).toBe(1);

    releaseFirst();
    const secondOutcome = await Promise.race([
      second,
      delay(1500).then(() => ({ ok: "watchdog" as const })),
    ]);
    expect(secondOutcome.ok).not.toBe("watchdog");
    expect(secondOutcome.ok).toBe(true);
    if (secondOutcome.ok === true) expect(secondOutcome.body).toBe("second-body");
    expect(maxCdnActive).toBe(1);
    expect(hop2Count).toBe(2);
  });
});
