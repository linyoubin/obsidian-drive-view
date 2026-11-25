/**
 * IndexStore 单测：全部用假实现（假 IDB / 内存后端），不打真实 IDB、不发网络。
 *
 * 覆盖契约 T-07：A2（IDB 两个 store 与字段）、A3（diff 三种情况）、A4（断点续扫）、
 * A5（InvalidStateError 重连 300/900/2700、QuotaExceeded 清库重试、降级）。
 */

import { describe, expect, test } from "bun:test";

import {
  IDB_STORE_ENTRIES,
  IDB_STORE_META,
  IndexStore,
  MemoryIndexBackend,
  REOPEN_DELAYS_MS,
  createIdbBackend,
  diffEntries,
  indexDbNameForVault,
  normalizeQuarkMtime,
  type IdbFactoryLike,
  type IndexEntry,
  type ScanProgress,
} from "../src/store/IndexStore";

// ------------------------------------------------------------------ 工具

function entry(path: string, patch: Partial<IndexEntry> = {}): IndexEntry {
  return {
    path,
    type: patch.type ?? "file",
    fid: patch.fid ?? `fid-${path}`,
    parentFid: patch.parentFid ?? "",
    size: patch.size ?? 10,
    mtime: patch.mtime ?? 1000,
  };
}

function namedError(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

/** 可注错的假后端（继承内存后端，只在指定次数内抛指定错误）。 */
class FlakyBackend extends MemoryIndexBackend {
  invalidStateTimes = 0;
  quotaTimes = 0;
  clearCount = 0;
  closeCount = 0;
  entryReads = 0;

  async loadEntries(): Promise<IndexEntry[]> {
    this.entryReads += 1;
    if (this.invalidStateTimes > 0) {
      this.invalidStateTimes -= 1;
      throw namedError("InvalidStateError");
    }
    return await super.loadEntries();
  }

  async putEntries(entries: IndexEntry[]): Promise<void> {
    if (this.quotaTimes > 0) {
      this.quotaTimes -= 1;
      throw namedError("QuotaExceededError");
    }
    await super.putEntries(entries);
  }

  async clearEntries(): Promise<void> {
    this.clearCount += 1;
    await super.clearEntries();
  }

  async close(): Promise<void> {
    this.closeCount += 1;
    await super.close();
  }
}

// ------------------------------------------------------------------ 假 IDB（结构化最简实现）

interface FakeRequest {
  result: unknown;
  error: unknown;
  onsuccess: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onupgradeneeded?: ((event: unknown) => void) | null;
}

function makeRequest(run: () => unknown): FakeRequest {
  const request: FakeRequest = { result: undefined, error: null, onsuccess: null, onerror: null };
  queueMicrotask(() => {
    try {
      request.result = run();
      if (request.onsuccess) request.onsuccess({});
    } catch (error) {
      request.error = error;
      if (request.onerror) request.onerror({});
    }
  });
  return request;
}

class FakeObjectStore {
  readonly rows = new Map<unknown, unknown>();
  readonly indexes: string[] = [];

  constructor(readonly keyPath: string | null) {}

  private keyOf(value: unknown, explicit?: unknown): unknown {
    if (explicit !== undefined) return explicit;
    if (this.keyPath && value && typeof value === "object") {
      return (value as Record<string, unknown>)[this.keyPath];
    }
    return undefined;
  }

  private api(): Record<string, unknown> {
    return {
      createIndex: (name: string) => {
        this.indexes.push(name);
        return null;
      },
      put: (value: unknown, explicit?: unknown) =>
        makeRequest(() => {
          this.rows.set(this.keyOf(value, explicit), value);
          return this.keyOf(value, explicit);
        }),
      get: (key: unknown) => makeRequest(() => this.rows.get(key)),
      getAll: () => makeRequest(() => Array.from(this.rows.values())),
      delete: (key: unknown) =>
        makeRequest(() => {
          this.rows.delete(key);
          return undefined;
        }),
      clear: () =>
        makeRequest(() => {
          this.rows.clear();
          return undefined;
        }),
      count: () => makeRequest(() => this.rows.size),
    };
  }

  asApi(): Record<string, unknown> {
    return this.api();
  }
}

class FakeTransaction {
  oncomplete: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onabort: ((event: unknown) => void) | null = null;

  constructor(private readonly db: FakeDatabase, private readonly names: string[]) {
    // 简化：事务在下一个宏任务「提交」，此时不会有 pending 请求（后端是逐个 await 的）
    setTimeout(() => {
      if (this.oncomplete) this.oncomplete({});
    }, 0);
  }

  objectStore(name: string): Record<string, unknown> {
    const store = this.db.stores.get(name);
    if (!store) throw namedError("NotFoundError");
    return store.asApi();
  }

  get storeNames(): string[] {
    return this.names;
  }
}

class FakeDatabase {
  readonly stores = new Map<string, FakeObjectStore>();
  closed = false;
  readonly objectStoreNames = {
    contains: (name: string): boolean => this.stores.has(name),
  };

  constructor(readonly name: string) {}

  createObjectStore(name: string, options?: { keyPath?: string }): Record<string, unknown> {
    const store = new FakeObjectStore(options?.keyPath ?? null);
    this.stores.set(name, store);
    return store.asApi();
  }

  transaction(names: string[], _mode: string): FakeTransaction {
    return new FakeTransaction(this, names);
  }

  close(): void {
    this.closed = true;
  }
}

interface FakeIdb {
  factory: IdbFactoryLike;
  databases: Map<string, FakeDatabase>;
  opens: number;
}

function createFakeIdb(): FakeIdb {
  const databases = new Map<string, FakeDatabase>();
  const state: FakeIdb = {
    opens: 0,
    databases,
    factory: {
      open(name: string): FakeRequest {
        state.opens += 1;
        const request: FakeRequest = {
          result: undefined,
          error: null,
          onsuccess: null,
          onerror: null,
          onupgradeneeded: null,
        };
        queueMicrotask(() => {
          let db = databases.get(name);
          const created = !db;
          if (!db) {
            db = new FakeDatabase(name);
            databases.set(name, db);
          }
          request.result = db;
          if (created && request.onupgradeneeded) request.onupgradeneeded({});
          if (request.onsuccess) request.onsuccess({});
        });
        return request;
      },
    },
  };
  return state;
}

// ------------------------------------------------------------------ A2：IDB 结构

describe("IndexStore：IDB 结构（A2）", () => {
  test("首次 open 建出 entries/meta 两个 store，entries 主键 path、meta 主键 key", async () => {
    const fake = createFakeIdb();
    const store = new IndexStore({
      createBackend: createIdbBackend({ dbName: "idx-test", factory: fake.factory }),
      now: () => 5000,
    });
    await store.load();
    await store.writeSnapshot([entry("a.md"), entry("dir", { type: "folder", size: 0 })], { rootFid: "0" });

    const db = fake.databases.get("idx-test");
    expect(db).toBeDefined();
    expect(Array.from(db!.stores.keys()).sort()).toEqual([IDB_STORE_ENTRIES, IDB_STORE_META]);
    expect(db!.stores.get(IDB_STORE_ENTRIES)!.keyPath).toBe("path");
    expect(db!.stores.get(IDB_STORE_META)!.keyPath).toBe("key");
    // entries 上有 parentFid 索引（BFS/局部刷新预留）
    expect(db!.stores.get(IDB_STORE_ENTRIES)!.indexes).toContain("by_parent");
    // meta 三条记录：version / builtAt / rootFid
    const metaKeys = Array.from(db!.stores.get(IDB_STORE_META)!.rows.keys()).map(String).sort();
    expect(metaKeys).toEqual(["builtAt", "rootFid", "version"]);
    expect((db!.stores.get(IDB_STORE_META)!.rows.get("rootFid") as { value: string }).value).toBe("0");
  });

  test("快照经真实 IDB 后端往返：重新打开后 0 请求读出同样条目与版本", async () => {
    const fake = createFakeIdb();
    const first = new IndexStore({
      createBackend: createIdbBackend({ dbName: "idx-roundtrip", factory: fake.factory }),
      now: () => 7000,
    });
    await first.load();
    const meta = await first.writeSnapshot([entry("a.md"), entry("b/b.md", { size: 42 })], { rootFid: "root" });
    expect(meta.version).toBe(1);
    expect(meta.rootFid).toBe("root");

    const second = new IndexStore({
      createBackend: createIdbBackend({ dbName: "idx-roundtrip", factory: fake.factory }),
    });
    const loaded = await second.load();
    expect(loaded).toBe(true);
    expect(second.entryCount).toBe(2);
    expect(second.entries.map((item) => item.path).sort()).toEqual(["a.md", "b/b.md"]);
    expect(second.metaInfo.version).toBe(1);
    expect(second.metaInfo.rootFid).toBe("root");
    expect(second.status.degraded).toBe(false);
    expect(second.status.backend).toBe("idb");
  });

  test("库名按 vault 名归一（防注入字符）", () => {
    expect(indexDbNameForVault("My Vault/1")).toBe("obsidian-quark-index-My_Vault_1");
    expect(indexDbNameForVault("")).toBe("obsidian-quark-index-default");
  });
});

// ------------------------------------------------------------------ A3：diff

describe("IndexStore：diff（A3）", () => {
  test("added / removed / changed / unchanged 四种情况分别命中", () => {
    const diff = diffEntries(
      [entry("same.md"), entry("size.md", { size: 1 }), entry("gone.md")],
      [entry("same.md"), entry("size.md", { size: 2 }), entry("new.md")]
    );
    expect(diff.unchanged).toBe(1);
    expect(diff.added.map((item) => item.path)).toEqual(["new.md"]);
    expect(diff.removed.map((item) => item.path)).toEqual(["gone.md"]);
    expect(diff.changed.length).toBe(1);
    expect(diff.changed[0].previous.size).toBe(1);
    expect(diff.changed[0].next.size).toBe(2);
  });

  test("fid 变化与 mtime 变化都算 changed（判据是任一字段变化）", () => {
    const byFid = diffEntries([entry("a.md", { fid: "1" })], [entry("a.md", { fid: "2" })]);
    expect(byFid.changed.length).toBe(1);
    const byMtime = diffEntries([entry("a.md", { mtime: 1 })], [entry("a.md", { mtime: 2 })]);
    expect(byMtime.changed.length).toBe(1);
    const bySize = diffEntries([entry("a.md", { size: 1 })], [entry("a.md", { size: 9 })]);
    expect(bySize.changed.length).toBe(1);
  });

  test("实例方法与静态方法一致；writeSnapshot 会记下最近一次 diff", async () => {
    const backend = new MemoryIndexBackend({ entries: [entry("a.md")] });
    const store = new IndexStore({ createBackend: async () => backend });
    await store.load();
    expect(store.diff([entry("a.md")], [entry("a.md"), entry("b.md")]).added.length).toBe(1);
    await store.writeSnapshot([entry("a.md"), entry("b.md")]);
    expect(store.lastDiffResult.added.map((item) => item.path)).toEqual(["b.md"]);
  });
});

// ------------------------------------------------------------------ 全量扫描 + A4 断点续扫

interface ScanTree {
  [folderPath: string]: IndexEntry[];
}

/** 目录树：根下 a/ b/ 两个目录 + root.md，a/ 下 a.md，b/ 下 b.md。 */
function scanTree(): ScanTree {
  return {
    "": [entry("a", { type: "folder", fid: "fa", size: 0 }), entry("b", { type: "folder", fid: "fb", size: 0 }), entry("root.md")],
    a: [entry("a/a.md")],
    b: [entry("b/b.md")],
  };
}

describe("IndexStore：扫描与断点续扫（A4）", () => {
  test("全量扫描：每目录一次 list，完成后写 meta 与 done 进度", async () => {
    const backend = new FlakyBackend();
    const tree = scanTree();
    const calls: string[] = [];
    const store = new IndexStore({ createBackend: async () => backend, now: () => 1000 });
    await store.load();

    const result = await store.scan({
      rootFid: "root",
      list: async (folder) => {
        calls.push(folder.path);
        return tree[folder.path] ?? [];
      },
    });

    expect(result.completed).toBe(true);
    expect(result.aborted).toBe(false);
    expect(calls).toEqual(["", "a", "b"]);
    expect(result.requests).toBe(3);
    expect(store.entryCount).toBe(5);
    expect(store.metaInfo.version).toBe(1);
    expect(store.metaInfo.rootFid).toBe("root");
    expect((await store.getProgress())!.done).toBe(true);
    expect(result.diff.added.length).toBe(5);
  });

  test("断点续扫：扫到一半中断 → 进度落盘 → 重入只扫剩余目录", async () => {
    const backend = new FlakyBackend();
    const tree = scanTree();
    const store = new IndexStore({ createBackend: async () => backend, now: () => 2000 });
    await store.load();

    await expect(
      store.scan({
        rootFid: "root",
        list: async (folder) => {
          if (folder.path === "b") throw new Error("network down");
          return tree[folder.path] ?? [];
        },
      })
    ).rejects.toThrow("network down");

    const progress = (await store.getProgress()) as ScanProgress;
    expect(progress.done).toBe(false);
    expect(progress.scannedFolders).toEqual(["", "a"]);
    expect(progress.pendingFolders.map((folder) => folder.path)).toEqual(["b"]);
    // 根目录 3 条（a/、b/、root.md）+ a/ 下 1 条 = 4
    expect(progress.entryCount).toBe(4);

    // 重入：同一后端、同一 rootFid，只应扫 "b"
    const secondCalls: string[] = [];
    const reopened = new IndexStore({ createBackend: async () => backend, now: () => 3000 });
    await reopened.load();
    const resumed = await reopened.scan({
      rootFid: "root",
      list: async (folder) => {
        secondCalls.push(folder.path);
        return tree[folder.path] ?? [];
      },
    });

    expect(secondCalls).toEqual(["b"]);
    expect(resumed.completed).toBe(true);
    expect(resumed.progress.done).toBe(true);
    // 上一轮 4 条 + b/b.md = 5
    expect(reopened.entryCount).toBe(5);
    expect(resumed.progress.scannedFolders).toEqual(["", "a", "b"]);
  });

  test("signal 中断：保存进度并返回 aborted，不抛错", async () => {
    const backend = new FlakyBackend();
    const tree = scanTree();
    const store = new IndexStore({ createBackend: async () => backend });
    await store.load();
    const signal = { aborted: false };

    const result = await store.scan({
      rootFid: "root",
      signal,
      list: async (folder) => {
        if (folder.path === "a") signal.aborted = true;
        return tree[folder.path] ?? [];
      },
    });

    expect(result.completed).toBe(false);
    expect(result.aborted).toBe(true);
    const progress = (await store.getProgress()) as ScanProgress;
    expect(progress.done).toBe(false);
    expect(progress.pendingFolders.length).toBeGreaterThan(0);
    // 原子替换语义：已扫条目在临时 Map/进度里，但内存索引没换（旧索引原样保留）
    expect(progress.entryCount).toBeGreaterThan(0);
    expect(store.entryCount).toBe(0);
  });
});

// ------------------------------------------------------------------ A5：异常恢复

describe("IndexStore：IDB 异常恢复（A5）", () => {
  test("InvalidStateError → 退避 300ms 重开一次成功，不降级", async () => {
    const sleeps: number[] = [];
    const flaky = new FlakyBackend();
    flaky.invalidStateTimes = 1;
    let factoryCalls = 0;
    const store = new IndexStore({
      createBackend: async () => {
        factoryCalls += 1;
        return flaky;
      },
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });

    const loaded = await store.load();
    expect(loaded).toBe(false);
    expect(sleeps).toEqual([300]);
    expect(factoryCalls).toBe(2);
    expect(store.status.degraded).toBe(false);
    expect(flaky.closeCount).toBe(1);
  });

  test("重开始终失败 → 300/900/2700 三次后降级为内存，操作仍在内存后端完成", async () => {
    const sleeps: number[] = [];
    const flaky = new FlakyBackend();
    flaky.invalidStateTimes = 1;
    let factoryCalls = 0;
    const store = new IndexStore({
      createBackend: async () => {
        factoryCalls += 1;
        if (factoryCalls === 1) return flaky;
        throw new Error("reopen failed");
      },
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });

    const loaded = await store.load();
    expect(loaded).toBe(false);
    expect(sleeps).toEqual(REOPEN_DELAYS_MS);
    expect(factoryCalls).toBe(4); // 首次 + 3 次重开
    expect(store.status.degraded).toBe(true);
    expect(store.status.backend).toBe("memory");
    expect(store.status.reason).toContain("重开索引库失败");

    // 降级后仍能写快照（只是不持久化）
    await store.writeSnapshot([entry("a.md")]);
    expect(store.entryCount).toBe(1);
  });

  test("QuotaExceededError → 清旧快照后重试成功，不降级", async () => {
    const flaky = new FlakyBackend();
    flaky.quotaTimes = 1;
    const store = new IndexStore({ createBackend: async () => flaky, sleep: async () => undefined });
    await store.load();

    await store.writeSnapshot([entry("a.md")]);
    expect(flaky.clearCount).toBeGreaterThanOrEqual(1);
    expect(store.status.degraded).toBe(false);
    expect(store.entryCount).toBe(1);
  });

  test("配额持续不足 → 清一次仍失败则降级为内存", async () => {
    const flaky = new FlakyBackend();
    flaky.quotaTimes = 99;
    const store = new IndexStore({ createBackend: async () => flaky, sleep: async () => undefined });
    await store.load();

    await store.writeSnapshot([entry("a.md")]);
    expect(store.status.degraded).toBe(true);
    expect(store.status.reason).toContain("配额");
    expect(store.entryCount).toBe(1);
  });

  test("后端不可用（没有 IDB 的环境）→ 直接降级且 status 可读", async () => {
    const store = new IndexStore({
      createBackend: async () => {
        throw new Error("当前环境没有 IndexedDB");
      },
      sleep: async () => undefined,
    });
    const status = await store.open();
    expect(status.degraded).toBe(true);
    expect(status.backend).toBe("memory");
    expect(status.entryCount).toBe(0);
    await store.writeSnapshot([entry("a.md")], { rootFid: "0" });
    expect(store.entryCount).toBe(1);
    expect(store.metaInfo.rootFid).toBe("0");
  });
});

// ------------------------------------------------------------------ 原子替换（T-10 A9）

describe("IndexStore：扫描的原子替换（T-10 A9）", () => {
  const oldEntries = [entry("old.md", { fid: "fid-old" })];

  test("扫描失败时内存索引原样保留（同步期间树不会变空）", async () => {
    const backend = new MemoryIndexBackend({ entries: oldEntries });
    const store = new IndexStore({ createBackend: async () => backend, now: () => 9000 });
    await store.load();
    expect(store.entryCount).toBe(1);

    await expect(
      store.scan({
        rootFid: "root",
        list: async () => {
          throw new Error("network down");
        },
      })
    ).rejects.toThrow("network down");
    // 旧索引没被清空
    expect(store.entryCount).toBe(1);
    expect(store.entries[0].path).toBe("old.md");
  });

  test("扫描成功后一次性换成新索引（旧条目整体消失，不混用）", async () => {
    const backend = new MemoryIndexBackend({ entries: oldEntries });
    const store = new IndexStore({ createBackend: async () => backend, now: () => 9100 });
    await store.load();

    const result = await store.scan({
      rootFid: "root",
      list: async (folder) => (folder.path === "" ? [entry("new.md")] : []),
    });

    expect(result.completed).toBe(true);
    expect(store.entryCount).toBe(1);
    expect(store.entries[0].path).toBe("new.md");
    expect(store.entries.some((item) => item.path === "old.md")).toBe(false);
  });
});
// ------------------------------------------------------------------ mtime 单位归一（0.2.9）

describe("IndexStore：mtime 单位归一（0.2.9）", () => {
  test("秒级 updated_at 归一为毫秒；毫秒级原样；0/非法值 → 0", () => {
    expect(normalizeQuarkMtime(1_700_000_000)).toBe(1_700_000_000_000); // 10 位秒
    expect(normalizeQuarkMtime(1_700_000_000_123)).toBe(1_700_000_000_123); // 13 位毫秒
    expect(normalizeQuarkMtime(0)).toBe(0);
    expect(normalizeQuarkMtime(-1)).toBe(0);
    expect(normalizeQuarkMtime("1700000000")).toBe(1_700_000_000_000);
    expect(normalizeQuarkMtime(Number.NaN)).toBe(0);
  });
});
