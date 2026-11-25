/**
 * 0.2.19 B3：`VaultMounter.unmount()` 必须把 `Vault.fileMap` 还原成**挂载前**的本地树。
 *
 * 现在的 `unmount()` 只换回 base adapter，云端合成节点（`cloud/…`）留在 fileMap 里，
 * 本地文件也回不来；用例断言「路径集合 + 节点数完全一致」。
 *
 * VaultMounter 已去掉运行期 `obsidian` 导入（结构判定），因此这里用假 vault 直接测，
 * 不需要整进程 mock Obsidian。
 */

import { describe, expect, test } from "bun:test";

import { VaultMounter } from "../src/adapter/VaultMounter";

interface FakeNode {
  path: string;
  children?: FakeNode[];
  stat?: { ctime: number; mtime: number; size: number };
}

interface Harness {
  app: unknown;
  fileMap: Record<string, FakeNode>;
  localAdapter: Record<string, unknown>;
  cloudAdapter: Record<string, unknown>;
  mountable: { createProxiedAdapter(): unknown; cache: { getAllEntries(): unknown[] } };
  stats: { stops: number; starts: number; reads: string[] };
  setAdapter(value: unknown): void;
  currentAdapter(): unknown;
}

function makeHarness(): Harness {
  const stats = { stops: 0, starts: 0, reads: [] as string[] };
  const fileMap: Record<string, FakeNode> = {};
  let current: unknown = null;

  const vault = {
    configDir: ".obsidian",
    get adapter() {
      return current;
    },
    set adapter(value: unknown) {
      current = value;
    },
    fileMap,
    getAbstractFileByPath: (path: string) => fileMap[path] ?? null,
    onChange: (type: string, path: string, oldPath?: string, stat?: { ctime: number; mtime: number; size: number }) => {
      if (type === "folder-created") {
        fileMap[path] = { path, children: [] };
        return;
      }
      if (type === "file-created" || type === "raw") {
        fileMap[path] = fileMap[path] ?? { path, stat };
        if (stat) fileMap[path].stat = stat;
        return;
      }
      if (type === "modified") {
        fileMap[path] = fileMap[path] ?? { path };
        return;
      }
      if (type === "file-removed" || type === "folder-removed") {
        delete fileMap[path];
        return;
      }
      if (type === "renamed" && oldPath) {
        const node = fileMap[oldPath];
        delete fileMap[oldPath];
        if (node) {
          node.path = path;
          fileMap[path] = node;
        }
      }
    },
  };

  // 本地磁盘：根有 local.md 与 notes/，notes 下有 local2.md
  const localSizes: Record<string, number> = { "local.md": 11, "notes/local2.md": 22 };
  const localAdapter: Record<string, unknown> = {
    getName: () => "FileSystemAdapter",
    stopWatch: async () => {
      stats.stops += 1;
    },
    startWatch: () => {
      stats.starts += 1;
    },
    read: async (path: string) => {
      stats.reads.push(path);
      return "";
    },
    list: async (path: string) => {
      if (path === "") return { files: ["local.md"], folders: ["notes"] };
      if (path === "notes") return { files: ["notes/local2.md"], folders: [] };
      return { files: [], folders: [] };
    },
    stat: async (path: string) =>
      localSizes[path] !== undefined
        ? { type: "file" as const, ctime: 1, mtime: 2, size: localSizes[path] }
        : null,
  };

  const cloudAdapter: Record<string, unknown> = {
    getName: () => "quark",
    read: async () => "",
    list: async () => ({ files: [], folders: [] }),
    stat: async () => null,
  };

  const mountable = {
    createProxiedAdapter: () => cloudAdapter,
    cache: {
      getAllEntries: () => [
        { path: "cloud", type: "folder", ctime: 10, mtime: 10, size: 0 },
        { path: "cloud/a.md", type: "file", ctime: 11, mtime: 12, size: 13 },
      ],
    },
  };

  const app = {
    vault,
    metadataCache: {},
    workspace: { getLeavesOfType: () => [] },
  };

  current = localAdapter;

  return {
    app,
    fileMap,
    localAdapter,
    cloudAdapter,
    mountable,
    stats,
    setAdapter: (value) => {
      current = value;
    },
    currentAdapter: () => current,
  };
}

/** 预置挂载前的本地 fileMap（与磁盘一致）。 */
function seedLocalFileMap(harness: Harness): void {
  const vault = (harness.app as { vault: { onChange: (type: string, path: string) => void } }).vault;
  vault.onChange("folder-created", "/");
  vault.onChange("folder-created", "notes");
  vault.onChange("raw", "local.md");
  vault.onChange("raw", "notes/local2.md");
}

function paths(harness: Harness): string[] {
  return Object.keys(harness.fileMap).sort();
}

describe("0.2.19 B3 VaultMounter.unmount 还原 fileMap", () => {
  test("mount → unmount 后 fileMap 与挂载前集合完全一致（路径 + 节点数），并重启监听", async () => {
    const harness = makeHarness();
    seedLocalFileMap(harness);
    const before = paths(harness);
    expect(before).toEqual(["/", "local.md", "notes", "notes/local2.md"]);

    const mounter = new VaultMounter(harness.app as never);
    await mounter.mount(harness.mountable as never);

    // 挂载后：云端节点在、本地节点被移走
    expect(mounter.isMounted()).toBe(true);
    expect(paths(harness)).toContain("cloud/a.md");
    expect(harness.fileMap["local.md"]).toBeUndefined();
    expect(harness.stats.stops).toBeGreaterThanOrEqual(1);

    await mounter.unmount(harness.mountable as never);

    expect(mounter.isMounted()).toBe(false);
    expect(harness.currentAdapter()).toBe(harness.localAdapter);
    // 改前：cloud/cloud/a.md 仍在、local.md 回不来 → 集合不一致
    expect(paths(harness)).toEqual(before);
    expect(Object.keys(harness.fileMap).length).toBe(before.length);
    expect(harness.fileMap["cloud/a.md"]).toBeUndefined();
    expect(harness.fileMap["notes"].children).toEqual([]);
    // 0.2.22 M2：missing 文件逐个 stat → 恢复真实 size（不再全 0）
    expect(harness.fileMap["local.md"].stat).toBeDefined();
    expect(harness.fileMap["local.md"].stat?.size).toBe(11);
    // 挂载时停监听，卸载后必须重启本地监听
    expect(harness.stats.starts).toBeGreaterThanOrEqual(1);
  });

  test("重复 unmount 幂等：第二次不再改动 fileMap/adapter", async () => {
    const harness = makeHarness();
    seedLocalFileMap(harness);
    const before = paths(harness);
    const mounter = new VaultMounter(harness.app as never);
    await mounter.mount(harness.mountable as never);
    await mounter.unmount(harness.mountable as never);
    const starts = harness.stats.starts;

    await mounter.unmount(harness.mountable as never);
    expect(paths(harness)).toEqual(before);
    expect(harness.stats.starts).toBe(starts);
  });
});
