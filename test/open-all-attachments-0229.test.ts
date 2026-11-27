/**
 * 0.2.30：图片恢复 Obsidian 内渲染；PDF / Office / 压缩包 / 音视频点击跳夸克。
 *
 * 分类：
 *   - `media` = PDF（开关「PDF：点击跳夸克」）
 *   - `other` = Office / 压缩包 / 音视频 / 电子书…（开关「Office/压缩包/音视频：点击跳夸克」）
 *   - 图片（png/jpg/gif/webp/svg/bmp/heic…）**不再跳转**，由 Obsidian 内渲染（见 0.2.30 渲染修复）。
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
    openTarget: async () => {
      calls.open += 1;
      return "app" as const;
    },
    log: (entry: LogEntry) => logs.push(entry),
  };
  return { host, calls, logs };
}

describe("0.2.30 非 md 分类（图片恢复渲染）", () => {
  test("pdf → media；Office/压缩包/音视频 → other；图片/md 不跳", () => {
    expect(quarkUnpreviewableCategory("a.pdf")).toBe("media");
    for (const path of ["a.docx", "a.xlsx", "a.pptx", "a.zip", "a.rar", "a.7z", "a.mp3", "a.mp4", "a.mov", "a.m4a", "a.wav"]) {
      expect(quarkUnpreviewableCategory(path), path).toBe("other");
    }
    for (const path of ["a.png", "a.jpg", "a.jpeg", "a.gif", "a.webp", "a.svg", "a.bmp", "a.heic", "a.md"]) {
      expect(quarkUnpreviewableCategory(path), path).toBeNull();
      expect(isQuarkUnpreviewable(path), path).toBe(false);
    }
    expect(QUARK_UNPREVIEWABLE_EXTENSIONS).toContain("pdf");
    expect(QUARK_UNPREVIEWABLE_EXTENSIONS).not.toContain("png");
  });

  test("pdf：开关开 → 确认 + openExternal 1 次", async () => {
    const { host, calls, logs } = makeHost();
    const flow = createUnpreviewableOpenFlow(host);
    const result = await flow({ path: "docs/a.pdf", fid: "f2", parentFid: "root" });
    expect(result).toBe("app");
    expect(calls.confirm).toBe(1);
    expect(calls.open).toBe(1);
    expect(logs[0]).toMatchObject({ path: "docs/a.pdf", result: "app" });
  });

  test("关掉 PDF 开关 → pdf 不弹、不打开；Office 仍可跳", async () => {
    const { host, calls } = makeHost({ media: false });
    const flow = createUnpreviewableOpenFlow(host);

    await expect(flow({ path: "docs/a.pdf", fid: "f2", parentFid: "root" })).resolves.toBe("disabled");
    await expect(flow({ path: "docs/a.docx", fid: "f3", parentFid: "root" })).resolves.toBe("app");
    expect(calls.confirm).toBe(1);
    expect(calls.open).toBe(1);
  });

  test("关掉 Office 开关 → docx 不弹；pdf 仍可跳", async () => {
    const { host, calls } = makeHost({ other: false });
    const flow = createUnpreviewableOpenFlow(host);

    await expect(flow({ path: "docs/a.docx", fid: "f3", parentFid: "root" })).resolves.toBe("disabled");
    await expect(flow({ path: "docs/a.pdf", fid: "f2", parentFid: "root" })).resolves.toBe("app");
    expect(calls.confirm).toBe(1);
    expect(calls.open).toBe(1);
  });

  test("md 与图片永不弹", async () => {
    const { host, calls } = makeHost();
    const flow = createUnpreviewableOpenFlow(host);
    for (const path of ["notes/a.md", "pics/a.png", "pics/a.jpeg"]) {
      await expect(flow({ path, fid: "f9", parentFid: "root" })).resolves.toBe("not-unpreviewable");
    }
    expect(calls.confirm).toBe(0);
    expect(calls.open).toBe(0);
  });
});
