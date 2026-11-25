/**
 * MdContentStore —— md 正文磁盘缓存（0.2.13）。
 *
 * 只存**正文**（`.md/.markdown`），附件永不进 IDB：
 *   - 记录 `{ path, bytes, size, mtime, fid, savedAt }`（key = path）；
 *   - `validators` 逻辑：`fid/size/mtime` 任一变化即失效（索引刷新后比对）；
 *   - 容量上限默认 50MB，超限按 `savedAt` 最旧淘汰；
 *   - 后端可注入（单测用 `MemoryMdContentBackend`；运行期用 IndexedDB 后端）。
 *
 * 不 import `fs`/`node:`，不引 npm 依赖。
 */

export interface MdContentMeta {
  fid?: string;
  size?: number;
  mtime?: number;
}

export interface MdContentRecord {
  path: string;
  bytes: Uint8Array;
  size: number;
  mtime: number;
  fid: string;
  savedAt: number;
}

export interface MdStoreStats {
  count: number;
  bytes: number;
}

/** 后端最小接口（IDB / 内存实现结构上满足）。 */
export interface MdContentBackend {
  get(path: string): Promise<MdContentRecord | null>;
  put(record: MdContentRecord): Promise<void>;
  delete(path: string): Promise<void>;
  getAll(): Promise<MdContentRecord[]>;
  clear(): Promise<void>;
  close?(): Promise<void>;
}

/** 单测/无 IDB 环境用的内存后端。 */
export class MemoryMdContentBackend implements MdContentBackend {
  private readonly map = new Map<string, MdContentRecord>();

  async get(path: string): Promise<MdContentRecord | null> {
    return this.map.get(path) ?? null;
  }

  async put(record: MdContentRecord): Promise<void> {
    this.map.set(record.path, { ...record, bytes: record.bytes.slice() });
  }

  async delete(path: string): Promise<void> {
    this.map.delete(path);
  }

  async getAll(): Promise<MdContentRecord[]> {
    return Array.from(this.map.values()).map((record) => ({ ...record, bytes: record.bytes.slice() }));
  }

  async clear(): Promise<void> {
    this.map.clear();
  }
}

export interface MdContentStoreOptions {
  backend?: MdContentBackend;
  maxBytes?: number;
  now?: () => number;
  /** 诊断出口（stage=cache）。 */
  onLog?: (entry: { state: string; path?: string; bytes?: number; count?: number }) => void;
}

export const DEFAULT_MD_CACHE_MAX_BYTES = 50 * 1024 * 1024;

function toBytes(data: ArrayBuffer | Uint8Array | string): Uint8Array {
  if (typeof data === "string") return new TextEncoder().encode(data);
  if (data instanceof Uint8Array) return data;
  return new Uint8Array(data);
}

export class MdContentStore {
  private readonly backend: MdContentBackend;
  private readonly maxBytes: number;
  private readonly now: () => number;
  private readonly onLog?: MdContentStoreOptions["onLog"];
  private ready: Promise<void> | null = null;
  private cachedStats: MdStoreStats | null = null;

