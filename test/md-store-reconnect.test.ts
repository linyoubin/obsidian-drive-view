/**
 * 0.2.19 B5：md 正文 IDB 后端的重连与异常收口。
 *
 * 三件事：
 *   ① `InvalidStateError`（iOS 挂起后 DB 句柄失效）→ 丢弃 dbPromise、重开、重试成功；
 *   ② `onversionchange`（另一个标签页升级版本）→ 关闭并重开；
 *   ③ 事务 `abort` → 拒绝而不是悬挂（补 onabort）。
 *
 * 通过伪造 `globalThis.indexedDB` 驱动，不依赖真实 IDB。
 */

import { afterEach, describe, expect, test } from "bun:test";

import { createIdbMdBackend, type MdContentRecord } from "../src/store/MdContentStore";

const RECORD: MdContentRecord = {
  path: "notes/a.md",
  bytes: new TextEncoder().encode("hello-md"),
  size: 9,
  mtime: 1,
  fid: "fa",
  savedAt: 0,
};

function makeRequest<T>(result: T): { result: T | undefined; onsuccess?: (ev: unknown) => void; onerror?: (ev: unknown) => void } {
  const request: { result: T | undefined; onsuccess?: (ev: unknown) => void; onerror?: (ev: unknown) => void } = {
    result: undefined,
  };
  setTimeout(() => {
    request.result = result;
    request.onsuccess?.({});
  }, 0);
  return request;
}

interface FakeIdbOptions {
  /** 前 N 次 `transaction()` 调用抛 InvalidStateError（模拟挂起后句柄失效）。 */
  failTransactions?: number;
  /** 第一次 `get` 触发事务 abort。 */
  abortFirstTransaction?: boolean;
}

interface FakeIdbHandle {
  readonly opens: number;
  readonly closes: number;
  /** 触发最后一次打开的 DB 的 `onversionchange`。 */
  versionChange(): void;
  restore(): void;
}

function installFakeIdb(options: FakeIdbOptions = {}): FakeIdbHandle {
  const globalScope = globalThis as unknown as { indexedDB?: unknown };
  const previous = globalScope.indexedDB;
  const databases: Array<{ onversionchange?: (() => void) | null }> = [];
  let opens = 0;
  let closes = 0;
  let aborted = false;

  const factory = {
    open: (_name: string, _version?: number) => {
      opens += 1;
      const attempt = opens;
      const database = {
        onversionchange: undefined as (() => void) | undefined,
        objectStoreNames: { contains: () => true },
        close: () => {
          closes += 1;
        },
        transaction: () => {
          if (attempt <= (options.failTransactions ?? 0)) {
            const error = new Error("database connection is closing");
            error.name = "InvalidStateError";
            throw error;
          }
          const transaction = {
            onabort: undefined as (() => void) | undefined,
            onerror: undefined as (() => void) | undefined,
            error: null as unknown,
            objectStore: () => ({
              get: () => {
                if (options.abortFirstTransaction && !aborted) {
                  aborted = true;
                  const request = { result: undefined as unknown, onsuccess: undefined as ((ev: unknown) => void) | undefined, onerror: undefined };
                  setTimeout(() => {
                    const error = new Error("transaction aborted");
                    error.name = "AbortError";
                    transaction.error = error;
                    transaction.onabort?.();
                  }, 0);
                  return request;
                }
                return makeRequest(RECORD);
              },
              put: (value: unknown) => makeRequest(value),
              delete: () => makeRequest(undefined),
              getAll: () => makeRequest([RECORD]),
              clear: () => makeRequest(undefined),
            }),
          };
          return transaction;
        },
      };
      databases.push(database);
      const request: {
        result?: unknown;
        onsuccess?: (ev: unknown) => void;
        onerror?: (ev: unknown) => void;
        onupgradeneeded?: (ev: unknown) => void;
      } = {};
      setTimeout(() => {
        request.result = database;
        request.onsuccess?.({});
      }, 0);
      return request;
    },
  };

  globalScope.indexedDB = factory;
  return {
    get opens() {
      return opens;
    },
    get closes() {
      return closes;
    },
    versionChange() {
      const database = databases[databases.length - 1];
      database.onversionchange?.();
    },
    restore() {
      if (previous === undefined) delete globalScope.indexedDB;
      else globalScope.indexedDB = previous;
    },
  };
}

let handle: FakeIdbHandle | null = null;

afterEach(() => {
  handle?.restore();
  handle = null;
});

describe("0.2.19 B5 md IDB 重连", () => {
  test("InvalidStateError → 丢弃 dbPromise、重开、读成功（opens=2）", async () => {
    handle = installFakeIdb({ failTransactions: 1 });
    const backend = createIdbMdBackend("md-reconnect-1", { reopenDelaysMs: [0] });

    const record = await backend.get("notes/a.md");

    expect(record?.path).toBe("notes/a.md");
    expect(handle.opens).toBe(2);
  });

  test("onversionchange → 关闭旧句柄，下一次操作自动重开", async () => {
    handle = installFakeIdb();
    const backend = createIdbMdBackend("md-reconnect-2", { reopenDelaysMs: [0] });
    await backend.get("notes/a.md");
    expect(handle.opens).toBe(1);

    handle.versionChange();
    await backend.get("notes/a.md");

    expect(handle.opens).toBe(2);
  });

  test("事务 abort → 拒绝而不是悬挂（补 onabort）", async () => {
    handle = installFakeIdb({ abortFirstTransaction: true });
    const backend = createIdbMdBackend("md-reconnect-3", { reopenDelaysMs: [0] });

    const outcome = await Promise.race([
      backend.get("notes/a.md").then(
        () => "resolved",
        (error) => `rejected:${error instanceof Error ? error.name : String(error)}`
      ),
      new Promise<string>((resolve) => setTimeout(() => resolve("watchdog"), 300)),
    ]);

    expect(outcome).not.toBe("watchdog");
    expect(outcome).not.toBe("resolved");
    expect(outcome).toContain("AbortError");
  });
});
