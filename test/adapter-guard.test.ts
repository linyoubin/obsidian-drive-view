/**
 * 0.2.23 P0 诊断：adapter 调用埋点与未知成员 Proxy 兜底。
 *
 * 现场 `writeData` 里 `undefined.then` 崩：有成员返回/被当成 undefined。
 * 审计（见回执表）没找到漏 return → 按预案做两层防护：
 *   ① 运行期埋点：21 个方法包一层，返回 undefined 时记 `name/ret/args`（warn）；
 *   ② Proxy 兜底：未知成员返回「返回 rejected Promise 的函数」并记 `state=unknown-member`，
 *      其它未知属性回落 base adapter —— 任何情况下不再把 undefined 交给 Obsidian。
 */

import { describe, expect, test } from "bun:test";

import {
  DATA_ADAPTER_METHOD_NAMES,
  createObsidianAdapterProxy,
  wrapAdapterCalls,
} from "../src/adapter/QuarkReadOnlyAdapter";

interface CallLog {
  name: string;
  ret: string;
  args: number;
}

describe("0.2.23 adapter 调用埋点", () => {
  test("桩方法返回 undefined → 记 warn（name/ret/args），且不再把 undefined 交给调用方", async () => {
    const logs: CallLog[] = [];
    const stub = {
      write: () => undefined as unknown,
      read: async () => "ok",
      getName: () => "quark-test",
    };
    const wrapped = wrapAdapterCalls(stub, (entry) => logs.push(entry));

    const result = wrapped.write("notes/a.md", "body");
    expect(logs).toEqual([{ name: "write", ret: "undefined", args: 2 }]);
    // 防护：P0 是 undefined.then；这里必须给 Promise
    expect(result).toBeInstanceOf(Promise);
    await expect(result as Promise<unknown>).rejects.toThrow(/undefined/i);

    // 正常返回值不记日志（避免日志爆炸）
    const read = wrapped.read("notes/a.md");
    expect(read).toBeInstanceOf(Promise);
    await expect(read as Promise<string>).resolves.toBe("ok");
    expect(logs).toHaveLength(1);
    expect(typeof wrapped.getName()).toBe("string");
  });

  test("21 个契约方法都在埋点名单里（防止新增方法漏包）", () => {
    expect(DATA_ADAPTER_METHOD_NAMES.length).toBe(21);
    for (const name of ["write", "writeBinary", "append", "appendBinary", "process", "trashSystem", "trashLocal", "exists", "stat", "list", "read", "readBinary"]) {
      expect(DATA_ADAPTER_METHOD_NAMES).toContain(name as never);
    }
  });
});

describe("0.2.23 未知成员 Proxy 兜底", () => {
  test("访问未定义成员并调用 → 返回 rejected Promise，日志记成员名", async () => {
    const adapter = { exists: async () => true };
    const logs: Array<{ name: string; state: string }> = [];
    const proxy = createObsidianAdapterProxy(adapter, {
      logUnknown: (entry) => logs.push(entry),
    });

    const result = (proxy as unknown as Record<string, (...args: unknown[]) => unknown>).foo("x");
    expect(result).toBeInstanceOf(Promise);
    await expect(result as Promise<unknown>).rejects.toThrow(/未知 adapter 成员.*foo/);
    expect(logs).toEqual([{ name: "foo", state: "unknown-member" }]);
  });

  test("未知属性的读取/调用不崩（adapter.writeDataX 不再 undefined.then）", async () => {
    const adapter = { read: async () => "x" };
    const proxy = createObsidianAdapterProxy(adapter);

    // 读取未知属性：拿到函数（不是 undefined），且不抛
    const writeDataX = (proxy as unknown as Record<string, unknown>).writeDataX;
    expect(typeof writeDataX).toBe("function");
    const result = (writeDataX as (...args: unknown[]) => unknown)("a", "b");
    expect(result).toBeInstanceOf(Promise);
    await expect(result as Promise<unknown>).rejects.toBeDefined();
    // 已知方法照常透传
    await expect((proxy as unknown as { read: () => Promise<string> }).read()).resolves.toBe("x");
  });

  test("未知属性存在于 base adapter → 回落到 base（不误判 unknown-member）", () => {
    const fallback = {
      getFilePath: (path: string) => `/abs/${path}`,
      someFlag: 42,
    };
    const logs: unknown[] = [];
    const proxy = createObsidianAdapterProxy(
      { getName: () => "quark" },
      { fallback, logUnknown: (entry) => logs.push(entry) }
    ) as unknown as Record<string, unknown>;

    expect((proxy.getFilePath as (path: string) => string)("a.md")).toBe("/abs/a.md");
    expect(proxy.someFlag).toBe(42);
    expect(logs).toEqual([]);
  });
});
