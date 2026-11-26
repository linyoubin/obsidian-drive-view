/**
 * 0.2.25：写操作静默成功（resolve）+ 主动回滚 + 一次性提示。
 *
 * 0.2.24 之前的 reject 会让 Obsidian 自己弹「文件保存失败」，重试一次弹一次；
 * 现在 12 个写方法对虚拟库路径一律 resolve（不假装写成功，但也不让 Obsidian 报错），
 * 由 `onReadonlyWrite` 把视图回滚到云端版本并只提示一次。
 *
 * `.obsidian/**` 与插件目录仍转发给 base adapter（真写本地），不回滚、不 no-op。
 */

import { describe, expect, test } from "bun:test";

import {
  QuarkReadOnlyAdapter,
  createReadonlyRollback,
} from "../src/adapter/QuarkReadOnlyAdapter";
import type { ReadonlyRollbackLeaf } from "../src/adapter/QuarkReadOnlyAdapter";

interface DiagEntry {
  level?: string;
  stage?: string;
  path?: string;
  message?: string;
  cause?: string;
}

interface BaseCall {
  name: string;
  args: unknown[];
}

function makeAdapter(
  options: {
    onReadonlyWrite?: (info: { operation: string; path: string }) => void;
    diag?: (entry: DiagEntry) => void;
  } = {}
) {
  const baseCalls: BaseCall[] = [];
  const base = {
    write: async (...args: unknown[]) => {
      baseCalls.push({ name: "write", args });
    },
    writeBinary: async (...args: unknown[]) => {
      baseCalls.push({ name: "writeBinary", args });
    },
    append: async (...args: unknown[]) => {
      baseCalls.push({ name: "append", args });
    },
    appendBinary: async (...args: unknown[]) => {
      baseCalls.push({ name: "appendBinary", args });
    },
    process: async (_path: string, fn: (data: string) => string) => {
      baseCalls.push({ name: "process", args: [] });
      return fn("BASE");
    },
    mkdir: async (...args: unknown[]) => {
      baseCalls.push({ name: "mkdir", args });
    },
    rmdir: async (...args: unknown[]) => {
      baseCalls.push({ name: "rmdir", args });
    },
    remove: async (...args: unknown[]) => {
      baseCalls.push({ name: "remove", args });
    },
    rename: async (...args: unknown[]) => {
      baseCalls.push({ name: "rename", args });
    },
    copy: async (...args: unknown[]) => {
      baseCalls.push({ name: "copy", args });
    },
    trashSystem: async () => true,
    trashLocal: async () => undefined,
  };
  const adapter = new QuarkReadOnlyAdapter({
    index: {
      entries: [{ path: "notes/a.md", type: "file", fid: "fa", parentFid: "", size: 3, mtime: 1 }],
    },
    cache: {
      has: () => false,
      get: () => null,
      getResourceUrl: "",
      put: () => ({ cached: true }),
      enqueuePrefetch: () => undefined,
    },
    client: { downloadFile: async () => new TextEncoder().encode("abc").buffer as ArrayBuffer },
    baseAdapter: base as never,
    onReadonlyWrite: options.onReadonlyWrite,
    diag: options.diag as never,
  });
  return { adapter, baseCalls };
}

interface FakeLeaf extends ReadonlyRollbackLeaf {
  setViewStateCalls: number;
}

function makeLeaf(path: string): FakeLeaf {
  const leaf: FakeLeaf = {
    view: { file: { path } },
    setViewStateCalls: 0,
    getViewState: () => ({ type: "markdown", state: { file: path } }),
    setViewState: async () => {
      leaf.setViewStateCalls += 1;
    },
  };
  return leaf;
}

const WRITE_CALLS: Array<{
  name: string;
  invoke: (adapter: QuarkReadOnlyAdapter) => Promise<unknown>;
  expected: "void" | "true" | "string";
}> = [
  { name: "write", invoke: (adapter) => adapter.write("notes/a.md", "content"), expected: "void" },
  { name: "writeBinary", invoke: (adapter) => adapter.writeBinary("notes/a.md", new ArrayBuffer(4)), expected: "void" },
  { name: "append", invoke: (adapter) => adapter.append("notes/a.md", "+line"), expected: "void" },
  { name: "appendBinary", invoke: (adapter) => adapter.appendBinary("notes/a.md", new ArrayBuffer(4)), expected: "void" },
  { name: "process", invoke: (adapter) => adapter.process("notes/a.md", (text) => `${text}-x`), expected: "string" },
  { name: "mkdir", invoke: (adapter) => adapter.mkdir("notes/new-dir"), expected: "void" },
  { name: "trashSystem", invoke: (adapter) => adapter.trashSystem("notes/a.md"), expected: "true" },
  { name: "trashLocal", invoke: (adapter) => adapter.trashLocal("notes/a.md"), expected: "void" },
  { name: "rmdir", invoke: (adapter) => adapter.rmdir("notes/dir", true), expected: "void" },
  { name: "remove", invoke: (adapter) => adapter.remove("notes/a.md"), expected: "void" },
  { name: "rename", invoke: (adapter) => adapter.rename("notes/a.md", "notes/b.md"), expected: "void" },
  { name: "copy", invoke: (adapter) => adapter.copy("notes/a.md", "notes/c.md"), expected: "void" },
];

