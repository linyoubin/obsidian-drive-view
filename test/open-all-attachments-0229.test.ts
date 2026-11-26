/**
 * 0.2.29：所有非 md 文件统一「点击跳夸克」（图片/PDF 也可以跳，开关分开）。
 *
 * 分类：
 *   - `media`：图片 + PDF（新开关「图片/PDF：点击跳夸克」）
 *   - `other`：Office / 压缩包 / 音视频 / 电子书…（原开关「Office/压缩包/音视频：点击跳夸克」）
 */

import { describe, expect, test } from "bun:test";

import {
  QUARK_UNPREVIEWABLE_EXTENSIONS,
  createUnpreviewableOpenFlow,
  isQuarkUnpreviewable,
  quarkUnpreviewableCategory,
} from "../src/adapter/QuarkOpenExternal";

interface LogEntry {
  path: string;
  fid: string;
  domain: string;
  length: number;
  result: string;
}

function makeHost(options: { media?: boolean; other?: boolean } = {}) {
  const logs: LogEntry[] = [];
  const calls = { confirm: 0, open: 0, copy: 0 };
  const host = {
    isEnabled: (category: "media" | "other") =>
      category === "media" ? (options.media ?? true) : (options.other ?? true),
    confirm: async () => {
      calls.confirm += 1;
      return true;
    },
    openExternal: async () => {
      calls.open += 1;
      return true;
    },
    copyLink: async () => {
      calls.copy += 1;
      return true;
    },
    log: (entry: LogEntry) => logs.push(entry),
  };
  return { host, calls, logs };
}

describe("0.2.29 全量非 md 分类", () => {
  test("图片/PDF → media；Office/压缩包/音视频 → other；md 永不", () => {
    for (const path of ["a.png", "a.jpg", "a.jpeg", "a.gif", "a.webp", "a.svg", "a.bmp", "a.heic", "a.pdf"]) {
      expect(quarkUnpreviewableCategory(path), path).toBe("media");
      expect(isQuarkUnpreviewable(path), path).toBe(true);
    }
    for (const path of ["a.docx", "a.xlsx", "a.pptx", "a.doc", "a.xls", "a.ppt", "a.zip", "a.rar", "a.7z", "a.mp3", "a.mp4", "a.mov", "a.m4a", "a.wav"]) {
      expect(quarkUnpreviewableCategory(path), path).toBe("other");
      expect(isQuarkUnpreviewable(path), path).toBe(true);
    }
    for (const path of ["a.md", "a.markdown", "a.canvas", "a.txt"]) {
      expect(quarkUnpreviewableCategory(path), path).toBeNull();
      expect(isQuarkUnpreviewable(path), path).toBe(false);
    }
    expect(QUARK_UNPREVIEWABLE_EXTENSIONS).toContain("png");
    expect(QUARK_UNPREVIEWABLE_EXTENSIONS).toContain("pdf");
    expect(QUARK_UNPREVIEWABLE_EXTENSIONS).toContain("mp4");
  });

  test("png：图片开关开 → 确认 + openExternal 1 次", async () => {
    const { host, calls, logs } = makeHost();
    const flow = createUnpreviewableOpenFlow(host);
    const result = await flow({ path: "pics/a.png", fid: "f1", parentFid: "root" });
    expect(result).toBe("opened");
    expect(calls.confirm).toBe(1);
    expect(calls.open).toBe(1);
    expect(logs[0]).toMatchObject({ path: "pics/a.png", result: "opened" });
  });

  test("pdf：图片/PDF 开关开 → 同样跳转（不再交给 Obsidian 渲染）", async () => {
    const { host, calls } = makeHost();
    const flow = createUnpreviewableOpenFlow(host);
    await expect(flow({ path: "docs/a.pdf", fid: "f2", parentFid: "root" })).resolves.toBe("opened");
    expect(calls.confirm).toBe(1);
    expect(calls.open).toBe(1);
  });

  test("关掉图片/PDF 开关 → png 不弹、不打开（回到渲染路径）；Office 仍可跳", async () => {
    const { host, calls } = makeHost({ media: false });
    const flow = createUnpreviewableOpenFlow(host);

    await expect(flow({ path: "pics/a.png", fid: "f1", parentFid: "root" })).resolves.toBe("disabled");
    await expect(flow({ path: "docs/a.docx", fid: "f3", parentFid: "root" })).resolves.toBe("opened");
    expect(calls.confirm).toBe(1); // 只有 docx 弹
    expect(calls.open).toBe(1);
  });

  test("关掉 Office 开关 → docx 不弹；png 仍可跳", async () => {
    const { host, calls } = makeHost({ other: false });
    const flow = createUnpreviewableOpenFlow(host);

    await expect(flow({ path: "docs/a.docx", fid: "f3", parentFid: "root" })).resolves.toBe("disabled");
    await expect(flow({ path: "pics/a.png", fid: "f1", parentFid: "root" })).resolves.toBe("opened");
    expect(calls.confirm).toBe(1);
    expect(calls.open).toBe(1);
  });

  test("md 永不弹（即使两个开关都开）", async () => {
    const { host, calls } = makeHost();
    const flow = createUnpreviewableOpenFlow(host);
    await expect(flow({ path: "notes/a.md", fid: "f9", parentFid: "root" })).resolves.toBe("not-unpreviewable");
    expect(calls.confirm).toBe(0);
    expect(calls.open).toBe(0);
  });
});
