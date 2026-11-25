/**
 * 0.2.18 B1：附件「点开才下」——`file-open` 打开非 md 附件后必须真的发起一次下载并重绘该叶子。
 *
 * 分两段断言：
 *   1. 行为（本文件主体）：`createAttachmentWarmup` + 真实 `QuarkReadOnlyAdapter.readBinary`
 *      —— 打开 jpeg 触发 transport 1 次并重绘；打开 md 不触发；节流窗口内重复打开只下 1 次；
 *   2. 接线（源码断言）：`main.ts` 的 `file-open` 处理器把活动叶子的路径交给上面的 warmup，
 *      而不是只做笔记预取。
 */

import { describe, expect, test } from "bun:test";

import {
  QuarkReadOnlyAdapter,
  createAttachmentWarmup,
  isQuarkAttachmentPath,
  QUARK_ATTACHMENT_OPEN_THROTTLE_MS,
  type QuarkCacheLike,
} from "../src/adapter/QuarkReadOnlyAdapter";
import type { IndexEntry } from "../src/store/IndexStore";

function indexEntry(path: string, fid: string): IndexEntry {
  return { path, type: "file", fid, parentFid: "", size: 6, mtime: 1 };
}

function makeCache(): QuarkCacheLike {
  const store = new Map<string, ArrayBuffer>();
  return {
    has: (path: string) => store.has(path),
    get: (path: string) => store.get(path) ?? null,
    getResourceUrl: () => "",
    put: (path: string, data: ArrayBuffer | Uint8Array) => {
      const buffer = data instanceof Uint8Array ? (data.slice().buffer as ArrayBuffer) : data;
      store.set(path, buffer);
      return { cached: true };
    },
    enqueuePrefetch: () => undefined,
  };
}

/** transport 计数 + 真实 adapter（readBinary 会走 cache → downloadFile）。 */
function makeHarness() {
  const downloads: string[] = [];
  const redraws: string[] = [];
  const adapter = new QuarkReadOnlyAdapter({
    index: {
      entries: [indexEntry("img/a.jpeg", "fid-jpeg"), indexEntry("notes/b.md", "fid-md")],
    },
    cache: makeCache(),
    client: {
      downloadFile: async (fid: string) => {
        downloads.push(fid);
        return new TextEncoder().encode("binary").buffer as ArrayBuffer;
      },
    },
    baseAdapter: {} as never,
    allowPrefetch: () => false,
  });
  return { adapter, downloads, redraws };
}

describe("0.2.18 B1 file-open 附件预热", () => {
  test("`file-open('img/a.jpeg')` → 下载 1 次并重绘该叶子；`file-open md` → 不下载", async () => {
    const { adapter, downloads, redraws } = makeHarness();
    const warm = createAttachmentWarmup({
      readBinary: (path) => adapter.readBinary(path),
      redraw: (path) => redraws.push(path),
    });

    // 打开 md：不是附件，绝不触发附件下载
    await expect(warm("notes/b.md")).resolves.toBe(false);
    expect(downloads).toEqual([]);
    expect(redraws).toEqual([]);

    // 打开 jpeg：真的下一次（transport 1 次），然后重绘
    await expect(warm("/img/a.jpeg")).resolves.toBe(true);
    expect(downloads).toEqual(["fid-jpeg"]);
    expect(redraws).toEqual(["img/a.jpeg"]);
  });

  test("节流 ≥1s：窗口内重复 file-open 同一附件只下 1 次，过窗后才放行", async () => {
    const { adapter, downloads, redraws } = makeHarness();
    let now = 0;
    const warm = createAttachmentWarmup({
      readBinary: (path) => adapter.readBinary(path),
      redraw: (path) => redraws.push(path),
      now: () => now,
    });

    await expect(warm("img/a.jpeg")).resolves.toBe(true);
    now = 500;
    await expect(warm("img/a.jpeg")).resolves.toBe(false);
    now = 999;
    await expect(warm("img/a.jpeg")).resolves.toBe(false);
    expect(downloads).toEqual(["fid-jpeg"]);
    expect(redraws).toEqual(["img/a.jpeg"]);

    now = 1000;
    await expect(warm("img/a.jpeg")).resolves.toBe(true);
    // 第二次命中 adapter 内存缓存（不再打 transport），但节流已放行并重绘
    expect(redraws).toEqual(["img/a.jpeg", "img/a.jpeg"]);
    expect(QUARK_ATTACHMENT_OPEN_THROTTLE_MS).toBeGreaterThanOrEqual(1000);
  });

  test("附件扩展名判定：jpeg/png/pdf/mp3/mp4 是附件，md/canvas/base 不是", () => {
    for (const path of ["a.jpeg", "a.JPG", "dir/x.png", "a.pdf", "a.mp3", "a.mp4"]) {
      expect(isQuarkAttachmentPath(path), path).toBe(true);
    }
    for (const path of ["a.md", "dir/b.markdown", "a.canvas", "x.base", "", "noext"]) {
      expect(isQuarkAttachmentPath(path), path).toBe(false);
    }
  });

  test("main.ts 接线：file-open 处理器把活动叶子路径交给附件 warmup", async () => {
    const source = await Bun.file(new URL("../src/main.ts", import.meta.url)).text();
    const found = {
      fileOpen: source.includes('.on("file-open"'),
      openAttachment: /void this\.openQuarkAttachment\(/.test(source),
      predicate: /isQuarkAttachmentPath\(/.test(source),
      factory: source.includes("createAttachmentWarmup("),
    };
    expect(found).toEqual({ fileOpen: true, openAttachment: true, predicate: true, factory: true });
  });
});
