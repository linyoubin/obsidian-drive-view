/**
 * 下载闸门与下载错误策略单测（0.2.4 A2/A3/A5/A6/A7）。
 *
 * 全部用注入的假 transport / 假时钟，不碰网络与真实 DOM。
 */

import { describe, expect, test } from "bun:test";

import {
  DownloadGate,
  DownloadGateError,
  normalizeGateConcurrency,
} from "../src/client/downloadGate";
import {
  QuarkAuthError,
  QuarkClient,
  QuarkDownloadCanceledError,
  QuarkDownloadTimeoutError,
  QuarkFileTooLargeError,
  TokenBucket,
  type QuarkHttpResponse,
  type QuarkTransport,
} from "../src/client/QuarkClient";
import { QuarkReadOnlyAdapter, diagCauseOf } from "../src/adapter/QuarkReadOnlyAdapter";
import { formatDiagLine } from "../src/utils/diagLog";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const fastBucket = (): TokenBucket => new TokenBucket({ ratePerSecond: 10000, sleep: async () => {} });
const fastSleep = async (): Promise<void> => {};

/** 0.2.20 N7：日志里 sha8 的期望值（前 8 字节的 sha256 前 8 位 hex）。 */
async function sha8Of(text: string, count = 8): Promise<string> {
  const bytes = new TextEncoder().encode(text).slice(0, count);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 8);
}

function jsonResponse(status: number, body: unknown): QuarkHttpResponse {
  return { status, headers: {}, text: JSON.stringify(body) };
}

function fileResponse(text: string): QuarkHttpResponse {
  const bytes = new TextEncoder().encode(text);
  return { status: 200, headers: {}, arrayBuffer: bytes.buffer as ArrayBuffer };
}

