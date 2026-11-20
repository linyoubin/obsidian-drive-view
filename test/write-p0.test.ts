/**
 * P0 回归（0.2.7 真机「文件保存失败 / undefined is not an object (evaluating 'o.then')」）：
 *
 * `DataAdapter` 的写方法签名全是 Promise，Obsidian 拿到返回值会直接 `.then()`。
 * 本测试逐个覆盖 12 个写方法，硬性要求：
 *   ① 调用时**绝不同步抛异常**（`expect(fn).not.toThrow()`）；
 *   ② 返回值是 **Promise**（有 `.then`）；
 *   ③ `await` 后 reject 且 `instanceof ReadOnlyError`。
 */

import { describe, expect, test } from "bun:test";

import { QuarkReadOnlyAdapter } from "../src/adapter/QuarkReadOnlyAdapter";
import { ReadOnlyError } from "../src/adapter/readonlyError";

function makeAdapter(): QuarkReadOnlyAdapter {
  return new QuarkReadOnlyAdapter({
    index: { entries: [] },
    cache: {
      has: () => false,
      get: () => null,
      getResourceUrl: () => "",
      put: () => ({ cached: true }),
      enqueuePrefetch: () => undefined,
    },
    client: { downloadFile: async () => new ArrayBuffer(0) },
    baseAdapter: {} as never,
  });
}

interface WriteCall {
  name: string;
  invoke: (adapter: QuarkReadOnlyAdapter) => Promise<unknown>;
}

const WRITE_CALLS: WriteCall[] = [
  { name: "write", invoke: (adapter) => adapter.write("notes/a.md", "content") },
  { name: "writeBinary", invoke: (adapter) => adapter.writeBinary("notes/a.md", new ArrayBuffer(4)) },
  { name: "append", invoke: (adapter) => adapter.append("notes/a.md", "+line") },
  { name: "appendBinary", invoke: (adapter) => adapter.appendBinary("notes/a.md", new ArrayBuffer(4)) },
  { name: "process", invoke: (adapter) => adapter.process("notes/a.md", (text) => text) },
  { name: "mkdir", invoke: (adapter) => adapter.mkdir("notes/new-dir") },
  { name: "trashSystem", invoke: (adapter) => adapter.trashSystem("notes/a.md") },
  { name: "trashLocal", invoke: (adapter) => adapter.trashLocal("notes/a.md") },
  { name: "rmdir", invoke: (adapter) => adapter.rmdir("notes/dir", true) },
  { name: "remove", invoke: (adapter) => adapter.remove("notes/a.md") },
  { name: "rename", invoke: (adapter) => adapter.rename("notes/a.md", "notes/b.md") },
  { name: "copy", invoke: (adapter) => adapter.copy("notes/a.md", "notes/c.md") },
];

describe("P0：12 个写方法必须返回 rejected Promise（绝不同步抛）", () => {
  test("逐个方法：调用不抛 + 返回 Promise（有 .then）+ await 后 reject ReadOnlyError", async () => {
    expect(WRITE_CALLS.length).toBe(12);
    for (const { name, invoke } of WRITE_CALLS) {
      const adapter = makeAdapter();
      let pending: Promise<unknown> | undefined;
      expect(() => {
        pending = invoke(adapter);
      }).not.toThrow();
      expect(pending).toBeInstanceOf(Promise);
      expect(typeof (pending as Promise<unknown>).then).toBe("function");
      await expect(pending as Promise<unknown>).rejects.toBeInstanceOf(ReadOnlyError);
      expect(name.length).toBeGreaterThan(0);
    }
  });

  test("ReadOnlyError 仍带 operation 与 path（错误信息可用）", async () => {
    const adapter = makeAdapter();
    let pending: Promise<unknown> | undefined;
    expect(() => {
      pending = adapter.write("/notes/a.md", "x");
    }).not.toThrow();
    try {
      await pending;
      throw new Error("should not resolve");
    } catch (error) {
      expect(error).toBeInstanceOf(ReadOnlyError);
      expect((error as ReadOnlyError).operation).toBe("write");
      expect((error as ReadOnlyError).path).toBe("notes/a.md");
      expect((error as ReadOnlyError).message).toContain("只读");
    }
  });

  test("读方法与同步方法也返回正确形状（不被 P0 修复波及）", async () => {
    const adapter = makeAdapter();
    expect(adapter.getName()).toBe("quark-readonly");
    expect(typeof adapter.getResourcePath("")).toBe("string");
    for (const pending of [
      adapter.exists("notes/a.md"),
      adapter.stat("notes/a.md"),
      adapter.list(""),
      adapter.read("notes/a.md").catch(() => null),
      adapter.readBinary("notes/a.md").catch(() => null),
    ]) {
      expect(pending).toBeInstanceOf(Promise);
      expect(typeof (pending as Promise<unknown>).then).toBe("function");
      await pending;
    }
  });

  test("`.obsidian/**` 转发分支仍是 base adapter 的 Promise（不是 reject）", async () => {
    const adapter = new QuarkReadOnlyAdapter({
      index: { entries: [] },
      cache: {
        has: () => false,
        get: () => null,
        getResourceUrl: () => "",
        put: () => ({ cached: true }),
        enqueuePrefetch: () => undefined,
      },
      client: { downloadFile: async () => new ArrayBuffer(0) },
      baseAdapter: {
        write: async () => undefined,
        mkdir: async () => undefined,
      } as never,
    });
    await expect(adapter.write(".obsidian/config.json", "{}")).resolves.toBeUndefined();
    await expect(adapter.mkdir(".obsidian/plugins/x")).resolves.toBeUndefined();
  });
});
