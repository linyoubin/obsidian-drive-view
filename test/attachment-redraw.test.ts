/**
 * 0.2.20 B1：附件下载完成后的「重绘」必须是真重载，而不是只对 Markdown 的 previewMode。
 *
 * 现状 redraw 只调 `activeLeaf.view.previewMode.rerender`，图片/PDF/媒体视图没有
 * previewMode → 下载完成但视图不刷新，第一次点开仍是占位。
 *
 * 用例注入带 `setViewState` 的假 leaf：下载完成后必须调用 1 次
 * `setViewState(getViewState())` 强制重载；Markdown 叶子仍走 `previewMode.rerender(true)`。
 */

import { describe, expect, test } from "bun:test";

import {
  QuarkReadOnlyAdapter,
  createAttachmentWarmup,
  reloadLeafView,
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

function makeNonMarkdownLeaf() {
  const state = { type: "image", state: { file: "img/a.jpeg" } };
  const calls = { getViewState: 0, setViewState: 0, rerender: 0 };
  const leaf: RefreshableLeafLike = {
    view: { file: { path: "img/a.jpeg" } },
    getViewState: () => {
      calls.getViewState += 1;
      return state;
    },
    setViewState: async (_next: unknown) => {
      calls.setViewState += 1;
    },
  };
  return { leaf, calls, state };
}

function makeMarkdownLeaf() {
  const calls = { rerender: 0, setViewState: 0 };
  const leaf: RefreshableLeafLike = {
    view: {
      file: { path: "notes/a.md" },
      getViewData: () => "# hello",
      previewMode: {
        rerender: (force?: boolean) => {
          calls.rerender += 1;
          expect(force).toBe(true);
        },
      },
    },
    getViewState: () => ({ type: "markdown" }),
    setViewState: async () => {
      calls.setViewState += 1;
    },
  };
  return { leaf, calls };
}

describe("0.2.20 B1 附件下载完成后的重绘", () => {
  test("图片/PDF（无 previewMode）→ setViewState(getViewState()) 被调用 1 次", async () => {
    const adapter = makeAdapter();
    const { leaf, calls, state } = makeNonMarkdownLeaf();
    const warm = createAttachmentWarmup({
      readBinary: (path) => adapter.readBinary(path),
      activeLeaf: () => leaf,
    });

    await expect(warm("img/a.jpeg")).resolves.toBe(true);

    expect(calls.setViewState).toBe(1);
    expect(calls.getViewState).toBe(1);
    expect(calls.rerender).toBe(0);
    expect(state).toEqual({ type: "image", state: { file: "img/a.jpeg" } });
  });

  test("Markdown 叶子 → previewMode.rerender(true)，不 setViewState", async () => {
    const { leaf, calls } = makeMarkdownLeaf();
    const outcome = reloadLeafView(leaf);

    expect(outcome).toBe("rerender");
    expect(calls.rerender).toBe(1);
    expect(calls.setViewState).toBe(0);
  });

  test("reloadLeafView 兜底：既无 previewMode 也无 setViewState → none（不抛）", () => {
    expect(reloadLeafView({ view: { file: { path: "x" } } })).toBe("none");
    expect(reloadLeafView(null)).toBe("none");
  });
});