describe("DownloadGate：并发上限与排队（A2）", () => {
  test("50 个并发任务：实际并发峰值 ≤ 配置值 2，其余排队", async () => {
    const gate = new DownloadGate({ concurrency: 2 });
    let running = 0;
    let observedPeak = 0;
    const tasks = Array.from({ length: 50 }, (_, index) =>
      gate.run(async () => {
        running += 1;
        observedPeak = Math.max(observedPeak, running);
        await new Promise((resolve) => setTimeout(resolve, 1));
        running -= 1;
        return index;
      })
    );
    const results = await Promise.all(tasks);
    expect(observedPeak).toBeLessThanOrEqual(2);
    expect(gate.peak).toBeLessThanOrEqual(2);
    // 0.2.16：给 interactive 强制留 1 槽 → bg/bulk 峰值 = concurrency-1
    expect(gate.peak).toBe(1);
    expect(results.length).toBe(50);
    expect(gate.active).toBe(0);
    expect(gate.pending).toBe(0);
  });

  test("FIFO：并发 1 时按提交顺序执行", async () => {
    const gate = new DownloadGate({ concurrency: 1 });
    const order: number[] = [];
    const tasks = [1, 2, 3].map((n) => gate.run(async () => order.push(n)));
    await Promise.all(tasks);
    expect(order).toEqual([1, 2, 3]);
  });

  test("高优先级插队（同优先级仍 FIFO）", async () => {
    const gate = new DownloadGate({ concurrency: 1 });
    const order: string[] = [];
    const first = deferred<void>();
    const running = gate.run(async () => {
      order.push("running");
      await first.promise;
    });
    const normal = gate.run(async () => order.push("normal"));
    const high = gate.run(async () => order.push("high"), { priority: "high" });
    first.resolve();
    await Promise.all([running, normal, high]);
    expect(order).toEqual(["running", "high", "normal"]);
  });

  test("401 熔断：清空排队任务并拒绝；新任务直接快速失败", async () => {
    const gate = new DownloadGate({ concurrency: 1, now: () => 1000 });
    const release = deferred<void>();
    const running = gate.run(async () => {
      await release.promise;
      return "ok";
    });
    const queuedA = gate.run(async () => "a");
    const queuedB = gate.run(async () => "b");
    gate.failAuth(60_000);

    await expect(queuedA).rejects.toBeInstanceOf(DownloadGateError);
    await expect(queuedB).rejects.toBeInstanceOf(DownloadGateError);
    await expect(gate.run(async () => "c")).rejects.toMatchObject({ kind: "auth-expired" });
    expect(gate.isAuthExpired()).toBe(true);
    expect(gate.authRetryAfterMs()).toBe(60_000);
    release.resolve();
    await expect(running).resolves.toBe("ok");

    gate.resetAuth();
    await expect(gate.run(async () => "d")).resolves.toBe("d");
  });

  test("取消信号：已取消的任务直接拒绝，不占并发", async () => {
    const gate = new DownloadGate({ concurrency: 1 });
    const signal = { aborted: true };
    await expect(gate.run(async () => 1, { signal })).rejects.toMatchObject({ kind: "aborted" });
    expect(gate.active).toBe(0);
  });

  test("setConcurrency：clamp（默认 4，范围 1–6）与「调小后不再多开」", async () => {
    expect(normalizeGateConcurrency(0)).toBe(1);
    expect(normalizeGateConcurrency(9)).toBe(6);
    expect(normalizeGateConcurrency(undefined)).toBe(4);
    expect(normalizeGateConcurrency(2.6)).toBe(2);
    const gate = new DownloadGate({ concurrency: 3 });
    expect(gate.setConcurrency(1)).toBe(1);
    expect(gate.setConcurrency(6)).toBe(6);
  });

  test("20 个任务、配置 4 → 并发峰值 ≤4（A6′/A2 口径）", async () => {
    const gate = new DownloadGate({ concurrency: 4 });
    let running = 0;
    let observedPeak = 0;
    const tasks = Array.from({ length: 20 }, () =>
      gate.run(async () => {
        running += 1;
        observedPeak = Math.max(observedPeak, running);
        await new Promise((resolve) => setTimeout(resolve, 1));
        running -= 1;
      })
    );
    await Promise.all(tasks);
    expect(observedPeak).toBeLessThanOrEqual(4);
    expect(gate.peak).toBeLessThanOrEqual(4);
    // 0.2.11：未标优先级 → background 通道（上限 2）
    expect(gate.peak).toBe(2);
  });

  test("任务异常不泄漏并发槽：失败后下一个仍能跑", async () => {
    const gate = new DownloadGate({ concurrency: 1 });
    await expect(gate.run(async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    await expect(gate.run(async () => "next")).resolves.toBe("next");
    expect(gate.active).toBe(0);
    expect(gate.started).toBe(2);
  });
});

describe("QuarkClient：超时重试 / 23018 / 401 熔断（A3/A5/A6）", () => {
  function makeClient(
    handler: (url: string, attempt: number) => QuarkHttpResponse | Promise<QuarkHttpResponse>,
    extra: Partial<{ onAuthExpired: () => void; gate: DownloadGate }> = {}
  ) {
    const calls: string[] = [];
    const transport: QuarkTransport = async (request) => {
      calls.push(request.url);
      return handler(request.url, calls.length);
    };
    const client = new QuarkClient({
      transport,
      limiter: fastBucket(),
      sleep: fastSleep,
      ...extra,
    });
    return { client, calls };
  }

  const isDownloadPost = (url: string): boolean => url.includes("/file/download");

  test("超时重试 1 次成功：transport 被调用 2 次", async () => {
    const { client, calls } = makeClient((url, attempt) => {
      if (isDownloadPost(url)) {
        if (attempt === 1) throw new Error("Request failed. 请求超时");
        return jsonResponse(200, { code: 0, data: [{ download_url: "https://cdn.example/f1" }] });
      }
      return fileResponse("hello");
    });
    const bytes = await client.downloadFile("fid-1");
    expect(new TextDecoder().decode(bytes)).toBe("hello");
    expect(calls.length).toBe(3); // 第一跳(超时) → 重试第一跳 → 第二跳
  });

  test("连续超时：抛 QuarkDownloadTimeoutError(retried=true)", async () => {
    const { client, calls } = makeClient(() => {
      throw new Error("Request failed. 请求超时");
    });
    await expect(client.downloadFile("fid-1")).rejects.toBeInstanceOf(QuarkDownloadTimeoutError);
    try {
      await client.downloadFile("fid-2");
    } catch (error) {
      expect((error as QuarkDownloadTimeoutError).retried).toBe(true);
    }
    expect(calls.length).toBe(4); // 每次下载 1 次 + 重试 1 次
  });

  test("code=23018：映射为 QuarkFileTooLargeError，文案中性、不重试", async () => {
    const { client, calls } = makeClient((url) => {
      if (isDownloadPost(url)) return jsonResponse(200, { code: 23018, message: "download file size limit" });
      return fileResponse("x");
    });
    await expect(client.downloadFile("fid-big")).rejects.toBeInstanceOf(QuarkFileTooLargeError);
    expect(calls.filter(isDownloadPost).length).toBe(1);
    try {
      await client.downloadFile("fid-big");
    } catch (error) {
      expect((error as QuarkFileTooLargeError).message).toContain("code=23018");
      expect((error as QuarkFileTooLargeError).message).toContain("可能超过单文件下载上限");
    }
  });

  test("连续 10 个 401：只回调一次，之后快速失败且不再发请求", async () => {
    let notified = 0;
    const { client, calls } = makeClient(
      () => jsonResponse(401, { code: 31001, message: "require login [guest]" }),
      { onAuthExpired: () => { notified += 1; } }
    );
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, index) => client.downloadFile(`fid-${index}`))
    );
    expect(results.every((item) => item.status === "rejected")).toBe(true);
    expect(notified).toBe(1);
    expect(client.isAuthExpired()).toBe(true);
    const callsAfterStorm = calls.length;
    await expect(client.downloadFile("fid-late")).rejects.toBeInstanceOf(DownloadGateError);
    expect(calls.length).toBe(callsAfterStorm);
  });

  test("调用方取消 = 只放弃自己的等待（不取消共享下载，0.2.5 A5）", async () => {
    const gate = { promise: null as unknown as Promise<QuarkHttpResponse>, resolve: (_v: QuarkHttpResponse) => {} };
    const downstream = new Promise<QuarkHttpResponse>((resolve) => {
      gate.resolve = resolve;
    });
    let calls = 0;
    const transport: QuarkTransport = async (request) => {
      calls += 1;
      if (request.url.includes("/file/download")) {
        return jsonResponse(200, { code: 0, data: [{ download_url: "https://cdn.example/f" }] });
      }
      return downstream;
    };
    const client = new QuarkClient({ transport, limiter: fastBucket(), sleep: fastSleep });
    const signal = { aborted: false };
    const canceled = client.downloadFile("fid-1", { signal });
    const other = client.downloadFile("fid-1");
    signal.aborted = true;
    await expect(canceled).rejects.toBeInstanceOf(QuarkDownloadCanceledError);
    gate.resolve(fileResponse("shared"));
    await expect(other).resolves.toBeInstanceOf(ArrayBuffer);
    expect(calls).toBe(2); // 共享下载只发 1 次签名 URL + 1 次 CDN
  });
});

