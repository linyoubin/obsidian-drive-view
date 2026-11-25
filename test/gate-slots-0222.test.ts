/**
 * 0.2.22 M1/M3/M4：调度器三个回归。
 *
 * M1：`failAuth` 漏清 `backgroundUserQueue` → 401 后 bg-user 任务悬挂（pending 不归零）；
 * M3：预取满额时 `pump()` 直接 return → 空槽与 bulk 一起被丢掉（active 上不去）；
 * M4：bg-user 仍受 lowCap（concurrency-1）限制 → 其它三类占满 lowCap 时用户附件要等。
 *
 * 全部用「占住槽位的悬挂任务」复现真机探针场景。
 */

import { describe, expect, test } from "bun:test";

import { DownloadGate } from "../src/client/downloadGate";

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

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("waitFor timeout");
    await delay(5);
  }
}

/** 永不结束的任务（占住槽位）。 */
function hanging(): Promise<void> {
  return new Promise<void>(() => {
    /* 永不 settle */
  });
}

describe("0.2.22 M1 failAuth 清 backgroundUserQueue", () => {
  test("pauseBulk + 预取占槽 + 401 → bg-user 任务立即收到 auth-expired（不等其它任务 settle）", async () => {
    const gate = new DownloadGate({ concurrency: 1, now: () => 0 });
    // 预取占住唯一槽位（lowCap=1），bulk 被 pauseBulk 挡住，bg-user 只能排队
    void gate.run(hanging, { priority: "background" }).catch(() => undefined);
    gate.pauseBulk(3000);
    const bulk = gate.run(async () => "bulk", { priority: "bulk" }).then(
      () => "resolved",
      (error) => error
    );
    const user = gate.run(async () => "user", { priority: "background-user" }).then(
      () => "resolved",
      (error) => error
    );
    const queuedPrefetch = gate.run(async () => "bg", { priority: "background" }).then(
      () => "resolved",
      (error) => error
    );
    await delay(5);
    expect(gate.pending).toBe(3);

    gate.failAuth(1000);
    expect(gate.pending).toBe(0);

    // 不等任何任务 settle：bg-user 必须立刻被拒
    const outcome = await Promise.race([user, delay(150).then(() => "still-pending")]);
    expect(outcome).not.toBe("still-pending");
    expect(outcome).toMatchObject({ kind: "auth-expired" });
    await expect(bulk).resolves.toMatchObject({ kind: "auth-expired" });
    await expect(queuedPrefetch).resolves.toMatchObject({ kind: "auth-expired" });
  });
});

describe("0.2.22 M3 预取满额不丢 bulk 的空闲槽位", () => {
  test("1 预取在途 + 1 预取排队 + 2 bulk 排队 → active 涨到 lowCap（3），bulk 起步", async () => {
    const gate = new DownloadGate({ concurrency: 4 });
    // 预取：第 1 个占住预取额度（cap=1），第 2 个只能排队
    void gate.run(hanging, { priority: "background" }).catch(() => undefined);
    const queuedPrefetch = gate.run(hanging, { priority: "background" }).catch(() => undefined);
    // 2 个 bulk（bulkLimit=2）在等
    void gate.run(hanging, { priority: "bulk" }).catch(() => undefined);
    void gate.run(hanging, { priority: "bulk" }).catch(() => undefined);

    await waitFor(() => gate.active >= 3, 1000);

    expect(gate.active).toBe(3); // lowCap=3
    expect(gate.backgroundActiveCount).toBe(1);
    expect(gate.bulkActiveCount).toBe(2);
    expect(gate.backgroundActiveCount + gate.bulkActiveCount).toBe(3);
    expect(gate.pending).toBe(1); // 只剩排队的预取
    void queuedPrefetch;
  });
});

describe("0.2.22 M4 bg-user 可用满 concurrency", () => {
  test("2 bulk + 1 预取占满 lowCap 时，用户点开的附件仍立刻起步", async () => {
    const gate = new DownloadGate({ concurrency: 4 });
    void gate.run(hanging, { priority: "background" }).catch(() => undefined);
    void gate.run(hanging, { priority: "bulk" }).catch(() => undefined);
    void gate.run(hanging, { priority: "bulk" }).catch(() => undefined);
    await waitFor(() => gate.active === 3, 1000);
    expect(gate.active).toBe(3);

    const release = deferred<void>();
    let startedAtMs = 0;
    const startedBefore = Date.now();
    const user = gate.run(
      async () => {
        startedAtMs = Date.now();
        await release.promise;
      },
      { priority: "background-user" }
    );
    await waitFor(() => gate.backgroundUserActiveCount === 1, 1000);
    expect(startedAtMs - startedBefore).toBeLessThan(200); // 不再等别的任务 settle
    expect(gate.active).toBe(4);

    release.resolve();
    await user.catch(() => undefined);
  });
});
