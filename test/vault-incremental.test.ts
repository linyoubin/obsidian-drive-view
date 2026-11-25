/**
 * 0.2.21 N4/N5：unmount 还原必须「增量对齐」且不把退出拖慢。
 *
 * N4：先删光再重建会让挂载期间打开/未变的节点被 remove → 界面闪白。
 *     期望：只删「云端独有」、只补「本地缺失」，两边都有的不动。
 * N5：重建不能把 configDir / `.trash` 灌回 fileMap；也不做全库 `stat`（移动端卡退出）。
 */

import { describe, expect, test } from "bun:test";

import { VaultMounter } from "../src/adapter/VaultMounter";
import { makeVaultHarness, seedLocalFileMap, sortedPaths, type LocalTree } from "./vault-harness";

describe("0.2.21 N4 unmount 增量对齐", () => {
  test("两边都有的节点不被 remove；只删云端独有、只补本地缺失", async () => {
    const local: LocalTree = {
      folders: ["notes"],
      files: { "shared.md": 5, "notes/shared2.md": 6, "local-only.md": 7 },
    };
    const harness = makeVaultHarness({
      local,
      cloud: [
        { path: "shared.md", type: "file", ctime: 1, mtime: 2, size: 5 },
        { path: "notes", type: "folder" },
        { path: "notes/shared2.md", type: "file", ctime: 1, mtime: 2, size: 6 },
        { path: "cloud-only.md", type: "file", ctime: 1, mtime: 2, size: 8 },
      ],
    });
    seedLocalFileMap(harness, local);
    const before = sortedPaths(harness);

    const mounter = new VaultMounter(harness.app as never);
    await mounter.mount(harness.mountable as never);
    harness.stats.events.length = 0; // 只看 unmount 期间的事件

    await mounter.unmount(harness.mountable as never);
    const events = harness.stats.events;

    // 云端独有 → 删掉
    expect(events).toContain("file-removed:cloud-only.md");
    // 两边都有 → 不删（改前「先删光」会 remove 它们 → 闪白）
    expect(events).not.toContain("file-removed:shared.md");
    expect(events).not.toContain("file-removed:notes/shared2.md");
    expect(events).not.toContain("folder-removed:notes");
    expect(events).not.toContain("folder-removed:shared.md");
    // 本地缺失 → 补回来
    expect(events.some((event) => event === "raw:local-only.md" || event === "file-created:local-only.md")).toBe(
      true
    );
    expect(sortedPaths(harness)).toEqual(before);
  });
});

describe("0.2.21 N5 重建过滤 configDir/.trash 且不做全库 stat", () => {
  test("configDir='.obsidian' → fileMap 不含 .obsidian/** 与 .trash/**，unmount 期间 stat 0 次", async () => {
    const local: LocalTree = {
      folders: [".obsidian", ".obsidian/plugins", ".trash", "notes"],
      files: {
        ".obsidian/app.json": 1,
        ".obsidian/plugins/x.json": 2,
        ".trash/gone.md": 3,
        "notes/a.md": 4,
      },
    };
    const harness = makeVaultHarness({
      local,
      configDir: ".obsidian",
      cloud: [
        { path: "notes", type: "folder" },
        { path: "notes/a.md", type: "file", ctime: 1, mtime: 2, size: 4 },
      ],
    });
    seedLocalFileMap(harness, local);

    const mounter = new VaultMounter(harness.app as never);
    await mounter.mount(harness.mountable as never);
    harness.stats.statCalls.length = 0;
    harness.stats.listCalls.length = 0;

    await mounter.unmount(harness.mountable as never);

    const paths = Object.keys(harness.fileMap);
    expect(paths.some((path) => path === ".obsidian" || path.startsWith(".obsidian/"))).toBe(false);
    expect(paths.some((path) => path === ".trash" || path.startsWith(".trash/"))).toBe(false);
    // 配置目录/回收站不递归
    expect(harness.stats.listCalls.some((dir) => dir === ".obsidian" || dir.startsWith(".obsidian/"))).toBe(
      false
    );
    expect(harness.stats.listCalls.some((dir) => dir === ".trash" || dir.startsWith(".trash/"))).toBe(false);
    // 移动端不能全库 stat（改前每个文件一次）
    expect(harness.stats.statCalls).toEqual([]);
    // 正常文件仍在
    expect(paths).toContain("notes/a.md");
  });
});