describe("QuarkReadOnlyAdapter：取消下载（A4′）", () => {
  function makeAdapter(downloadImpl: (fid: string, options?: { signal?: { aborted: boolean } | null }) => Promise<ArrayBuffer>) {
    const puts: string[] = [];
    const logs: Array<{ cause?: string; level?: string; started: number }> = [];
    const index = {
      entries: [{ path: "notes/a.md", type: "file" as const, fid: "fid-a", parentFid: "0", size: 2048, mtime: 1 }],
    };
    const cache = {
      has: () => false,
      get: () => null,
      getResourceUrl: () => "",
      put: (path: string) => { puts.push(path); return { cached: true }; },
      enqueuePrefetch: () => undefined,
    };
    let started = 0;
    let lastToken: { aborted: boolean } | null = null;
    const adapter = new QuarkReadOnlyAdapter({
      index,
      cache,
      client: { downloadFile: downloadImpl },
      baseAdapter: {} as never,
      diag: (entry) => logs.push({ cause: entry.cause, level: entry.level, started }),
      downloadUi: {
        begin: () => {
          started += 1;
          lastToken = { aborted: false };
          return lastToken;
        },
        end: () => undefined,
      },
    });
    return { adapter, puts, logs, cancel: () => { if (lastToken) lastToken.aborted = true; } };
  }

  test("取消后不写缓存、不重试、抛 canceled，日志 cause=canceled", async () => {
    let calls = 0;
    const { adapter, puts, logs, cancel } = makeAdapter(async () => {
      calls += 1;
      cancel(); // 下载返回前用户点了「取消」
      return new TextEncoder().encode("hello").buffer as ArrayBuffer;
    });
    await expect(adapter.read("/notes/a.md")).rejects.toBeInstanceOf(QuarkDownloadCanceledError);
    expect(calls).toBe(1);
    expect(puts.length).toBe(0);
    const errorLogs = logs.filter((log) => log.level !== "info");
    expect(errorLogs.length).toBe(1);
    expect(errorLogs[0].cause).toBe("canceled");
    // 0.2.10：入口埋点也在（hit/size + decode），正文不出现
    expect(logs.some((log) => log.level === "info")).toBe(true);
  });

  test("同一错误对象只记一条日志（download 与 read 不重复记）", async () => {
    const { adapter, logs } = makeAdapter(async () => {
      throw new Error("Request failed. 请求超时");
    });
    await expect(adapter.read("/notes/a.md")).rejects.toThrow();
    const errorLogs = logs.filter((log) => log.level !== "info");
    expect(errorLogs.length).toBe(1);
    expect(errorLogs[0].cause).toBe("timeout");
  });

  test("diagCauseOf：各错误类型映射到 cause", () => {
    expect(diagCauseOf(new QuarkFileTooLargeError("x", { code: 23018 }))).toBe("size");
    expect(diagCauseOf(new QuarkAuthError("401"))).toBe("auth");
    expect(diagCauseOf(new QuarkDownloadCanceledError())).toBe("canceled");
    expect(diagCauseOf(new QuarkDownloadTimeoutError("t", true))).toBe("timeout");
    expect(diagCauseOf(new DownloadGateError("auth-expired", "x"))).toBe("auth");
    expect(diagCauseOf(new Error("other"))).toBe("unknown");
  });
});

