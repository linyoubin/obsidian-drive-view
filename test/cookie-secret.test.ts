/**
 * 0.2.15：secretStorage-only 凭据存储 + 历史明文清理 + 登录后分支。
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  CookieStore,
  migrateLegacyCookieData,
  sanitizeSecretId,
  DEFAULT_COOKIE_STORAGE_KEY,
} from "../src/auth/CookieStore";
import { decideAfterLogin } from "../src/auth/loginDecision";

describe("sanitizeSecretId（0.2.15）", () => {
  test("冒号/大写/空格/中文/超长/空串 → 始终合法（小写+数字+短横线，≤64）", () => {
    const cases = [
      "Drive-View:Cookie",
      "Quark Cookie",
      "夸克-cookie",
      "a".repeat(80),
      "",
      "UPPER_case:id",
    ];
    for (const raw of cases) {
      const id = sanitizeSecretId(raw);
      expect(id).toMatch(/^[a-z0-9-]{1,64}$/);
      expect(id.startsWith("-")).toBe(false);
      expect(id.endsWith("-")).toBe(false);
    }
    expect(sanitizeSecretId("")).toBe("quark-cookie");
    expect(sanitizeSecretId("A".repeat(80)).length).toBeLessThanOrEqual(64);
  });
});

describe("CookieStore：只允许 secretStorage（0.2.15）", () => {
  function makeSecret(fail = false) {
    const calls: string[] = [];
    const secrets = new Map<string, string>();
    const secretStorage = {
      setSecret: (id: string, value: string) => {
        calls.push(`set:${id}`);
        if (fail) throw new Error("密钥 ID 无效。请仅使用小写字母、数字和破折号，最多 64 个字符。");
        secrets.set(id, value);
      },
      getSecret: (id: string) => {
        calls.push(`get:${id}`);
        return secrets.get(id) ?? null;
      },
    };
    return { secretStorage, calls, secrets };
  }

  test("保存：saveData 完全不被调用（断言 0 次）", async () => {
    const { secretStorage, secrets } = makeSecret();
    let saveDataCalls = 0;
    const store = new CookieStore({
      app: { secretStorage },
      saveData: async () => {
        saveDataCalls += 1;
      },
    });
    store.setPairs(["__pus=abc"]);
    expect(await store.save()).toBe(true);
    expect(saveDataCalls).toBe(0);
    expect(secrets.get("quark-cookie")).toContain("__pus=abc");
  });

  test("secretStorage 不可用 → 明确失败，不写文件、不刷屏", async () => {
    let saveDataCalls = 0;
    let errors = 0;
    const store = new CookieStore({
      app: {},
      saveData: async () => {
        saveDataCalls += 1;
      },
      onPersistError: () => {
        errors += 1;
      },
    });
    store.setPairs(["__pus=abc"]);
    expect(await store.save()).toBe(false);
    expect(await store.save()).toBe(false);
    expect(saveDataCalls).toBe(0);
    expect(errors).toBeLessThanOrEqual(1);
  });

  test("setSecret 报错 → 失败且不再重试（setSecret 调用 1 次）", async () => {
    const { secretStorage, calls } = makeSecret(true);
    const store = new CookieStore({ app: { secretStorage } });
    store.setPairs(["__pus=abc"]);
    expect(await store.save()).toBe(false);
    expect(await store.save()).toBe(false);
    expect(calls.filter((call) => call.startsWith("set:")).length).toBe(1);
  });

  test("load 从 secretStorage 读回；Store 重启后能恢复", async () => {
    const { secretStorage, secrets } = makeSecret();
    const first = new CookieStore({ app: { secretStorage } });
    first.setPairs(["__pus=persisted"]);
    await first.save();
    expect(secrets.get("quark-cookie")).toContain("__pus=persisted");
    const second = new CookieStore({ app: { secretStorage } });
    expect(await second.load()).toBe(true);
    expect(second.getHeader()).toContain("__pus=persisted");
  });

  test("历史 data.json 明文 cookie 字段被移除", () => {
    const fixture = { [DEFAULT_COOKIE_STORAGE_KEY]: "__pus=legacy", other: 1 };
    const { data, removed } = migrateLegacyCookieData(fixture);
    expect(removed).toBe(true);
    expect(data[DEFAULT_COOKIE_STORAGE_KEY]).toBeUndefined();
    expect(data.other).toBe(1);
    expect(migrateLegacyCookieData({ other: 1 }).removed).toBe(false);
  });
});

describe("登录后分支（0.2.14）", () => {
  test("有快照 + 库根一致 → mount（不触发同步）", () => {
    expect(decideAfterLogin({ indexCount: 1064, rootChosen: true, rootMatches: true })).toBe("mount");
  });

  test("无快照 → choose-root/confirm", () => {
    expect(decideAfterLogin({ indexCount: 0, rootChosen: false, rootMatches: true })).toBe("choose-root");
    expect(decideAfterLogin({ indexCount: 0, rootChosen: true, rootMatches: true })).toBe("confirm");
  });

  test("有快照但库根变化 → rebuild", () => {
    expect(decideAfterLogin({ indexCount: 12, rootChosen: true, rootMatches: false })).toBe("rebuild");
  });
});

describe("manifest（0.2.15）", () => {
  test("minAppVersion = 1.11.4", () => {
    const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
    expect(manifest.minAppVersion).toBe("1.11.4");
  });
});
