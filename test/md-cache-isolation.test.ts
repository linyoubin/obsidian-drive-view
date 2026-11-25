/**
 * 0.2.19 B5（后半）：adapter 里 mdStore.get/put 必须被隔离——
 * 磁盘缓存（IDB）抛错**不得**导致正文读取失败；put 失败只记 `cause=cache-put`。
 */

import { describe, expect, test } from "bun:test";

import { QuarkReadOnlyAdapter } from "../src/adapter/QuarkReadOnlyAdapter";
import type { IndexEntry } from "../src/store/IndexStore";

const ENTRIES: IndexEntry[] = [
  { path: "notes/a.md", type: "file", fid: "fa", parentFid: "", size: 9, mtime: 1 },
];

const BODY = "hello-md";

function makeAdapter(mdStore: unknown, diag: Array<{ stage?: string; cause?: string; fields?: Record<string, unknown> }>) {
  return new QuarkReadOnlyAdapter({
    index: { entries: ENTRIES },
    cache: {
      has: () => false,
      get: () => null,
      getResourceUrl: () => "",
      put: () => ({ cached: true }),
      enqueuePrefetch: () => undefined,
    },
    client: { downloadFile: async () => new TextEncoder().encode(BODY).buffer as ArrayBuffer },
    baseAdapter: {} as never,
    diag: (entry) => diag.push(entry as never),
    mdStore: mdStore as never,
    allowPrefetch: () => false,
  });
}

function throwingStore(which: "get" | "put" | "delete") {
  const staleRecord = {
    path: "notes/a.md",
    bytes: new TextEncoder().encode("stale"),
    size: 5,
    mtime: 0,
    fid: "stale-fid",
    savedAt: 0,
  };
  return {
    // delete 分支：先返回一条 validators 不一致的记录，迫使 adapter 调 delete
    get: which === "get" ? async () => { throw new Error("idb get failed"); } : async () => (which === "delete" ? staleRecord : null),
    put: which === "put" ? async () => { throw new Error("idb put failed"); } : async () => undefined,
    delete: which === "delete" ? async () => { throw new Error("idb delete failed"); } : async () => undefined,
    invalidate: async () => 0,
    stats: async () => ({ count: 0, bytes: 0 }),
    clear: async () => undefined,
  };
}

describe("0.2.19 B5 mdStore 异常隔离", () => {
  test("mdStore.get 抛错 → read 仍下载并返回正文", async () => {
    const diag: Array<{ stage?: string; cause?: string }> = [];
    const adapter = makeAdapter(throwingStore("get"), diag);

    await expect(adapter.read("notes/a.md")).resolves.toBe(BODY);
    // 读缓存失败记一条 info 级 cache 日志（不改读行为）
    expect(diag.some((entry) => entry.stage === "cache" && entry.cause === "cache-get")).toBe(true);
  });

  test("mdStore.put 抛错 → read 仍返回正文，日志记 cause=cache-put", async () => {
    const diag: Array<{ stage?: string; cause?: string; fields?: Record<string, unknown> }> = [];
    const adapter = makeAdapter(throwingStore("put"), diag);

    await expect(adapter.read("notes/a.md")).resolves.toBe(BODY);
    const putLog = diag.find((entry) => entry.stage === "cache" && entry.cause === "cache-put");
    expect(putLog).toBeDefined();
    expect(Number(putLog!.fields?.bytes)).toBe(BODY.length);
    // 不得因此多记一条 read 失败
    expect(diag.some((entry) => entry.stage === "read" && entry.cause)).toBe(false);
  });

  test("mdStore.delete 抛错（失效条目）→ 仍按网络重新下载", async () => {
    const diag: Array<{ stage?: string; cause?: string }> = [];
    const adapter = makeAdapter(throwingStore("delete"), diag);
    await expect(adapter.read("notes/a.md")).resolves.toBe(BODY);
    expect(diag.some((entry) => entry.stage === "read" && entry.cause)).toBe(false);
  });
});