// ------------------------------------------------------------------ 0.2.10 埋点：read → download → decode

describe("0.2.10 埋点：read / decode / download 两跳", () => {
  function diagAdapter(text: string, opts: { signalAbort?: boolean } = {}) {
    const entries: Array<{ stage: string; fields?: Record<string, unknown>; message?: string; level?: string }> = [];
    const adapter = new QuarkReadOnlyAdapter({
      index: {
        entries: [{ path: "notes/a.md", type: "file" as const, fid: "fa", parentFid: "0", size: text.length, mtime: 1 }],
      },
      cache: {
        has: () => false,
        get: () => null,
        getResourceUrl: () => "",
        put: () => ({ cached: true }),
        enqueuePrefetch: () => undefined,
      },
      client: {
        downloadFile: async () => new TextEncoder().encode(text).buffer as ArrayBuffer,
      },
      baseAdapter: {} as never,
      diag: (entry: any) => entries.push(entry),
    });
    return { adapter, entries };
  }

  test("read 入口记 hit/size；decode 只记 bytes/chars/sha8（无任何可还原字节）", async () => {
    const longText = "标题\n" + "字".repeat(100);
    const { adapter, entries } = diagAdapter(longText);
    const text = await adapter.read("/notes/a.md");
    expect(text).toBe(longText);
    const readEntry = entries.find((entry) => entry.stage === "read")!;
    expect(readEntry.fields).toMatchObject({ hit: false, size: longText.length });
    const decode = entries.find((entry) => entry.stage === "decode")!;
    expect(decode.fields!.bytes).toBe(new TextEncoder().encode(longText).length);
    expect(decode.fields!.chars).toBe(longText.length);
    expect(decode.fields!.sample).toBeUndefined();
    expect(decode.fields!.firstBytes).toBeUndefined();
    expect(String(decode.fields!.sha8)).toMatch(/^[0-9a-f]{8}$/);
    expect(String(decode.fields!.sha8)).toBe(await sha8Of(longText));
  });

  test("decode 日志不可还原正文：无 sample、无原始 hex，只有不可逆 sha8（0.2.20 N7）", async () => {
    // 独特字符串：只要日志里出现任意前缀/字节 hex 就能被抓到
    const secret = "SECRET-BODY-甲-9f3c";
    const secretTail = "第二行内容也绝不能出现";
    const text = `${secret}\n${secretTail}`;
    const { adapter, entries } = diagAdapter(text);
    await adapter.read("/notes/a.md");
    const decode = entries.find((entry) => entry.stage === "decode")!;
    expect(decode.fields!.sample).toBeUndefined();
    expect(decode.fields!.firstBytes).toBeUndefined();
    // "SECRET-B" 的 UTF-8 字节 hex（旧实现会写进 firstBytes）
    expect(JSON.stringify(decode.fields)).not.toContain("5345435245542d42");
    expect(String(decode.fields!.sha8)).toBe(await sha8Of(secret));

    const line = formatDiagLine(
      {
        level: "info",
        stage: "decode",
        path: "/notes/a.md",
        fid: "fa",
        message: decode.message ?? "",
        fields: decode.fields as Record<string, string | number | boolean>,
      },
      new Date("2026-11-20T08:00:00.000Z")
    );
    expect(line).not.toContain(secret);
    expect(line).not.toContain("SECRET");
    expect(line).not.toContain(secretTail);
    expect(line).not.toContain("5345435245542d42");
    expect(line).toContain("sha8=");
    expect(line).not.toContain("firstBytes=");
    expect(line).not.toContain("sample=");
  });

  test("空内容：decode 记 cause=empty、不带 sample（正文绝不落日志）", async () => {
    const { adapter, entries } = diagAdapter("");
    await adapter.read("/notes/a.md");
    const decode = entries.find((entry) => entry.stage === "decode")!;
    expect(decode.fields).toMatchObject({ bytes: 0, chars: 0 });
    expect(decode.fields!.sample).toBeUndefined();
    expect(decode.message).toBe("empty-body");
  });

  test("download 两跳：hop=1 带 status/code/urlLen；hop=2 带 contentType/bytes/sha8（无原始字节）", async () => {
    const entries: Array<{ stage: string; fields?: Record<string, unknown> }> = [];
    const calls: string[] = [];
    const transport: QuarkTransport = async (request) => {
      calls.push(request.url);
      if (request.url.includes("/file/download")) {
        return { status: 200, headers: {}, text: JSON.stringify({ code: 0, data: [{ download_url: "https://cdn.example/f1" }] }) };
      }
      return {
        status: 200,
        headers: { "Content-Type": "text/markdown" },
        arrayBuffer: new TextEncoder().encode("# hi").buffer as ArrayBuffer,
      };
    };
    const client = new QuarkClient({
      transport,
      limiter: fastBucket(),
      sleep: fastSleep,
      diag: (entry: any) => entries.push(entry),
    });
    const bytes = await client.downloadFile("fid-1", { path: "notes/a.md" });
    expect(new TextDecoder().decode(bytes)).toBe("# hi");
    const hop1 = entries.find((entry) => entry.fields?.hop === 1)!;
    expect(hop1.fields).toMatchObject({ status: 200, code: 0 });
    expect(Number(hop1.fields!.urlLen)).toBeGreaterThan(0);
    const hop2 = entries.find((entry) => entry.fields?.hop === 2)!;
    expect(hop2.fields).toMatchObject({ status: 200, contentType: "text/markdown", bytes: 4 });
    // 0.2.20 N7：不再写 content 的原始字节 hex
    expect(hop2.fields!.firstBytes).toBeUndefined();
    expect(JSON.stringify(hop2.fields)).not.toContain("23206869"); // "# hi" 的前 4 字节 hex
    expect(String(hop2.fields!.sha8)).toBe(await sha8Of("# hi"));
  });
});