describe("0.2.25 写方法静默成功", () => {
  test("12 个写方法逐个 resolve（不 reject），返回类型符合契约", async () => {
    expect(WRITE_CALLS.length).toBe(12);
    for (const { name, invoke, expected } of WRITE_CALLS) {
      const { adapter } = makeAdapter();
      let value: unknown = "not-called";
      let caught: unknown = null;
      try {
        const pending = invoke(adapter);
        expect(pending, name).toBeInstanceOf(Promise);
        value = await pending;
      } catch (error) {
        caught = error;
      }
      expect(caught, `${name} 不得 reject`).toBeNull();
      if (expected === "void") expect(value, `${name} 必须 resolve undefined`).toBeUndefined();
      if (expected === "true") expect(value, `${name} 必须 resolve true`).toBe(true);
      if (expected === "string") {
        // process 只读：返回**原始内容**（不执行 fn、不写回）
        expect(value).toBe("abc");
      }
    }
  });

  test("写一次 → 触发回滚：假 leaf 的 setViewState 调 1 次", async () => {
    const leaf = makeLeaf("notes/a.md");
    const rollbacks: Array<{ path: string; reloaded: boolean }> = [];
    const rollback = createReadonlyRollback({
      workspace: { iterateAllLeaves: (callback) => callback(leaf) },
      onRollback: (info) => rollbacks.push({ path: info.path, reloaded: info.reloaded }),
    });
    const { adapter } = makeAdapter({ onReadonlyWrite: rollback });

    await expect(adapter.write("notes/a.md", "x")).resolves.toBeUndefined();

    expect(leaf.setViewStateCalls).toBe(1);
    expect(rollbacks).toEqual([{ path: "notes/a.md", reloaded: true }]);
  });

  test("同 path 10s 内连写 5 次：只回滚 1 次、只提示 1 次", async () => {
    const leaf = makeLeaf("notes/a.md");
    let rollbackCalls = 0;
    let noticeCount = 0;
    const rollback = createReadonlyRollback({
      workspace: { iterateAllLeaves: (callback) => callback(leaf) },
      onRollback: ({ reloaded }) => {
        rollbackCalls += 1;
        if (reloaded) noticeCount += 1;
      },
    });
    const { adapter } = makeAdapter({ onReadonlyWrite: rollback });

    for (let index = 0; index < 5; index += 1) {
      await expect(adapter.write("notes/a.md", `v${index}`)).resolves.toBeUndefined();
    }

    expect(leaf.setViewStateCalls).toBe(1);
    expect(rollbackCalls).toBe(1);
    expect(noticeCount).toBe(1);
  });

  test(".obsidian 路径仍转发 base adapter 真写：不回滚、不 no-op 日志", async () => {
    const leaf = makeLeaf(".obsidian/app.json");
    let rollbackCalls = 0;
    const diag: DiagEntry[] = [];
    const rollback = createReadonlyRollback({
      workspace: { iterateAllLeaves: (callback) => callback(leaf) },
      onRollback: () => {
        rollbackCalls += 1;
      },
    });
    const { adapter, baseCalls } = makeAdapter({
      onReadonlyWrite: rollback,
      diag: (entry) => diag.push(entry),
    });

    await expect(adapter.write(".obsidian/app.json", "{}")).resolves.toBeUndefined();

    expect(baseCalls.map((call) => call.name)).toEqual(["write"]);
    expect(baseCalls[0].args[0]).toBe(".obsidian/app.json");
    expect(leaf.setViewStateCalls).toBe(0);
    expect(rollbackCalls).toBe(0);
    expect(diag).toEqual([]);
  });

  test("日志：stage=write msg=readonly-noop cause=readonly，且不含正文", async () => {
    const diag: DiagEntry[] = [];
    const { adapter } = makeAdapter({ diag: (entry) => diag.push(entry) });
    const secret = "SECRET-BODY-绝不进日志";

    await expect(adapter.write("notes/a.md", secret)).resolves.toBeUndefined();

    const entry = diag.find((item) => item.stage === "write");
    expect(entry).toBeDefined();
    expect(entry!.level).toBe("info");
    expect(entry!.message).toBe("readonly-noop");
    expect(entry!.cause).toBe("readonly");
    expect(entry!.path).toBe("notes/a.md");
    expect(JSON.stringify(diag)).not.toContain(secret);
    expect(JSON.stringify(diag)).not.toContain("SECRET");
  });
});
