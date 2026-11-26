/**
 * 只读写的「静默成功 → 回滚」策略（0.2.8 引入回滚，0.2.25 改为不 reject）。
 *
 * 用户原话：「不应该是保存失败就回滚掉吗？然后就可以操作其他文件了」。
 * 0.2.25 追加：写方法必须 resolve，否则 Obsidian 自己弹「文件保存失败」、每次重试再弹一次。
 *
 * 这里只测 `createReadonlyRollback` 的防抖/匹配（adapter 集成见 `write-silent.test.ts`）：
 *   - 同一 path `windowMs`（默认 10s）内只回滚一次、只提示一次；
 *   - 找不到打开着的视图（后台保存）→ `reloaded=false`，不重载；
 *   - 不同 path 各自独立。
 */

import { describe, expect, test } from "bun:test";

import { createReadonlyRollback } from "../src/adapter/QuarkReadOnlyAdapter";
import type { ReadonlyRollbackLeaf } from "../src/adapter/QuarkReadOnlyAdapter";

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

describe("只读写回滚：createReadonlyRollback 防抖", () => {
  test("写一次 → 回滚 1 次，reloaded=true", () => {
    const leaf = makeLeaf("notes/a.md");
    const rollbacks: Array<{ path: string; reloaded: boolean }> = [];
    const rollback = createReadonlyRollback({
      workspace: { iterateAllLeaves: (callback) => callback(leaf) },
      onRollback: (info) => rollbacks.push({ path: info.path, reloaded: info.reloaded }),
    });

    rollback({ operation: "write", path: "notes/a.md" });

    expect(leaf.setViewStateCalls).toBe(1);
    expect(rollbacks).toEqual([{ path: "notes/a.md", reloaded: true }]);
  });

  test("同一 path 连续 5 次写：只回滚 1 次、只提示 1 次（10s 防抖）", () => {
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

    for (let index = 0; index < 5; index += 1) {
      rollback({ operation: "write", path: "notes/a.md" });
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

  test("找不到打开着的视图（后台保存）：reloaded=false，不重载、不提示", () => {
    const other = makeLeaf("notes/other.md");
    const rollbacks: Array<{ path: string; reloaded: boolean }> = [];
    let noticeCount = 0;
    const rollback = createReadonlyRollback({
      workspace: { iterateAllLeaves: (callback) => callback(other) },
      onRollback: (info) => {
        rollbacks.push({ path: info.path, reloaded: info.reloaded });
        if (info.reloaded) noticeCount += 1;
      },
    });

    rollback({ operation: "write", path: "notes/a.md" });

    expect(other.setViewStateCalls).toBe(0);
    expect(rollbacks).toEqual([{ path: "notes/a.md", reloaded: false }]);
    expect(noticeCount).toBe(0);
  });
});