// ------------------------------------------------------------------ 0.2.11 双优先级

describe("DownloadGate：双优先级（0.2.11）", () => {
  test("5 个 background 排队 + 1 个 interactive → interactive 先执行", async () => {
    const gate = new DownloadGate({ concurrency: 4 });
    const order: string[] = [];
    const task = (name: string) => async () => {
      order.push(name);
      await new Promise((resolve) => setTimeout(resolve, 2));
    };
    const background = Array.from({ length: 5 }, (_, i) => gate.run(task(`bg${i}`), { priority: "background" }));
    // 先启动 2 个 bg；再插 1 个 i
    await new Promise((resolve) => setTimeout(resolve, 1));
    const interactive = gate.run(task("i0"), { priority: "interactive" });
    await Promise.all([...background, interactive]);
    // 前两个是 bg（已在跑），第三个必须是 i，不能是 bg2
    expect(order.slice(0, 3)).toEqual(["bg0", "bg1", "i0"]);
    expect(order).toHaveLength(6);
  });

  test("gate 事件：queued/acquired 带 prio 与 waitMs，abandoned 用于取消", async () => {
    const events: Array<{ state: string; priority: string; waitMs: number }> = [];
    const gate = new DownloadGate({ concurrency: 1, onEvent: (event) => events.push(event) });
    await gate.run(async () => "ok", { priority: "interactive" });
    expect(events.some((event) => event.state === "queued" && event.priority === "i")).toBe(true);
    expect(events.some((event) => event.state === "acquired" && event.priority === "i")).toBe(true);
    expect(events.every((event) => event.waitMs >= 0)).toBe(true);
    const signal = { aborted: true };
    await expect(gate.run(async () => "x", { priority: "background", signal })).rejects.toThrow("取消");
    expect(events.some((event) => event.state === "abandoned" && event.priority === "bg")).toBe(true);
  });
});

