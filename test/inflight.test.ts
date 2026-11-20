/**
 * in-flight 去重单测（0.2.5 A2/A3/A4/A5）。
 *
 * 纯逻辑：同一个 key 只执行一次 task；完成（成功/失败）后清理，允许重新发起。
 */

import { describe, expect, test } from "bun:test";

import { DownloadGate } from "../src/client/downloadGate";
import { InflightRequests } from "../src/client/inflight";
import {
  QuarkClient,
  QuarkDownloadCanceledError,
  TokenBucket,
  type QuarkHttpResponse,
  type QuarkTransport,
} from "../src/client/QuarkClient";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("InflightRequests：同 key 合并（A2/A3/A4）", () => {
  test("同 key 并发 10 次只执行 1 次，10 个调用方共享结果", async () => {
    const inflight = new InflightRequests();
    let executions = 0;
    const gate = deferred<string>();
    const callers = Array.from({ length: 10 }, () =>
      inflight.run("fid-1", async () => {
        executions += 1;
        return gate.promise;
      })
    );
    expect(executions).toBe(1);
    expect(inflight.size).toBe(1);
    gate.resolve("data");
    const results = await Promise.all(callers);
    expect(results.every((value) => value === "data")).toBe(true);
  });

  test("不同 key 各自执行（不互相阻塞）", async () => {
    const inflight = new InflightRequests();
    const executed: string[] = [];
    const a = deferred<string>();
    const b = deferred<string>();
    const pa = inflight.run("a", async () => {
      executed.push("a");
      return a.promise;
    });
    const pb = inflight.run("b", async () => {
      executed.push("b");
      return b.promise;
    });
    expect(executed.sort()).toEqual(["a", "b"]);
    expect(inflight.size).toBe(2);
    a.resolve("A");
    b.resolve("B");
    await expect(Promise.all([pa, pb])).resolves.toEqual(["A", "B"]);
  });

  test("完成后清理：再次 run 会重新执行（不复用旧 Promise）", async () => {
    const inflight = new InflightRequests();
    let executions = 0;
    const first = await inflight.run("fid-1", async () => {
      executions += 1;
      return "first";
    });
    expect(first).toBe("first");
    expect(inflight.has("fid-1")).toBe(false);
    const second = await inflight.run("fid-1", async () => {
      executions += 1;
      return "second";
    });
    expect(second).toBe("second");
    expect(executions).toBe(2);
  });

  test("失败也清理：错误传给所有等待者，下次可重试", async () => {
    const inflight = new InflightRequests();
    let executions = 0;
    const shared = () => {
      executions += 1;
      return Promise.reject(new Error("boom"));
    };
    const p1 = inflight.run("fid-x", shared);
    const p2 = inflight.run("fid-x", shared);
    await expect(p1).rejects.toThrow("boom");
    await expect(p2).rejects.toThrow("boom");
    expect(executions).toBe(1);
    expect(inflight.has("fid-x")).toBe(false);
    await expect(inflight.run("fid-x", async () => "recovered")).resolves.toBe("recovered");
  });

  test("同步抛错的 task 不会留下脏表项", async () => {
    const inflight = new InflightRequests();
    await expect(
      inflight.run("bad", (() => {
        throw new Error("sync boom");
      }) as () => Promise<never>)
    ).rejects.toThrow("sync boom");
    expect(inflight.has("bad")).toBe(false);
  });

  test("clear() 清空表（不会取消已执行的任务）", async () => {
    const inflight = new InflightRequests();
    const gate = deferred<string>();
    const pending = inflight.run("k", () => gate.promise);
    expect(inflight.size).toBe(1);
    inflight.clear();
    expect(inflight.size).toBe(0);
    gate.resolve("ok");
    await expect(pending).resolves.toBe("ok");
  });
});

describe("QuarkClient：同 fid 重复点击只发一次下载（A2/A3/A5）", () => {
  const fastBucket = () => new TokenBucket({ ratePerSecond: 10000, sleep: async () => {} });

  function jsonResponse(status: number, body: unknown): QuarkHttpResponse {
    return { status, headers: {}, text: JSON.stringify(body) };
  }
  function fileResponse(text: string): QuarkHttpResponse {
    const bytes = new TextEncoder().encode(text);
    return { status: 200, headers: {}, arrayBuffer: bytes.buffer as ArrayBuffer };
  }

  test("同一 fid 10 次并发点击：/file/download 只发 1 次，10 个调用方都拿到内容", async () => {
    let downloadPosts = 0;
    let totalCalls = 0;
    const transport: QuarkTransport = async (request) => {
      totalCalls += 1;
      if (request.url.includes("/file/download")) {
        downloadPosts += 1;
        return jsonResponse(200, { code: 0, data: [{ download_url: "https://cdn.example/f" }] });
      }
      return fileResponse("hello");
    };
    const client = new QuarkClient({ transport, limiter: fastBucket(), sleep: async () => {} });
    const results = await Promise.all(
      Array.from({ length: 10 }, () => client.downloadFile("fid-same"))
    );
    expect(downloadPosts).toBe(1); // 关键断言：10 次点击 → 1 次下载请求
    expect(totalCalls).toBe(2); // 1 次签名 URL + 1 次 CDN
    expect(results.every((bytes) => new TextDecoder().decode(bytes) === "hello")).toBe(true);
  });

  test("不同 fid 并行各自下载，且并发仍受闸门 ≤2 约束", async () => {
    let running = 0;
    let peak = 0;
    const transport: QuarkTransport = async (request) => {
      if (request.url.includes("/file/download")) {
        return jsonResponse(200, { code: 0, data: [{ download_url: "https://cdn.example/x" }] });
      }
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 2));
      running -= 1;
      return fileResponse("x");
    };
    const gate = new DownloadGate({ concurrency: 2 });
    const client = new QuarkClient({ transport, limiter: fastBucket(), sleep: async () => {}, gate });
    await Promise.all(["a", "b", "c", "d"].map((fid) => client.downloadFile(fid)));
    expect(peak).toBeLessThanOrEqual(2);
  });

  test("取消只放弃该调用方：共享下载继续，另一个调用方仍拿到结果（A5）", async () => {
    const downstream = deferred<QuarkHttpResponse>();
    const transport: QuarkTransport = async (request) => {
      if (request.url.includes("/file/download")) {
        return jsonResponse(200, { code: 0, data: [{ download_url: "https://cdn.example/f" }] });
      }
      return downstream.promise;
    };
    const client = new QuarkClient({ transport, limiter: fastBucket(), sleep: async () => {} });
    const signal = { aborted: false };
    const canceled = client.downloadFile("fid-shared", { signal });
    const other = client.downloadFile("fid-shared");
    signal.aborted = true;
    await expect(canceled).rejects.toBeInstanceOf(QuarkDownloadCanceledError);
    downstream.resolve(fileResponse("shared-data"));
    const bytes = await other;
    expect(new TextDecoder().decode(bytes)).toBe("shared-data");
  });
});


