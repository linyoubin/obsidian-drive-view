/**
 * 0.2.17：cookie 乱序保护、401 重试一次、bulk 并发 2、熔断提示闸。
 */

import { describe, expect, test } from "bun:test";

import { CookieStore } from "../src/auth/CookieStore";
import { AuthNoticeGate } from "../src/ui/authNotice";
import { DownloadGate } from "../src/client/downloadGate";
import { QuarkClient } from "../src/client/QuarkClient";

function secretHost(): { secretStorage: { setSecret(id: string, v: string): void; getSecret(id: string): string | null }; calls: string[] } {
  const store = new Map<string, string>();
  const calls: string[] = [];
  return {
    calls,
    secretStorage: {
      setSecret: (id, value) => {
        calls.push(`set:${id}`);
        store.set(id, value);
      },
      getSecret: (id) => {
        calls.push(`get:${id}`);
        return store.get(id) ?? null;
      },
    },
  };
}

describe("0.2.17 cookie 合并单调保护", () => {
  test("乱序返回：__puus 保留最后发起请求的值，而不是最后到达的", () => {
    const host = secretHost();
    const store = new CookieStore({ app: host });
    store.setPairs(["__pus=base"]);
    // seq=3 先合并（新值）
    store.applySetCookie({ "set-cookie": ["__puus=NEW; Path=/"] }, 3);
    // seq=2 晚到（旧值）→ 必须被丢弃
    store.applySetCookie({ "set-cookie": ["__puus=OLD; Path=/"] }, 2);
    expect(store.getHeader()).toContain("__puus=NEW");
    expect(store.getHeader()).not.toContain("__puus=OLD");
  });

  test("merge 日志：seq 单调、puus 只记 8 位 hash、无明文", () => {
    const events: Array<{ seq: number; name: string; hash: string }> = [];
    const store = new CookieStore({ app: secretHost(), onCookieMerge: (e) => events.push(e) });
    store.setPairs(["__pus=base"]);
    store.applySetCookie({ "set-cookie": ["__puus=tok-one"] }, 1);
    store.applySetCookie({ "set-cookie": ["__puus=tok-two"] }, 2);
    expect(events.length).toBe(2);
    expect(events[0].hash).toMatch(/^[0-9a-f]{8}$/);
    expect(events[1].hash).toMatch(/^[0-9a-f]{8}$/);
    expect(events[0].hash).not.toBe(events[1].hash);
    expect(JSON.stringify(events)).not.toContain("tok-one");
    expect(events[1].seq).toBeGreaterThan(events[0].seq);
  });
});

describe("0.2.17 401 自动恢复一次", () => {
  test("401 → 重读 secretStorage → 重试 1 次成功（transport 调 2 次）", async () => {
    const host = secretHost();
    host.secretStorage.setSecret("quark-cookie", "__pus=ok");
    const cookieStore = new CookieStore({ app: host });
    let count = 0;
    const client = new QuarkClient({
      cookieStore,
      transport: async () => {
        count += 1;
        if (count === 1) return { status: 401, headers: {}, text: "" };
        return { status: 200, headers: {}, text: JSON.stringify({ code: 0, data: {} }) };
      },
      limiter: { acquire: async () => undefined } as never,
      sleep: async () => undefined,
    });
    const response = await client.requestRaw("https://example.test/x", { checkAuth: false });
    expect(response.status).toBe(401 === 401 ? response.status : 0);
    expect(response.status).toBe(200);
    expect(count).toBe(2);
  });

  test("一直 401 → 熔断且只提示一次（onAuthExpired 1 次）", async () => {
    const host = secretHost();
    let notified = 0;
    const client = new QuarkClient({
      cookieStore: new CookieStore({ app: host }),
      transport: async () => ({ status: 401, headers: {}, text: "" }),
      limiter: { acquire: async () => undefined } as never,
      sleep: async () => undefined,
      onAuthExpired: () => {
        notified += 1;
      },
    });
    await expect(client.requestRaw("https://example.test/a", { checkAuth: true })).rejects.toThrow();
    await expect(client.requestRaw("https://example.test/b", { checkAuth: true })).rejects.toThrow();
    expect(notified).toBe(1);
    expect(client.downloadGate.isAuthExpired()).toBe(true);
  });
});

describe("0.2.17 bulk 并发 = 2", () => {
  test("10 个 bulk、总并发 6 → bulk 峰值 ≤2", async () => {
    const gate = new DownloadGate({ concurrency: 6 });
    let active = 0;
    let peak = 0;
    const tasks = Array.from({ length: 10 }, () =>
      gate.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
      }, { priority: "bulk" })
    );
    await Promise.all(tasks);
    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe("0.2.17 熔断提示闸", () => {
  test("同一失效期只放行一次；reset 后可再次提示", () => {
    const gate = new AuthNoticeGate();
    expect(gate.shouldShow()).toBe(true);
    for (let i = 0; i < 9; i += 1) expect(gate.shouldShow()).toBe(false);
    gate.reset();
    expect(gate.shouldShow()).toBe(true);
  });
});