// ------------------------------------------------------------------ 0.2.13 三级优先级

describe("DownloadGate：三级优先级（0.2.13）", () => {
  test("bulk 让位于 background：bg 先于剩余 bulk 执行", async () => {
    const gate = new DownloadGate({ concurrency: 2 });
    const order: string[] = [];
    const task = (name: string) => async () => {
      order.push(name);
      await new Promise((resolve) => setTimeout(resolve, 2));
    };
    const bulk = Array.from({ length: 4 }, (_, i) => gate.run(task(`bulk${i}`), { priority: "bulk" }));
    await new Promise((resolve) => setTimeout(resolve, 1));
    const bg = gate.run(task("bg0"), { priority: "background" });
    await Promise.all([...bulk, bg]);
    expect(order.indexOf("bg0")).toBeLessThan(order.indexOf("bulk2"));
    expect(order).toHaveLength(5);
  });

  test("interactive 到达时 bulk 让路", async () => {
    const gate = new DownloadGate({ concurrency: 2 });
    const order: string[] = [];
    const task = (name: string) => async () => {
      order.push(name);
      await new Promise((resolve) => setTimeout(resolve, 1));
    };
    const bulk = Array.from({ length: 4 }, (_, i) => gate.run(task(`bulk${i}`), { priority: "bulk" }));
    await new Promise((resolve) => setTimeout(resolve, 1));
    const interactive = gate.run(task("i0"), { priority: "interactive" });
    await Promise.all([...bulk, interactive]);
    const iAt = order.indexOf("i0");
    // 0.2.16：单 bulk 槽（lowCap=1）→ i 在第 2 位之前启动，且先于下一个 bulk
    expect(iAt).toBeGreaterThanOrEqual(1);
    expect(iAt).toBeLessThan(order.indexOf("bulk1"));
  });
});

// ------------------------------------------------------------------ 0.2.18 B4 failAuth 清空三队列

describe("DownloadGate：failAuth 清空 interactive + background + bulk（0.2.18 B4）", () => {
  test("pauseBulk 后 failAuth：bulk 队列立即清零、任务收 auth-expired、无悬挂 promise", async () => {
    const events: Array<{ state: string; priority: string }> = [];
    // pauseBulk 保证 bulk 任务**停在队列里**，不会靠另一个任务 .finally 的 pump 副作用被拒
    const gate = new DownloadGate({ concurrency: 4, now: () => 1000, onEvent: (event) => events.push(event) });
    gate.pauseBulk(3000);

    let settled = 0;
    const queued = gate.run(async () => "never", { priority: "bulk" });
    const tracked = queued.then(
      () => {
        settled += 1;
        return "resolved";
      },
      (error) => {
        settled += 1;
        throw error;
      }
    );
    expect(gate.pending).toBe(1);

    gate.failAuth(60_000);

    // 改前：bulk 队列没被清，pending 仍是 1，要等别的任务 finally 才拒
    expect(gate.pending).toBe(0);
    await expect(tracked).rejects.toMatchObject({ kind: "auth-expired" });
    expect(settled).toBe(1);
    expect(gate.bulkActiveCount).toBe(0);
    expect(events.some((event) => event.priority === "bulk" && event.state === "abandoned")).toBe(true);
  });

  test("三个队列同时排空：interactive + background + bulk 全部以 auth-expired 拒绝", async () => {
    const gate = new DownloadGate({ concurrency: 1, now: () => 1000 });
    const release = deferred<void>();
    const running = gate.run(
      async () => {
        await release.promise;
        return "run";
      },
      { priority: "interactive" }
    );
    const interactive = gate.run(async () => "i2", { priority: "interactive" });
    const background = gate.run(async () => "bg", { priority: "background" });
    const bulk = gate.run(async () => "bulk", { priority: "bulk" });
    expect(gate.pending).toBe(3);

    gate.failAuth(1000);
    expect(gate.pending).toBe(0);
    await expect(interactive).rejects.toMatchObject({ kind: "auth-expired" });
    await expect(background).rejects.toMatchObject({ kind: "auth-expired" });
    await expect(bulk).rejects.toMatchObject({ kind: "auth-expired" });

    release.resolve();
    await expect(running).resolves.toBe("run");
  });
});