  constructor(options: MdContentStoreOptions = {}) {
    this.backend = options.backend ?? new MemoryMdContentBackend();
    this.maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MD_CACHE_MAX_BYTES);
    this.now = options.now ?? ((): number => Date.now());
    this.onLog = options.onLog;
  }

  private ensureReady(): Promise<void> {
    if (!this.ready) this.ready = Promise.resolve();
    return this.ready;
  }

  /** 写入/更新一条 md；先做容量淘汰。返回是否写入成功。 */
  async put(path: string, data: ArrayBuffer | Uint8Array | string, meta: MdContentMeta = {}): Promise<boolean> {
    const clean = String(path ?? "").trim();
    if (!clean) return false;
    await this.ensureReady();
    const bytes = toBytes(data);
    const record: MdContentRecord = {
      path: clean,
      bytes,
      size: typeof meta.size === "number" ? meta.size : bytes.byteLength,
      mtime: typeof meta.mtime === "number" ? meta.mtime : 0,
      fid: typeof meta.fid === "string" ? meta.fid : "",
      savedAt: this.now(),
    };
    await this.backend.put(record);
    this.cachedStats = null;
    await this.evictIfNeeded();
    this.onLog?.({ state: "write-md", path: clean, bytes: record.bytes.byteLength });
    return true;
  }

  /** 取一条（调用方负责用 validators 判断是否失效）。 */
  async get(path: string): Promise<MdContentRecord | null> {
    await this.ensureReady();
    return await this.backend.get(String(path ?? ""));
  }

  /** 该条是否与索引条目一致（fid/size/mtime 任一变化即失效）。 */
  static isValid(record: MdContentRecord | null, expected: MdContentMeta): boolean {
    if (!record) return false;
    if (typeof expected.fid === "string" && expected.fid && record.fid !== expected.fid) return false;
    if (typeof expected.size === "number" && expected.size >= 0 && record.size !== expected.size) return false;
    if (typeof expected.mtime === "number" && expected.mtime > 0 && record.mtime !== expected.mtime) return false;
    return true;
  }

  /**
   * 按索引刷新结果失效：validators 不一致的条目删除。
   * `entries` 为当前索引（path → {fid,size,mtime}）；不在本次索引里的也算失效。
   */
  async invalidate(entries: Array<{ path: string; fid: string; size: number; mtime: number }>): Promise<number> {
    await this.ensureReady();
    const expected = new Map(entries.map((entry) => [entry.path, entry]));
    const all = await this.backend.getAll();
    let removed = 0;
    for (const record of all) {
      const current = expected.get(record.path);
      if (MdContentStore.isValid(record, current ?? {})) continue;
      await this.backend.delete(record.path);
      removed += 1;
      this.onLog?.({ state: "invalidate", path: record.path });
    }
    if (removed > 0) this.cachedStats = null;
    return removed;
  }

  /** 删除一条。 */
  async delete(path: string): Promise<void> {
    await this.ensureReady();
    await this.backend.delete(String(path ?? ""));
    this.cachedStats = null;
  }

  /** 统计（缓存一次，put/delete/clear 后失效）。 */
  async stats(): Promise<MdStoreStats> {
    if (this.cachedStats) return { ...this.cachedStats };
    const all = await this.backend.getAll();
    const stats = {
      count: all.length,
      bytes: all.reduce((sum, record) => sum + (record.bytes?.byteLength ?? 0), 0),
    };
    this.cachedStats = stats;
    return { ...stats };
  }

  /** 清空整个 mdContent（切换库根用）。 */
  async clear(): Promise<void> {
    await this.ensureReady();
    await this.backend.clear();
    this.cachedStats = null;
    this.onLog?.({ state: "clear-md" });
  }

  /** 超限按 savedAt 最旧淘汰。 */
  private async evictIfNeeded(): Promise<void> {
    const all = await this.backend.getAll();
    let total = all.reduce((sum, record) => sum + (record.bytes?.byteLength ?? 0), 0);
    if (total <= this.maxBytes) return;
    all.sort((a, b) => a.savedAt - b.savedAt);
    let removed = 0;
    for (const record of all) {
      if (total <= this.maxBytes) break;
      await this.backend.delete(record.path);
      total -= record.bytes?.byteLength ?? 0;
      removed += 1;
    }
    if (removed > 0) {
      this.cachedStats = null;
      this.onLog?.({ state: "evict", count: removed });
    }
  }
}

/** 运行期 IndexedDB 后端（桌面/移动 WebView 通用）。 */
export interface IdbMdBackendOptions {
  /** 失效重连退避（毫秒），默认 `[300, 900, 2700]`（与 IndexStore 的口径一致）。 */
  reopenDelaysMs?: number[];
}

