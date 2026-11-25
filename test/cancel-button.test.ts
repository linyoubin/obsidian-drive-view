/**
 * 0.2.20 N1：取消按钮必须真的能取消（不再是 no-op）。
 *
 * 现状链路：Notice 按钮 → `book.cancelAll()`（默认跳过 interactive），而唯一在下的
 * 下载（当前笔记正文 / 刚点开的附件）恰好被判成 interactive → 按了等于没按。
 *
 * 三个用例：
 *   ① 点取消 → 当前 interactive 下载确实被取消（抛 `QuarkDownloadCanceledError`）；
 *   ② 打开图片（附件）时点取消能取消，且附件下载按 background 记账（不算 interactive）；
 *   ③ 取消后 Notice 文案变成「已取消下载」。
 */

import { describe, expect, test } from "bun:test";

import {
  QuarkClient,
  QuarkDownloadCanceledError,
  TokenBucket,
  type QuarkHttpResponse,
  type QuarkTransport,
} from "../src/client/QuarkClient";
import { DownloadNoticeBook } from "../src/client/downloadUi";
import { QuarkReadOnlyAdapter } from "../src/adapter/QuarkReadOnlyAdapter";
import type { IndexEntry } from "../src/store/IndexStore";

const fastBucket = (): TokenBucket => new TokenBucket({ ratePerSecond: 10000, sleep: async () => undefined });

function jsonResponse(status: number, body: unknown): QuarkHttpResponse {
  return { status, headers: {}, text: JSON.stringify(body) };
}

function fileResponse(text: string): QuarkHttpResponse {
  return { status: 200, headers: {}, arrayBuffer: new TextEncoder().encode(text).buffer as ArrayBuffer };
}

async function waitFor(condition: () => boolean, timeoutMs = 500): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface Harness {
  book: DownloadNoticeBook;
  click(): void;
  messages: string[];
  priorities: Array<string | undefined>;
}

function makeBook(): Harness {
  const messages: string[] = [];
  const notice = {
    noticeEl: {},
    setMessage(message: string) {
      messages.push(message);
    },
    hide() {
      /* noop */
    },
  };
  let onCancel: (() => void) | null = null;
  const book = new DownloadNoticeBook({
    create: () => notice,
    attachCancel: (_notice, callback) => {
      onCancel = callback;
    },
  });
  return {
    book,
    messages,
    priorities: [],
    click: () => {
      if (!onCancel) throw new Error("取消按钮未挂载");
      onCancel();
    },
  };
}

function makeClient(): { client: QuarkClient; cdnCalls: () => number; release: () => void } {
  let cdnCalls = 0;
  let releaseCdn!: (response: QuarkHttpResponse) => void;
  const cdn = new Promise<QuarkHttpResponse>((resolve) => {
    releaseCdn = resolve;
  });
  const transport: QuarkTransport = async (request) => {
    if (request.url.includes("/file/download")) {
      return jsonResponse(200, { code: 0, data: [{ download_url: "https://cdn.example/one" }] });
    }
    cdnCalls += 1;
    return cdn;
  };
  const client = new QuarkClient({
    transport,
    limiter: fastBucket(),
    sleep: async () => undefined,
    downloadTimeoutMs: 5000,
  });
  return { client, cdnCalls: () => cdnCalls, release: () => releaseCdn(fileResponse("downloaded-body")) };
}

function makeAdapter(options: {
  book: DownloadNoticeBook;
  client: QuarkClient;
  priorities: Array<string | undefined>;
  entries: IndexEntry[];
  activePath: () => string;
}) {
  return new QuarkReadOnlyAdapter({
    index: { entries: options.entries },
    cache: {
      has: () => false,
      get: () => null,
      getResourceUrl: () => "",
      put: () => ({ cached: true }),
      enqueuePrefetch: () => undefined,
    },
    client: options.client,
    baseAdapter: {} as never,
    allowPrefetch: () => false,
    activeNotePath: options.activePath,
    downloadUi: {
      begin: (info) => {
        options.priorities.push(info.priority);
        return options.book.begin(info);
      },
      end: (token, outcome) => options.book.end(token, outcome),
    },
  });
}

const NOTE_ENTRY: IndexEntry = { path: "notes/cur.md", type: "file", fid: "fid-md", parentFid: "", size: 9, mtime: 1 };
const IMAGE_ENTRY: IndexEntry = { path: "img/a.jpeg", type: "file", fid: "fid-img", parentFid: "", size: 9, mtime: 1 };

describe("0.2.20 N1 取消按钮真的生效", () => {
  test("点取消 → 当前笔记（interactive）的下载被取消并抛 QuarkDownloadCanceledError", async () => {
    const harness = makeBook();
    const { client, cdnCalls, release } = makeClient();
    const adapter = makeAdapter({
      book: harness.book,
      client,
      priorities: harness.priorities,
      entries: [NOTE_ENTRY],
      activePath: () => "notes/cur.md",
    });

    const read = adapter.read("notes/cur.md").then(
      (text) => ({ ok: true as const, text }),
      (error) => ({ ok: false as const, error })
    );
    await waitFor(() => cdnCalls() === 1);
    expect(harness.priorities).toEqual(["interactive"]);

    harness.click();
    await new Promise((resolve) => setTimeout(resolve, 80)); // 让客户端取消轮询生效
    release();

    const outcome = await Promise.race([
      read,
      new Promise<{ ok: "watchdog" }>((resolve) => setTimeout(() => resolve({ ok: "watchdog" }), 500)),
    ]);
    expect(outcome.ok).not.toBe("watchdog");
    if (outcome.ok === false) {
      expect(outcome.error).toBeInstanceOf(QuarkDownloadCanceledError);
    } else {
      throw new Error(`取消按钮没有取消下载（read resolved=${String((outcome as { text?: string }).text)}）`);
    }
  });

  test("打开图片点取消能取消，且附件下载按 background 记账（不算 interactive）", async () => {
    const harness = makeBook();
    const { client, cdnCalls, release } = makeClient();
    // 模拟旧 bug：活动路径就是这张图（main 曾把它设成 quarkLastNotePath）
    const adapter = makeAdapter({
      book: harness.book,
      client,
      priorities: harness.priorities,
      entries: [IMAGE_ENTRY],
      activePath: () => "img/a.jpeg",
    });

    const read = adapter.readBinary("img/a.jpeg").then(
      (buffer) => ({ ok: true as const, buffer }),
      (error) => ({ ok: false as const, error })
    );
    await waitFor(() => cdnCalls() === 1);
    // 附件永远按 background：不算 interactive（否则取消按钮会放过它）
    expect(harness.priorities).toEqual(["background"]);

    harness.click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    release();

    const outcome = await Promise.race([
      read,
      new Promise<{ ok: "watchdog" }>((resolve) => setTimeout(() => resolve({ ok: "watchdog" }), 500)),
    ]);
    expect(outcome.ok).not.toBe("watchdog");
    expect(outcome.ok).toBe(false);
    if (outcome.ok === false) expect(outcome.error).toBeInstanceOf(QuarkDownloadCanceledError);
  });

  test("取消后 Notice 文案变成「已取消下载」", () => {
    const harness = makeBook();
    const token = harness.book.begin({
      path: "notes/cur.md",
      fid: "fid-md",
      sizeBytes: 10,
      priority: "interactive",
    });
    expect(harness.book.text).toContain("正在下载");

    harness.click();

    expect(token.aborted).toBe(true);
    expect(harness.book.text).toBe("已取消下载");
    expect(harness.messages[harness.messages.length - 1]).toBe("已取消下载");
  });
});