// ------------------------------------------------------------------ 0.2.16 队列调度

describe("DownloadGate：0.2.16 留槽与让路", () => {
  test("interactive 队列非空时 bulk/bg 不启动新任务（i 先执行）", async () => {
    const gate = new DownloadGate({ concurrency: 4, bulkLimit: 2, backgroundLimit: 2 });
    const order: string[] = [];
    const task = (name: string) => async () => {
      order.push(name);
      await new Promise((resolve) => setTimeout(resolve, 2));
    };
    const bulks = Array.from({ length: 5 }, (_, i) => gate.run(task(`bulk${i}`), { priority: "bulk" }));
    const bgs = Array.from({ length: 2 }, (_, i) => gate.run(task(`bg${i}`), { priority: "background" }));
    await new Promise((resolve) => setTimeout(resolve, 1));
    const i = gate.run(task("i0"), { priority: "interactive" });
    await Promise.all([...bulks, ...bgs, i]);
    // i 必须出现在队列前几个中（bulk/bg 不再占用新槽位）
    expect(order.indexOf("i0")).toBeLessThan(order.indexOf("bulk3"));
    expect(order.indexOf("i0")).toBeLessThanOrEqual(3);
  });

  test("bulk+bg 并发合计 ≤ concurrency-1（10 个 bulk、并发 4 → 峰值 ≤3）", async () => {
    const gate = new DownloadGate({ concurrency: 4 });
    let active = 0;
    let peak = 0;
    const tasks = Array.from({ length: 10 }, () =>
      gate.run(async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active -= 1;
      }, { priority: "bulk" })
    );
    await Promise.all(tasks);
    expect(peak).toBeLessThanOrEqual(3);
    expect(gate.peak).toBeLessThanOrEqual(3);
  });

  test("点击让路：pauseBulk 3 秒内 bulk 不启动，3 秒后恢复", async () => {
    let now = 0;
    const gate = new DownloadGate({ concurrency: 4, now: () => now });
    const order: string[] = [];
    gate.pauseBulk(3000);
    const task = (name: string) => async () => {
      order.push(name);
    };
    const bulk = gate.run(task("bulk0"), { priority: "bulk" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual([]); // 3 秒内不启动
    now = 3001;
    gate.resumeBulk();
    await bulk;
    expect(order).toEqual(["bulk0"]);
  });

  test("点击瞬间 5 个 bulk 排队：interactive 在 1 个 pump 周期内启动", async () => {
    const gate = new DownloadGate({ concurrency: 4, bulkLimit: 1 });
    const order: string[] = [];
    const task = (name: string) => async () => {
      order.push(name);
      await new Promise((resolve) => setTimeout(resolve, 1));
    };
    const bulks = Array.from({ length: 5 }, (_, i) => gate.run(task(`bulk${i}`), { priority: "bulk" }));
    const i = gate.run(task("i0"), { priority: "interactive" });
    await Promise.all([...bulks, i]);
    // i 在 bulk1 之前即被启动（同一个 pump 周期内）
    expect(order.indexOf("i0")).toBeLessThan(order.indexOf("bulk1"));
  });
});
