/**
 * md 正文磁盘缓存（0.2.13）：记录/失效/淘汰/清空 + 适配器读取顺序。
 */

import { describe, expect, test } from "bun:test";

import { MemoryMdContentBackend, MdContentStore, DEFAULT_MD_CACHE_MAX_BYTES } from "../src/store/MdContentStore";

const bytes = (n: number): Uint8Array => new Uint8Array(n);

function makeStore(options: { maxBytes?: number; now?: () => number } = {}) {
  const backend = new MemoryMdContentBackend();
  const logs: Array<{ state: string; path?: string; count?: number }> = [];
  const store = new MdContentStore({
    backend,
    maxBytes: options.maxBytes,
    now: options.now ?? (() => 1000),
    onLog: (entry) => logs.push(entry),
  });
  return { store, backend, logs };
}

describe("MdContentStore：md 正文磁盘缓存", () => {
  test("put/get 往返：内容、size、mtime、fid、savedAt 都在", async () => {
    const { store } = makeStore();
    await store.put("notes/a.md", bytes(10), { fid: "f1", size: 10, mtime: 123 });
    const record = await store.get("notes/a.md");
    expect(record).toBeTruthy();
    expect(record!.bytes.byteLength).toBe(10);
    expect(record!.fid).toBe("f1");
    expect(record!.mtime).toBe(123);
    expect((await store.stats()).count).toBe(1);
  });

  test("validators 不一致（fid/size/mtime 任一变化）→ invalidate 删除", async () => {
    const { store } = makeStore();
    await store.put("a.md", bytes(5), { fid: "f1", size: 5, mtime: 100 });
    await store.put("b.md", bytes(5), { fid: "f2", size: 5, mtime: 100 });
    const removed = await store.invalidate([
      { path: "a.md", fid: "f1", size: 5, mtime: 100 }, // 一致
      { path: "b.md", fid: "f9", size: 5, mtime: 100 }, // fid 变了
    ]);
    expect(removed).toBe(1);
    expect(await store.get("a.md")).toBeTruthy();
    expect(await store.get("b.md")).toBeNull();
  });

  test("超限按 savedAt 最旧淘汰", async () => {
    let now = 100;
    const { store } = makeStore({ maxBytes: 20, now: () => now });
    now = 100;
    await store.put("old.md", bytes(10));
    now = 200;
    await store.put("mid.md", bytes(10));
    now = 300;
    await store.put("new.md", bytes(10));
    const record = await store.get("old.md");
    expect(record).toBeNull();
    expect(await store.get("new.md")).toBeTruthy();
    expect((await store.stats()).bytes).toBeLessThanOrEqual(20);
  });

  test("clear 清空整个 mdContent", async () => {
    const { store } = makeStore();
    await store.put("a.md", bytes(3));
    await store.clear();
    expect((await store.stats()).count).toBe(0);
  });

  test("默认上限 50MB", () => {
    expect(DEFAULT_MD_CACHE_MAX_BYTES).toBe(50 * 1024 * 1024);
  });
});
