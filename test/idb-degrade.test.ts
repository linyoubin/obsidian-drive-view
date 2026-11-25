/**
 * 0.2.21 N6：md IDB 的 session 级降级闩。
 *
 * 连续失败 N 次（默认 3）后，本会话内**不再尝试连接 IDB**（避免每篇笔记都等重连退避），
 * 正文读取直接走网络（adapter 已隔离 cache 异常）。
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  MD_IDB_DISABLE_AFTER_FAILURES,
  MdContentStore,
  createIdbMdBackend,
} from "../src/store/MdContentStore";
import { QuarkReadOnlyAdapter } from "../src/adapter/QuarkReadOnlyAdapter";
import type { IndexEntry } from "../src/store/IndexStore";

function installBrokenIdb(): { opens: () => number; restore: () => void } {
  const globalScope = globalThis as unknown as { indexedDB?: unknown };
  const previous = globalScope.indexedDB;
  let opens = 0;
  const factory = {
    open: () => {
      opens += 1;
      const request: {
        result?: unknown;
        onsuccess?: (ev: unknown) => void;
        onerror?: (ev: unknown) => void;
        onupgradeneeded?: (ev: unknown) => void;
      } = {};
      setTimeout(() => {
        request.result = {
          objectStoreNames: { contains: () => true },
          close: () => undefined,
          transaction: () => {
            const error = new Error("database connection is closing");
            error.name = "InvalidStateError";
            throw error;
          },
        };
        request.onsuccess?.({});
      }, 0);
      return request;
    },
  };
  globalScope.indexedDB = factory;
  return {
    opens: () => opens,
    restore: () => {
      if (previous === undefined) delete globalScope.indexedDB;
      else globalScope.indexedDB = previous;
    },
  };
}

let restore: (() => void) | null = null;

afterEach(() => {
  restore?.();
  restore = null;
});

describe("0.2.21 N6 IDB session 级降级", () => {
  test("连续 3 次失败后第 4 次不再尝试连接（opens 计数不增）", async () => {
    const fake = installBrokenIdb();
    restore = fake.restore;
    const backend = createIdbMdBackend("degrade-db", { reopenDelaysMs: [0, 0] });

    for (let attempt = 0; attempt < MD_IDB_DISABLE_AFTER_FAILURES; attempt += 1) {
      await expect(backend.get("notes/a.md")).rejects.toBeDefined();
    }
    const opensAfterFailures = fake.opens();
    expect(opensAfterFailures).toBeGreaterThan(0);

    // 第 4 次：降级闩已落下 → 直接失败，不再 open
    await expect(backend.get("notes/a.md")).rejects.toThrow(/IDB|停用|跳过|disabled/i);
    expect(fake.opens()).toBe(opensAfterFailures);
  });

  test("降级后 adapter 的 read 仍走网络并返回正文", async () => {
    const fake = installBrokenIdb();
    restore = fake.restore;
    const backend = createIdbMdBackend("degrade-db-2", { reopenDelaysMs: [0, 0] });
    for (let attempt = 0; attempt < MD_IDB_DISABLE_AFTER_FAILURES; attempt += 1) {
      await expect(backend.get("notes/a.md")).rejects.toBeDefined();
    }
    const opensAtLatch = fake.opens();

    const entries: IndexEntry[] = [
      { path: "notes/a.md", type: "file", fid: "fa", parentFid: "", size: 9, mtime: 1 },
    ];
    const downloads: string[] = [];
    const adapter = new QuarkReadOnlyAdapter({
      index: { entries },
      cache: {
        has: () => false,
        get: () => null,
        getResourceUrl: () => "",
        put: () => ({ cached: true }),
        enqueuePrefetch: () => undefined,
      },
      client: {
        downloadFile: async (fid: string) => {
          downloads.push(fid);
          return new TextEncoder().encode("hello-md").buffer as ArrayBuffer;
        },
      },
      baseAdapter: {} as never,
      mdStore: new MdContentStore({ backend }),
      allowPrefetch: () => false,
    });

    await expect(adapter.read("notes/a.md")).resolves.toBe("hello-md");
    expect(downloads).toEqual(["fa"]);
    expect(fake.opens()).toBe(opensAtLatch);
  });
});
