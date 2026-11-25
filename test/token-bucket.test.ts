/**
 * 0.2.19 SF1：令牌桶并发安全——并发 `acquire()` 不得读到同一个 `now` 后集体放行。
 *
 * 改前实测：3 req/s 的桶在 10 并发下，9 个调用都算出同一个 ~334ms 等待，
 * 于是同一时刻集体通过（≈30 req/s），真机表现为同步时请求风暴。
 *
 * 断言口径（真实计时）：10 并发、3 req/s、burst=1
 *   - 第 1 秒（取 900ms 窗口避免边界抖动）内放行数 ≤ 3；
 *   - 全部完成的总耗时 ≥ 2s（rate=3/s 的排队下界）。
 */

import { describe, expect, test } from "bun:test";

import { TokenBucket } from "../src/client/QuarkClient";

describe("0.2.19 SF1 令牌桶并发串行排队", () => {
  test("10 并发（3 req/s, burst=1）：1 秒窗口内放行 ≤3，总耗时 ≥2s", async () => {
    const rate = 3;
    const bucket = new TokenBucket({ ratePerSecond: rate, burst: 1 });
    const startedAt = Date.now();
    const completedAt: number[] = [];

    await Promise.all(
      Array.from({ length: 10 }, async () => {
        await bucket.acquire();
        completedAt.push(Date.now() - startedAt);
      })
    );

    const withinFirstSecond = completedAt.filter((elapsed) => elapsed < 900).length;
    const totalMs = Math.max(...completedAt);

    // 改前：9 个调用同一时刻（~334ms）集体放行 → 10
    expect(withinFirstSecond).toBeLessThanOrEqual(3);
    // 10 个请求按 3/s 排队，最后一个不可能在 2 秒内完成
    expect(totalMs).toBeGreaterThanOrEqual(2000);
    expect(bucket.totalWaitedMs).toBeGreaterThan(0);
  }, 20000);
});
