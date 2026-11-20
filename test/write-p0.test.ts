/**
 * 只读写失败 → 回滚（0.2.8）：
 *
 * 用户原话：「不应该是保存失败就回滚掉吗？然后就可以操作其他文件了」。
 * 策略：
 *   ① 12 个写方法**仍 reject `ReadOnlyError`**（不假装成功）；
 *   ② 拒绝前回调 `onReadonlyWrite`，main 用它把该笔记的视图按云端内容重载（回滚）；
 *   ③ 同一 path **10 秒内只回滚一次、只提示一次**（防抖，防止回滚触发的加载又触发写）。
 */

import { describe, expect, test } from "bun:test";

import {
  QuarkReadOnlyAdapter,
  createReadonlyRollback,
} from "../src/adapter/QuarkReadOnlyAdapter";
import type { ReadonlyRollbackLeaf } from "../src/adapter/QuarkReadOnlyAdapter";
import { ReadOnlyError } from "../src/adapter/readonlyError";

function makeAdapter(options: { onReadonlyWrite?: (info: { operation: string; path: string }) => void } = {}) {
  return new QuarkReadOnlyAdapter({
    index: {
      entries: [
        { path: "notes/a.md", type: "file", fid: "fa", parentFid: "0", size: 3, mtime: 1 },
      ],
    },
    cache: {
      has: () => false,
      get: () => null,
      getResourceUrl: "",
      put: () => ({ cached: true }),
      enqueuePrefetch: () => undefined,
    },
    client: { downloadFile: async () => new TextEncoder().encode("abc").buffer as ArrayBuffer },
    baseAdapter: {} as never,
    onReadonlyWrite: options.onReadonlyWrite,
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
  { name: "process", invoke: (adapter) => adapter.process("notes/a.md", (text) => `${text}-x`) },
  { name: "mkdir", invoke: (adapter) => adapter.mkdir("notes/new-dir") },
  { name: "trashSystem", invoke: (adapter) => adapter.trashSystem("notes/a.md") },
  { name: "trashLocal", invoke: (adapter) => adapter.trashLocal("notes/a.md") },
  { name: "rmdir", invoke: (adapter) => adapter.rmdir("notes/dir", true) },
  { name: "remove", invoke: (adapter) => adapter.remove("notes/a.md") },
  { name: "rename", invoke: (adapter) => adapter.rename("notes/a.md", "notes/b.md") },
  { name: "copy", invoke: (adapter) => adapter.copy("notes/a.md", "notes/c.md") },
];

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

describe("写失败 → 回滚视图（0.2.8）", () => {
  test("12 个写方法仍 reject ReadOnlyError（不假装成功）", async () => {
    expect(WRITE_CALLS.length).toBe(12);
    for (const { name, invoke } of WRITE_CALLS) {
      const adapter = makeAdapter();
      let pending: Promise<unknown> | undefined;
      expect(() => {
        pending = invoke(adapter);
      }).not.toThrow();
      expect(pending).toBeInstanceOf(Promise);
      let caught: unknown = null;
      try {
        await pending;
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ReadOnlyError);
      expect((caught as ReadOnlyError).operation).toBe(name);
    }
  });

  test("写失败 → 回滚：setViewState 调 1 次，onRollback reloaded=true", async () => {
    const leaf = makeLeaf("notes/a.md");
    const rollbacks: Array<{ path: string; reloaded: boolean }> = [];
    const notices: string[] = [];
    const rollback = createReadonlyRollback({
      workspace: { iterateAllLeaves: (callback) => callback(leaf) },
      onRollback: (info) => {
        rollbacks.push({ path: info.path, reloaded: info.reloaded });
        if (info.reloaded) notices.push("只读库：该文件已回滚到云端版本（修改未保存）");
      },
    });
    const adapter = makeAdapter({ onReadonlyWrite: rollback });
    await expect(adapter.write("notes/a.md", "x")).rejects.toBeInstanceOf(ReadOnlyError);
    expect(leaf.setViewStateCalls).toBe(1);
    expect(rollbacks).toEqual([{ path: "notes/a.md", reloaded: true }]);
    expect(notices.length).toBe(1);
  });

  test("同一 path 连续 5 次失败：只回滚 1 次、只提示 1 次（10s 防抖）", async () => {
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
    const adapter = makeAdapter({ onReadonlyWrite: rollback });
    for (let i = 0; i < 5; i += 1) {
      await expect(adapter.write("notes/a.md", `v${i}`)).rejects.toBeInstanceOf(ReadOnlyError);
    }
    expect(leaf.setViewStateCalls).toBe(1);
    expect(rollbackCalls).toBe(1);
    expect(noticeCount).toBe(1);
  });

  test("10 秒后允许再次回滚（注入时钟）；不同 path 各自独立", () => {
    let now = 0;
    const leafA = makeLeaf("notes/a.md");
    const leafB = makeLeaf("notes/b.md");
    const rollback = createReadonlyRollback({
      workspace: { iterateAllLeaves: (callback) => [leafA, leafB].forEach(callback) },
      now: () => now,
    });
    rollback({ operation: "write", path: "notes/a.md" });
    rollback({ operation: "write", path: "notes/a.md" });
    expect(leafA.setViewStateCalls).toBe(1);
    now = 5_000; // 10s 内 → 不再回滚
    rollback({ operation: "write", path: "notes/a.md" });
    expect(leafA.setViewStateCalls).toBe(1);
    now = 10_000; // 满 10s → 允许再次回滚
    rollback({ operation: "write", path: "notes/a.md" });
    expect(leafA.setViewStateCalls).toBe(2);
    // 另一个 path 不受影响
    rollback({ operation: "write", path: "notes/b.md" });
    expect(leafB.setViewStateCalls).toBe(1);
  });

  test("找不到打开着的视图（后台保存）：只回调日志（reloaded=false），不重载", () => {
    const other = makeLeaf("notes/other.md");
    const rollbacks: Array<{ path: string; reloaded: boolean }> = [];
    const rollback = createReadonlyRollback({
      workspace: { iterateAllLeaves: (callback) => callback(other) },
      onRollback: (info) => rollbacks.push({ path: info.path, reloaded: info.reloaded }),
    });
    rollback({ operation: "write", path: "notes/a.md" });
    expect(other.setViewStateCalls).toBe(0);
    expect(rollbacks).toEqual([{ path: "notes/a.md", reloaded: false }]);
  });

  test("日志内容：`rollback cause=readonly`（stage=write, level=info）", () => {
    const lines: Array<{ stage: string; message: string; level?: string }> = [];
    const rollback = createReadonlyRollback({
      workspace: { iterateAllLeaves: (callback) => callback(makeLeaf("notes/a.md")) },
      onRollback: ({ path }) => {
        lines.push({ stage: "write", message: "rollback cause=readonly", level: "info", path } as never);
      },
    });
    rollback({ operation: "write", path: "notes/a.md" });
    expect(lines[0].stage).toBe("write");
    expect(lines[0].level).toBe("info");
    expect(lines[0].message).toBe("rollback cause=readonly");
  });
});
