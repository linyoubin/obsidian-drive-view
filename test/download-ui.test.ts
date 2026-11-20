/**
 * 下载提示与取消单测（0.2.4 A4′/A11）。
 *
 * 通过注入的 `DownloadNoticeHost` 观察提示文案/隐藏次数，不碰真实 DOM。
 */

import { describe, expect, test } from "bun:test";

import {
  DownloadNoticeBook,
  describeDownloadNotice,
  downloadFileName,
  formatDownloadSize,
  type DownloadNoticeHost,
  type DownloadNoticeLike,
} from "../src/client/downloadUi";

const MB = 1024 * 1024;

function fakeHost() {
  const created: string[] = [];
  const messages: string[] = [];
  const notice: DownloadNoticeLike & { hides: number } = {
    hides: 0,
    setMessage(message: string) {
      messages.push(message);
    },
    hide() {
      notice.hides += 1;
    },
  };
  let cancelCallback: (() => void) | null = null;
  const host: DownloadNoticeHost = {
    create(message: string) {
      created.push(message);
      messages.push(message);
      return notice;
    },
    attachCancel(_notice: DownloadNoticeLike, onCancel: () => void) {
      cancelCallback = onCancel;
    },
  };
  return {
    host,
    notice,
    created,
    messages,
    get hideCount() {
      return notice.hides;
    },
    cancel: () => cancelCallback?.(),
    get hasCancelButton() {
      return cancelCallback !== null;
    },
  };
}

describe("下载提示文案（A4′）", () => {
  test("含文件名与人类可读大小", () => {
    const text = describeDownloadNotice({ fileName: "笔记.pdf", sizeBytes: 12.3 * MB, active: 1 });
    expect(text).toContain("正在下载 笔记.pdf");
    expect(text).toContain("12.3 MB");
  });

  test("并发排队显示 (1/2) 计数", () => {
    const text = describeDownloadNotice({ fileName: "a.md", sizeBytes: 1024, active: 2, position: 1 });
    expect(text).toContain("(1/2)");
  });

  test("超过提醒阈值时只追加提醒，不说拦截", () => {
    const prompt = describeDownloadNotice({ fileName: "big.pdf", sizeBytes: 60 * MB, active: 1, thresholdBytes: 50 * MB });
    expect(prompt).toContain("提醒阈值");
    expect(prompt).not.toContain("不支持");
    const silent = describeDownloadNotice({ fileName: "big.pdf", sizeBytes: 60 * MB, active: 1, thresholdBytes: 0 });
    expect(silent).not.toContain("提醒阈值");
  });

  test("大小与文件名格式化", () => {
    expect(formatDownloadSize(0)).toBe("0 B");
    expect(formatDownloadSize(1536)).toBe("1.5 KB");
    expect(formatDownloadSize(2.5 * MB)).toBe("2.5 MB");
    expect(downloadFileName("/a/b/技术.md")).toBe("技术.md");
    expect(downloadFileName("")).toBe("（未知文件）");
  });
});

describe("DownloadNoticeBook：单例提示与取消（A11）", () => {
  test("第二次下载复用同一条提示（不新建）并更新文案与计数", () => {
    const fake = fakeHost();
    const book = new DownloadNoticeBook(fake.host);
    book.begin({ path: "/a.md", fid: "f1", sizeBytes: 1024 });
    book.begin({ path: "/b.pdf", fid: "f2", sizeBytes: 2 * MB });
    expect(fake.created.length).toBe(1);
    expect(fake.messages.length).toBeGreaterThanOrEqual(2);
    expect(fake.notice.hides).toBe(0);
    expect(book.activeCount).toBe(2);
    expect(fake.messages[fake.messages.length - 1]).toContain("(2/2)");
  });

  test("取消：令牌 aborted、文案变「已取消下载」、全部结束后 hide", () => {
    const fake = fakeHost();
    const book = new DownloadNoticeBook(fake.host);
    const token = book.begin({ path: "/a.md", fid: "f1", sizeBytes: 1024 });
    expect(fake.hasCancelButton).toBe(true);
    fake.cancel();
    expect(token.aborted).toBe(true);
    expect(book.text).toBe("已取消下载");
    book.end(token, "canceled");
    expect(fake.hideCount).toBe(1);
  });

  test("全部下载完成：提示立即 hide", () => {
    const fake = fakeHost();
    const book = new DownloadNoticeBook(fake.host);
    const token = book.begin({ path: "/a.md", fid: "f1", sizeBytes: 1024 });
    book.end(token, "done");
    expect(fake.hideCount).toBe(1);
    expect(book.activeCount).toBe(0);
  });

  test("部分完成：提示继续显示剩余下载", () => {
    const fake = fakeHost();
    const book = new DownloadNoticeBook(fake.host);
    const first = book.begin({ path: "/a.md", fid: "f1", sizeBytes: 1024 });
    book.begin({ path: "/b.md", fid: "f2", sizeBytes: 2048 });
    book.end(first, "done");
    expect(fake.notice.hides).toBe(0);
    expect(book.text).toContain("正在下载");
  });

  test("阈值只影响文案：超过阈值仍允许下载", () => {
    const fake = fakeHost();
    const book = new DownloadNoticeBook(fake.host, { thresholdBytes: () => 50 * MB });
    book.begin({ path: "/huge.pdf", fid: "f1", sizeBytes: 80 * MB });
    expect(fake.messages[0]).toContain("提醒阈值");
    expect(book.activeCount).toBe(1);
  });
});
