/**
 * 0.2.21 S4：附件下载完成后，只有「叶子正在显示这个 path」才重载。
 *
 * 用户在下载期间切到另一张图/另一篇笔记时，旧逻辑会重载当前（错误的）叶子。
 * 期望：path 不匹配 → 不重载，只记日志 `state=skip reason=path-mismatch`。
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

function makeAdapter() {
  return new QuarkReadOnlyAdapter({
    index: { entries: ENTRIES },
    cache: {
      has: () => false,
      get: () => null,
      getResourceUrl: () => "",
      put: () => ({ cached: true }),
      enqueuePrefetch: () => undefined,
    },
    client: { downloadFile: async () => new TextEncoder().encode("binary").buffer as ArrayBuffer },
    baseAdapter: {} as never,
    allowPrefetch: () => false,
  });
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

describe("0.2.21 S4 重载前校验 path", () => {
  test("叶子已切到别的文件 → 不重载，日志记 state=skip reason=path-mismatch", async () => {
    const adapter = makeAdapter();
    const { leaf, calls } = makeLeaf("img/other.jpeg");
    const logs: Array<{ state?: string; reason?: string; path?: string }> = [];
    const warm = createAttachmentWarmup({
      readBinary: (path) => adapter.readBinary(path),
      activeLeaf: () => leaf,
      log: (entry) => logs.push(entry),
    });

    await expect(warm("img/a.jpeg")).resolves.toBe(true);

    expect(calls.setViewState).toBe(0);
    expect(calls.rerender).toBe(0);
    const skip = logs.find((entry) => entry.state === "skip" && entry.reason === "path-mismatch");
    expect(skip).toBeDefined();
    expect(skip!.path).toBe("img/a.jpeg");
  });

  test("叶子仍在看这个文件 → 正常重载，且不记 path-mismatch", async () => {
    const adapter = makeAdapter();
    const { leaf, calls } = makeLeaf("img/a.jpeg");
    const logs: Array<{ state?: string; reason?: string }> = [];
    const warm = createAttachmentWarmup({
      readBinary: (path) => adapter.readBinary(path),
      activeLeaf: () => leaf,
      log: (entry) => logs.push(entry),
    });

    await expect(warm("img/a.jpeg")).resolves.toBe(true);

    expect(calls.setViewState).toBe(1);
    expect(logs.some((entry) => entry.reason === "path-mismatch")).toBe(false);
  });
});
