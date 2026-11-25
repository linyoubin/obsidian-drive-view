/**
 * 0.2.22 M2：unmount 只对「本地缺失、需要新建」的文件做 stat。
 *
 * 0.2.21 N5 为省时完全跳过 stat，导致退出只读后本地独有文件 stat 全 0
 * （size=0 / mtime=1970），影响排序、属性面板与依赖 mtime 的插件。
 *
 * 期望：missing 文件拿到真实 size/mtime；两边都有的文件 **0 次 stat**（不重复取）。
 */

import { describe, expect, test } from "bun:test";

import { VaultMounter } from "../src/adapter/VaultMounter";
import { makeVaultHarness, seedLocalFileMap, type LocalTree } from "./vault-harness";

describe("0.2.22 M2 stats 只补 missing", () => {
  test("missing 文件 stat 有真实 size/mtime；shared 文件 stat 0 次", async () => {
    const local: LocalTree = {
      folders: ["notes"],
      files: { "local-only.md": 7, "shared.md": 5, "notes/deep.md": 9 },
    };
    const harness = makeVaultHarness({
      local,
      cloud: [
        { path: "shared.md", type: "file", ctime: 11, mtime: 22, size: 5 },
        { path: "notes", type: "folder" },
        { path: "notes/deep.md", type: "file", ctime: 11, mtime: 22, size: 9 },
      ],
    });
    seedLocalFileMap(harness, local);

    const mounter = new VaultMounter(harness.app as never);
    await mounter.mount(harness.mountable as never);
    harness.stats.statCalls.length = 0;

    await mounter.unmount(harness.mountable as never);

    // local-only 是唯一的 missing 文件 → 只 stat 它
    expect(harness.stats.statCalls).toEqual(["local-only.md"]);
    const missingNode = harness.fileMap["local-only.md"];
    expect(missingNode.stat?.size).toBe(7);
    expect(missingNode.stat?.mtime).toBe(2);
    expect(missingNode.stat?.ctime).toBe(1);
    // 两边都有的文件不被 stat，保留云端已知 stat
    expect(harness.fileMap["shared.md"].stat?.size).toBe(5);
    expect(harness.fileMap["shared.md"].stat?.mtime).toBe(22);
  });
});
