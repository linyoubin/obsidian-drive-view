/**
 * 0.2.22 M5：记住发起下载的叶子，切走/切回后仍能重载。
 *
 * 0.2.21 S4 只校验「当前活动叶子」，用户切走后下载完成 → skip；切回来仍是占位，
 * 因为完成时已不再记得发起时是哪个叶子。
 *
 * 期望：
 *   ① 发起时的叶子仍在（切走后）→ 重载该叶子（不是当前活动叶子）；
 *   ② 发起时的叶子已关闭 → 不重载，日志记 `reason=leaf-closed`。
 */

import { describe, expect, test } from "bun:test";

import {
  QuarkReadOnlyAdapter,
  createAttachmentWarmup,
  type RefreshableLeafLike,
} from "../src/adapter/QuarkReadOnlyAdapter";
import type { IndexEntry } from "../src/store/IndexStore";

const ENTRIES: IndexEntry[] = [
  { path: "img/a.jpeg", type: "file", fid: "fid-img", parentFid: "", size: 6, mtime: 1 },
];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("waitFor timeout");
    await delay(5);
  }
}

function makeLeaf(path: string) {
  const calls = { setViewState: 0, rerender: 0 };
  const leaf: RefreshableLeafLike = {
    view: { file: { path } },
    getViewState: () => ({ path }),
    setViewState: async () => {
      calls.setViewState += 1;
    },
  };
  return { leaf, calls };
}

function makeHarness() {
  let releaseDownload!: () => void;
  const downloadStarted: string[] = [];
  const adapter = new QuarkReadOnlyAdapter({
    index: { entries: ENTRIES },
    cache: {
      has: () => false,
      get: () => null,
      getResourceUrl: () => "",
      put: () => ({ cached: true }),
      enqueuePrefetch: () => undefined,
    },
    client: {
      downloadFile: async (fid: string) => {
        downloadStarted.push(fid);
        await new Promise<void>((resolve) => {
          releaseDownload = resolve;
        });
        return new TextEncoder().encode("binary").buffer as ArrayBuffer;
      },
    },
    baseAdapter: {} as never,
    allowPrefetch: () => false,
  });
  return {
    adapter,
    downloadStarted,
    release: () => releaseDownload(),
  };
}

describe("0.2.22 M5 记住发起叶子", () => {
  test("切走后发起时的叶子仍在 → 重载该叶子（不是当前活动叶子）", async () => {
    const harness = makeHarness();
    const origin = makeLeaf("img/a.jpeg");
    const other = makeLeaf("notes/other.md");
    let active: RefreshableLeafLike = origin.leaf;
    const logs: Array<{ state?: string; reason?: string; path?: string }> = [];
    const warm = createAttachmentWarmup({
      readBinary: (path) => harness.adapter.readBinary(path),
      activeLeaf: () => active,
      openLeaves: () => [origin.leaf, other.leaf],
      log: (entry) => logs.push(entry),
    });

    const pending = warm("img/a.jpeg");
    await waitFor(() => harness.downloadStarted.length === 1);
    active = other.leaf; // 用户切走（发起叶子还在，只是不活动）
    harness.release();
    await expect(pending).resolves.toBe(true);

    // 重载发起叶子，不动当前活动叶子
    await waitFor(() => origin.calls.setViewState === 1, 500);
    expect(origin.calls.setViewState).toBe(1);
    expect(other.calls.setViewState).toBe(0);
    expect(logs.some((entry) => entry.reason === "leaf-closed")).toBe(false);
  });

  test("发起时的叶子已关闭 → 不重载，日志记 reason=leaf-closed", async () => {
    const harness = makeHarness();
    const origin = makeLeaf("img/a.jpeg");
    const other = makeLeaf("notes/other.md");
    let active: RefreshableLeafLike = origin.leaf;
    let openLeaves: RefreshableLeafLike[] = [origin.leaf, other.leaf];
    const logs: Array<{ state?: string; reason?: string; path?: string }> = [];
    const warm = createAttachmentWarmup({
      readBinary: (path) => harness.adapter.readBinary(path),
      activeLeaf: () => active,
      openLeaves: () => openLeaves,
      log: (entry) => logs.push(entry),
    });

    const pending = warm("img/a.jpeg");
    await waitFor(() => harness.downloadStarted.length === 1);
    active = other.leaf;
    openLeaves = [other.leaf]; // 原叶子被关闭
    harness.release();
    await expect(pending).resolves.toBe(true);

    expect(origin.calls.setViewState).toBe(0);
    expect(other.calls.setViewState).toBe(0);
    expect(logs).toContainEqual({ path: "img/a.jpeg", state: "skip", reason: "leaf-closed" });
  });
});
