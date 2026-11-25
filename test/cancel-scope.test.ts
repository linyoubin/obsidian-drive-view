/**
 * 0.2.19 SF3：取消作用域——点「取消」不得掐掉当前笔记（interactive）的正文下载。
 *
 * 现状 `DownloadNoticeBook.cancelAll()` 把**所有**活动令牌标 aborted，
 * bulk 预取期间点取消会连当前笔记正文一起取消。用例：
 *   ① bulk + interactive 同时下载，cancelAll 只取消 bulk；
 *   ② `cancelScope` 只取消发起方自己的下载；
 *   ③ 两个调用方共享同一次下载（in-flight 去重），A 取消不影响 B 拿到内容。
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

function makeBook() {
  const notice = {
    messages: [] as string[],
    noticeEl: {},
    setMessage(message: string) {
      notice.messages.push(message);
    },
    hide() {
      /* noop */
    },
  };
  const book = new DownloadNoticeBook({
    create: () => notice,
    attachCancel: () => undefined,
  });
  return { book, notice };
}

const fastBucket = (): TokenBucket => new TokenBucket({ ratePerSecond: 10000, sleep: async () => undefined });
const fastSleep = async (): Promise<void> => undefined;

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

describe("0.2.19 SF3 取消作用域", () => {
  test("cancelAll 只取消 bulk，interactive（当前笔记正文）不被取消", () => {
    const { book } = makeBook();
    const bulk = book.begin({ path: "bulk/a.md", fid: "f1", sizeBytes: 10, priority: "bulk" });
    const interactive = book.begin({ path: "notes/cur.md", fid: "f2", sizeBytes: 10, priority: "interactive" });

    book.cancelAll();

    expect(bulk.aborted).toBe(true);
    expect(interactive.aborted).toBe(false);
  });

  test("cancelScope 只取消发起方自己的下载", () => {
    const { book } = makeBook();
    const mine = book.begin({ path: "a.md", fid: "fa", sizeBytes: 1, scope: "note-A", priority: "background" });
    const other = book.begin({ path: "b.md", fid: "fb", sizeBytes: 1, scope: "note-B", priority: "background" });

    const canceled = book.cancelScope("note-A");

    expect(canceled).toBe(1);
    expect(mine.aborted).toBe(true);
    expect(other.aborted).toBe(false);
    // 不存在的 scope 不误伤
    expect(book.cancelScope("note-C")).toBe(0);
    expect(other.aborted).toBe(false);
  });

  test("两个调用方共享同一次下载：A 取消不影响 B 拿到内容", async () => {
    const { book } = makeBook();
    let cdnCalled = false;
    let releaseCdn!: (response: QuarkHttpResponse) => void;
    const cdn = new Promise<QuarkHttpResponse>((resolve) => {
      releaseCdn = resolve;
    });
    const transport: QuarkTransport = async (request) => {
      if (request.url.includes("/file/download")) {
        return jsonResponse(200, { code: 0, data: [{ download_url: "https://cdn.example/fid-1" }] });
      }
      cdnCalled = true;
      return cdn;
    };
    const client = new QuarkClient({
      transport,
      limiter: fastBucket(),
      sleep: fastSleep,
      downloadTimeoutMs: 5000,
    });

    const bulkToken = book.begin({ path: "bulk/x.md", fid: "fid-1", sizeBytes: 5, priority: "bulk" });
    const interactiveToken = book.begin({ path: "notes/cur.md", fid: "fid-1", sizeBytes: 5, priority: "interactive" });
    // 两个调用方、同一个 fid → 共享同一次下载
    const bulkRead = client.downloadFile("fid-1", { signal: bulkToken, priority: "bulk" });
    const interactiveRead = client.downloadFile("fid-1", { signal: interactiveToken, priority: "interactive" });
    // 立即挂上结果处理器，避免「取消发生」与「断言」之间出现 unhandled rejection
    const bulkOutcome = bulkRead.then(
      () => "resolved" as const,
      (error) => error
    );
    const interactiveOutcome = interactiveRead.then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error })
    );
    await waitFor(() => cdnCalled);

    // bulk 预取期间用户点「取消」
    book.cancelAll();
    await new Promise((resolve) => setTimeout(resolve, 80)); // 让取消轮询先生效
    releaseCdn(fileResponse("shared-body"));

    // 改前：interactive 令牌也被标 aborted → 这里 rejected
    const interactiveResult = await interactiveOutcome;
    expect(interactiveResult.ok).toBe(true);
    if (interactiveResult.ok) {
      expect(new TextDecoder().decode(interactiveResult.value)).toBe("shared-body");
    }
    expect(await bulkOutcome).toBeInstanceOf(QuarkDownloadCanceledError);
  });
});