/** 默认重连退避。 */
export const MD_REOPEN_DELAYS_MS = [300, 900, 2700];

function errorName(error: unknown): string {
  if (error && typeof error === "object" && typeof (error as { name?: unknown }).name === "string") {
    return (error as { name: string }).name;
  }
  return "";
}

/** iOS 挂起 / 另一个标签页升级后，旧 IDB 句柄会抛这两个错误名（与 IndexStore 同口径）。 */
export function isMdInvalidStateError(error: unknown): boolean {
  const name = errorName(error);
  return name === "InvalidStateError" || name === "TransactionInactiveError";
}

function idbSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

export function createIdbMdBackend(dbName: string, options: IdbMdBackendOptions = {}): MdContentBackend {
  const idb = (globalThis as unknown as { indexedDB?: IDBFactory }).indexedDB;
  if (!idb) return new MemoryMdContentBackend();
  const reopenDelays = (options.reopenDelaysMs ?? MD_REOPEN_DELAYS_MS).map((ms) =>
    Number.isFinite(ms) ? Math.max(0, ms) : 0
  );
  const openDb = (): Promise<IDBDatabase> =>
    new Promise((resolve, reject) => {
      const request = idb.open(dbName, 1);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("mdContent")) db.createObjectStore("mdContent", { keyPath: "path" });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  let dbPromise: Promise<IDBDatabase> | null = null;

  /** 0.2.19 B5：丢弃失效句柄（关闭旧 DB），下一次操作重新 open。 */
  const resetDb = (): void => {
    const pending = dbPromise;
    dbPromise = null;
    if (!pending) return;
    void pending
      .then((database) => {
        try {
          database.close();
        } catch {
          /* 已关闭 */
        }
      })
      .catch(() => undefined);
  };

  const openOnce = (): Promise<IDBDatabase> =>
    openDb()
      .then((database) => {
        try {
          // 另一个标签页升级版本：关掉自己的句柄，让下次操作重开
          database.onversionchange = () => {
            try {
              database.close();
            } catch {
              /* 已关闭 */
            }
            resetDb();
          };
        } catch {
          /* 某些 WebView 的 db 对象是只读代理 */
        }
        return database;
      })
      .catch((error) => {
        dbPromise = null;
        throw error;
      });

  const db = (): Promise<IDBDatabase> => {
    if (!dbPromise) dbPromise = openOnce();
    return dbPromise;
  };

  const tx = async <T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= reopenDelays.length; attempt += 1) {
      const database = await db();
      try {
        return await new Promise<T>((resolve, reject) => {
          const transaction = database.transaction("mdContent", mode);
          // 0.2.19 B5：补 onabort/onerror，事务中断时拒绝而不是让 Promise 永远挂着
          transaction.onabort = () =>
            reject(transaction.error ?? new Error("IDB transaction aborted"));
          transaction.onerror = () =>
            reject(transaction.error ?? new Error("IDB transaction error"));
          const request = run(transaction.objectStore("mdContent"));
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      } catch (error) {
        lastError = error;
        if (!isMdInvalidStateError(error) || attempt >= reopenDelays.length) throw error;
        resetDb();
        const delay = reopenDelays[attempt];
        if (delay > 0) await idbSleep(delay);
      }
    }
    throw lastError ?? new Error("IDB transaction failed");
  };
  return {
    get: (path) => tx<MdContentRecord | null>("readonly", (store) => store.get(path) as IDBRequest<MdContentRecord | null>),
    put: async (record) => {
      await tx("readwrite", (store) => store.put(record));
    },
    delete: async (path) => {
      await tx("readwrite", (store) => store.delete(path));
    },
    getAll: () => tx<MdContentRecord[]>("readonly", (store) => store.getAll() as IDBRequest<MdContentRecord[]>),
    clear: async () => {
      await tx("readwrite", (store) => store.clear());
    },
  };
}