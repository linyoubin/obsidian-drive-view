/**
 * IndexStore —— 目录树索引的持久化与增量维护（纯逻辑，不接线 UI/adapter）。
 *
 * 依据 v3 §4（索引与刷新）与 §4.4（IDB 快照与挂起恢复）：
 *   - 两个 object store：`entries`（主键 `path`，字段 `type/fid/parentFid/size/mtime`）、
 *     `meta`（主键 `key`，存 `version` / `builtAt` / `rootFid` / `progress`）；
 *   - 快照：全量 BFS 的产物整体覆盖写，`version` 每次 +1，`builtAt` 为写入时刻；
 *   - diff：按 `path` 比对新旧快照，`changed` 判据是 `fid/size/mtime` 任一变化；
 *   - 断点续扫：以**目录**为单位持久化进度，重入时只扫剩余目录；
 *   - `InvalidStateError`（iOS 挂起会让事务失效）→ close → 300/900/2700 ms 重开（最多 3 次）→
 *     仍失败则降级为纯内存，并在 `status.degraded` 暴露；
 *   - `QuotaExceededError` → 清旧快照后重试一次，仍失败降级。
 *
 * IDB 是可注入的：模块顶层**不引用** `indexedDB`，真实后端在 `createIdbBackend()` 内部才取
 * `globalThis.indexedDB`，因此单测可以喂假实现（`MemoryIndexBackend` 或测试里的假 IDB）。
 *
 * 不 import `fs`/`path`/`child_process`/`electron`/`node:`，不引 npm 依赖。
 */

/** 索引条目：与 v3 §4.4 的 `entries` store 字段一致。 */
export interface IndexEntry {
  /** 库内相对路径（`""` 为根，子项用 `/` 连接）。 */
  path: string;
  type: "file" | "folder";
  fid: string;
  parentFid: string;
  /** 文件字节数；目录为 0。 */
  size: number;
  /** 毫秒时间戳，来自夸克 `updated_at`。 */
  mtime: number;
}

/** 元信息：`meta` store 里的三条记录。 */
export interface IndexMeta {
  version: number;
  builtAt: number;
  rootFid: string;
}

/** 一个待扫目录。 */
export interface ScanFolder {
  path: string;
  fid: string;
}

/** 断点续扫进度（`meta` store 的 `progress` 键）。 */
export interface ScanProgress {
  rootFid: string;
  /** 尚待扫描的目录队列（按顺序消费）。 */
  pendingFolders: ScanFolder[];
  /** 已完成的目录 path。 */
  scannedFolders: string[];
  entryCount: number;
  requests: number;
  updatedAt: number;
  done: boolean;
}

/** 新旧快照的差异。 */
export interface IndexChange {
  previous: IndexEntry;
  next: IndexEntry;
}

export interface IndexDiff {
  added: IndexEntry[];
  removed: IndexEntry[];
  changed: IndexChange[];
  unchanged: number;
}

/** 索引状态（UI 状态栏用；`degraded` 为 true 时表示索引不持久化）。 */
export interface IndexStoreStatus {
  degraded: boolean;
  backend: "idb" | "memory";
  reason: string;
  entryCount: number;
  version: number;
  builtAt: number;
  rootFid: string;
  reopenAttempts: number;
}

/**
 * 存储后端：IndexStore 只依赖这 10 个方法。
 *
 * 真实实现是 IDB（`createIdbBackend`），单测用 `MemoryIndexBackend` 或假 IDB。
 * 后端方法抛出的错误名（`InvalidStateError` / `QuotaExceededError`）决定 IndexStore 的恢复路径。
 */
export interface IndexStoreBackend {
  readonly kind: "idb" | "memory";
  loadEntries(): Promise<IndexEntry[]>;
  putEntries(entries: IndexEntry[]): Promise<void>;
  removeEntries(paths: string[]): Promise<void>;
  clearEntries(): Promise<void>;
  countEntries(): Promise<number>;
  loadMeta(): Promise<IndexMeta | null>;
  saveMeta(meta: IndexMeta | null): Promise<void>;
  loadProgress(): Promise<ScanProgress | null>;
  saveProgress(progress: ScanProgress | null): Promise<void>;
  close(): Promise<void>;
}

/** 后端工厂：`InvalidStateError` 恢复时会重新调用它（等价于「重开数据库」）。 */
export type IndexBackendFactory = () => Promise<IndexStoreBackend>;

/** IDB store 名与库版本（v3 §4.4）。 */
export const IDB_STORE_ENTRIES = "entries";
export const IDB_STORE_META = "meta";
export const IDB_SCHEMA_VERSION = 1;
/** 重连退避（毫秒）：300 / 900 / 2700，最多 3 次。 */
export const REOPEN_DELAYS_MS = [300, 900, 2700];

/** 索引库名（v3 §4.4：`obsidian-quark-index-<vaultName>`）。 */
export function indexDbNameForVault(vaultName: string): string {
  const safe = String(vaultName || "default").replace(/[^a-zA-Z0-9_-]/g, "_");
  return `obsidian-quark-index-${safe}`;
}

/** 小于该阈值的时间戳视为「秒」，归一化时 ×1000（0.2.9）。 */
export const QUARK_SECONDS_MTIME_MAX = 1e12;

/**
 * 夸克 `updated_at` 单位归一（0.2.9）：`< 1e12` 视为秒 → ×1000，其余原样。
 * 返回毫秒时间戳（Obsidian `Stat.mtime` 的口径）。
 */
export function normalizeQuarkMtime(value: unknown): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return numeric < QUARK_SECONDS_MTIME_MAX ? Math.round(numeric * 1000) : Math.round(numeric);
}

function cloneEntry(entry: IndexEntry): IndexEntry {
  return {
    path: entry.path,
    type: entry.type === "folder" ? "folder" : "file",
    fid: String(entry.fid ?? ""),
    parentFid: String(entry.parentFid ?? ""),
    size: Number.isFinite(entry.size) ? Number(entry.size) : 0,
    mtime: normalizeQuarkMtime(entry.mtime),
  };
}

function cloneProgress(progress: ScanProgress): ScanProgress {
  return {
    rootFid: progress.rootFid,
    pendingFolders: progress.pendingFolders.map((folder) => ({ path: folder.path, fid: folder.fid })),
    scannedFolders: progress.scannedFolders.slice(),
    entryCount: progress.entryCount,
    requests: progress.requests,
    updatedAt: progress.updatedAt,
    done: progress.done,
  };
}

function errorName(error: unknown): string {
  if (error && typeof error === "object" && typeof (error as { name?: unknown }).name === "string") {
    return (error as { name: string }).name;
  }
  return "";
}

/** iOS 挂起后事务失效的两类错误名，按同一路径恢复。 */
export function isInvalidStateError(error: unknown): boolean {
  const name = errorName(error);
  return name === "InvalidStateError" || name === "TransactionInactiveError";
}

export function isQuotaExceededError(error: unknown): boolean {
  return errorName(error) === "QuotaExceededError";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

/**
 * 纯内存后端：单测、以及 IDB 不可用 / 重连失败后的降级目标。
 */
export class MemoryIndexBackend implements IndexStoreBackend {
  readonly kind = "memory" as const;
  private entries = new Map<string, IndexEntry>();
  private meta: IndexMeta | null = null;
  private progress: ScanProgress | null = null;

  constructor(seed: { entries?: IndexEntry[]; meta?: IndexMeta | null; progress?: ScanProgress | null } = {}) {
    if (seed.entries) for (const entry of seed.entries) this.entries.set(entry.path, cloneEntry(entry));
    this.meta = seed.meta ? { ...seed.meta } : null;
    this.progress = seed.progress ? cloneProgress(seed.progress) : null;
  }

  async loadEntries(): Promise<IndexEntry[]> {
    return Array.from(this.entries.values()).map(cloneEntry);
  }

  async putEntries(entries: IndexEntry[]): Promise<void> {
    for (const entry of entries) this.entries.set(entry.path, cloneEntry(entry));
  }

  async removeEntries(paths: string[]): Promise<void> {
    for (const path of paths) this.entries.delete(path);
  }

  async clearEntries(): Promise<void> {
    this.entries.clear();
  }

  async countEntries(): Promise<number> {
    return this.entries.size;
  }

  async loadMeta(): Promise<IndexMeta | null> {
    return this.meta ? { ...this.meta } : null;
  }

  async saveMeta(meta: IndexMeta | null): Promise<void> {
    this.meta = meta ? { ...meta } : null;
  }

  async loadProgress(): Promise<ScanProgress | null> {
    return this.progress ? cloneProgress(this.progress) : null;
  }

  async saveProgress(progress: ScanProgress | null): Promise<void> {
    this.progress = progress ? cloneProgress(progress) : null;
  }

  async close(): Promise<void> {
    /* 无资源可释放 */
  }
}

// ---------------------------------------------------------------- IDB（结构化最小接口）

interface IdbRequestLike {
  result: unknown;
  error: unknown;
  onsuccess: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}

interface IdbObjectStoreLike {
  put(value: unknown, key?: unknown): IdbRequestLike;
  get(key: unknown): IdbRequestLike;
  getAll(): IdbRequestLike;
  delete(key: unknown): IdbRequestLike;
  clear(): IdbRequestLike;
  count(): IdbRequestLike;
  createIndex(name: string, keyPath: string): unknown;
}

interface IdbTransactionLike {
  oncomplete: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onabort: ((event: unknown) => void) | null;
  error?: unknown;
  objectStore(name: string): IdbObjectStoreLike;
}

interface IdbDatabaseLike {
  objectStoreNames: { contains(name: string): boolean };
  createObjectStore(name: string, options?: { keyPath?: string }): IdbObjectStoreLike;
  transaction(names: string[], mode: string): IdbTransactionLike;
  close(): void;
}

interface IdbOpenRequestLike extends IdbRequestLike {
  result: IdbDatabaseLike;
  onupgradeneeded: ((event: unknown) => void) | null;
}

export interface IdbFactoryLike {
  open(name: string, version?: number): IdbOpenRequestLike;
}

/**
 * 取运行期的 IDBFactory；不可用返回 null。
 * 只在调用时访问 `globalThis`，模块顶层不引用 `indexedDB`（契约硬要求）。
 */
export function resolveIndexedDbFactory(): IdbFactoryLike | null {
  const candidate = (globalThis as unknown as { indexedDB?: unknown }).indexedDB;
  if (!candidate || typeof candidate !== "object") return null;
  if (typeof (candidate as { open?: unknown }).open !== "function") return null;
  return candidate as IdbFactoryLike;
}

function requestDone<T>(request: IdbRequestLike): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    request.onsuccess = () => {
      if (settled) return;
      settled = true;
      resolve(request.result as T);
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(request.error ?? new Error("IDB 请求失败"));
    };
  });
}

function transactionDone(transaction: IdbTransactionLike): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    transaction.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    transaction.onerror = () => {
      if (settled) return;
      settled = true;
      reject(transaction.error ?? new Error("IDB 事务失败"));
    };
    transaction.onabort = () => {
      if (settled) return;
      settled = true;
      reject(transaction.error ?? new Error("IDB 事务被中止"));
    };
  });
}

async function withTransaction<T>(
  db: IdbDatabaseLike,
  storeNames: string[],
  mode: "readonly" | "readwrite",
  run: (transaction: IdbTransactionLike) => Promise<T>
): Promise<T> {
  const transaction = db.transaction(storeNames, mode);
  // 先挂完成回调再发请求，避免事务已提交后才挂上导致永远不 resolve
  const done = transactionDone(transaction);
  const result = await run(transaction);
  await done;
  return result;
}

/** 打开（必要时建库建 store）索引库。 */
export function openIndexDatabase(factory: IdbFactoryLike, dbName: string): Promise<IdbDatabaseLike> {
  return new Promise<IdbDatabaseLike>((resolve, reject) => {
    let request: IdbOpenRequestLike;
    try {
      request = factory.open(dbName, IDB_SCHEMA_VERSION);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(IDB_STORE_ENTRIES)) {
        const store = db.createObjectStore(IDB_STORE_ENTRIES, { keyPath: "path" });
        try {
          // 供按父目录取子项（BFS/局部刷新）用；一期不必依赖
          store.createIndex("by_parent", "parentFid");
        } catch {
          /* 有的实现不允许重复建索引，忽略 */
        }
      }
      if (!db.objectStoreNames.contains(IDB_STORE_META)) {
        db.createObjectStore(IDB_STORE_META, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("索引库打开失败"));
  });
}

/** 真实 IDB 后端。 */
class IdbIndexBackend implements IndexStoreBackend {
  readonly kind = "idb" as const;

  constructor(private readonly db: IdbDatabaseLike) {}

  async loadEntries(): Promise<IndexEntry[]> {
    const rows = await withTransaction(this.db, [IDB_STORE_ENTRIES], "readonly", async (transaction) => {
      return await requestDone<IndexEntry[]>(transaction.objectStore(IDB_STORE_ENTRIES).getAll());
    });
    return (rows || []).map(cloneEntry);
  }

  async putEntries(entries: IndexEntry[]): Promise<void> {
    if (entries.length === 0) return;
    await withTransaction(this.db, [IDB_STORE_ENTRIES], "readwrite", async (transaction) => {
      const store = transaction.objectStore(IDB_STORE_ENTRIES);
      for (const entry of entries) await requestDone(store.put(cloneEntry(entry)));
    });
  }

  async removeEntries(paths: string[]): Promise<void> {
    if (paths.length === 0) return;
    await withTransaction(this.db, [IDB_STORE_ENTRIES], "readwrite", async (transaction) => {
      const store = transaction.objectStore(IDB_STORE_ENTRIES);
      for (const path of paths) await requestDone(store.delete(path));
    });
  }

  async clearEntries(): Promise<void> {
    await withTransaction(this.db, [IDB_STORE_ENTRIES], "readwrite", async (transaction) => {
      await requestDone(transaction.objectStore(IDB_STORE_ENTRIES).clear());
    });
  }

  async countEntries(): Promise<number> {
    return await withTransaction(this.db, [IDB_STORE_ENTRIES], "readonly", async (transaction) => {
      return await requestDone<number>(transaction.objectStore(IDB_STORE_ENTRIES).count());
    });
  }

  async loadMeta(): Promise<IndexMeta | null> {
    const records = await withTransaction(this.db, [IDB_STORE_META], "readonly", async (transaction) => {
      const store = transaction.objectStore(IDB_STORE_META);
      const keys = ["version", "builtAt", "rootFid"];
      const values: unknown[] = [];
      for (const key of keys) {
        const row = await requestDone<{ key: string; value: unknown } | undefined>(store.get(key));
        values.push(row && typeof row === "object" ? row.value : undefined);
      }
      return values;
    });
    const version = typeof records[0] === "number" ? records[0] : 0;
    const builtAt = typeof records[1] === "number" ? records[1] : 0;
    const rootFid = typeof records[2] === "string" ? records[2] : "";
    if (version === 0 && builtAt === 0 && !rootFid) return null;
    return { version, builtAt, rootFid };
  }

  async saveMeta(meta: IndexMeta | null): Promise<void> {
    await withTransaction(this.db, [IDB_STORE_META], "readwrite", async (transaction) => {
      const store = transaction.objectStore(IDB_STORE_META);
      if (!meta) {
        for (const key of ["version", "builtAt", "rootFid"]) await requestDone(store.delete(key));
        return;
      }
      await requestDone(store.put({ key: "version", value: meta.version }));
      await requestDone(store.put({ key: "builtAt", value: meta.builtAt }));
      await requestDone(store.put({ key: "rootFid", value: meta.rootFid }));
    });
  }

  async loadProgress(): Promise<ScanProgress | null> {
    const row = await withTransaction(this.db, [IDB_STORE_META], "readonly", async (transaction) => {
      return await requestDone<{ key: string; value: unknown } | undefined>(
        transaction.objectStore(IDB_STORE_META).get("progress")
      );
    });
    if (!row || typeof row !== "object") return null;
    const value = (row as { value?: unknown }).value;
    if (!value || typeof value !== "object") return null;
    const progress = value as Partial<ScanProgress>;
    return {
      rootFid: typeof progress.rootFid === "string" ? progress.rootFid : "",
      pendingFolders: Array.isArray(progress.pendingFolders)
        ? progress.pendingFolders.map((folder) => ({
            path: String((folder as ScanFolder)?.path ?? ""),
            fid: String((folder as ScanFolder)?.fid ?? ""),
          }))
        : [],
      scannedFolders: Array.isArray(progress.scannedFolders) ? progress.scannedFolders.map(String) : [],
      entryCount: typeof progress.entryCount === "number" ? progress.entryCount : 0,
      requests: typeof progress.requests === "number" ? progress.requests : 0,
      updatedAt: typeof progress.updatedAt === "number" ? progress.updatedAt : 0,
      done: progress.done === true,
    };
  }

  async saveProgress(progress: ScanProgress | null): Promise<void> {
    await withTransaction(this.db, [IDB_STORE_META], "readwrite", async (transaction) => {
      const store = transaction.objectStore(IDB_STORE_META);
      if (!progress) {
        await requestDone(store.delete("progress"));
        return;
      }
      await requestDone(store.put({ key: "progress", value: cloneProgress(progress) }));
    });
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

export interface IdbBackendOptions {
  dbName: string;
  /** 测试可注入假 IDB；缺省时在工厂调用时才取 `globalThis.indexedDB`。 */
  factory?: IdbFactoryLike;
}

/** 生产用后端工厂：每次调用都重新 open（`InvalidStateError` 恢复就靠它「重开」）。 */
export function createIdbBackend(options: IdbBackendOptions): IndexBackendFactory {
  return async (): Promise<IndexStoreBackend> => {
    const factory = options.factory ?? resolveIndexedDbFactory();
    if (!factory) throw new Error("当前环境没有 IndexedDB，索引将无法持久化");
    const db = await openIndexDatabase(factory, options.dbName);
    return new IdbIndexBackend(db);
  };
}

// ---------------------------------------------------------------- IndexStore

export interface IndexStoreOptions {
  createBackend: IndexBackendFactory;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 重开尝试次数，默认 3（对应 300/900/2700）。 */
  maxReopen?: number;
  onStatusChange?: (status: IndexStoreStatus) => void;
}

export interface ScanOptions {
  rootFid: string;
  /** 列一个目录：由 adapter 层用 QuarkClient.listDir 实现。 */
  list: (folder: ScanFolder) => Promise<IndexEntry[]>;
  /** 中断信号（切后台/用户取消）。 */
  signal?: { aborted: boolean };
  onProgress?: (progress: ScanProgress) => void;
}

export interface ScanResult {
  completed: boolean;
  aborted: boolean;
  progress: ScanProgress;
  diff: IndexDiff;
  requests: number;
  /** 降级/中断的人类可读说明（可选）。 */
  note?: string;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    const maybeUnref = timer as unknown as { unref?: () => void };
    if (typeof maybeUnref.unref === "function") maybeUnref.unref();
  });
}

function freshProgress(rootFid: string, now: number): ScanProgress {
  return {
    rootFid,
    pendingFolders: [{ path: "", fid: rootFid }],
    scannedFolders: [],
    entryCount: 0,
    requests: 0,
    updatedAt: now,
    done: false,
  };
}

/** 快照 diff：按 `path` 比对，`fid/size/mtime` 任一变化即为 `changed`。 */
export function diffEntries(oldEntries: IndexEntry[], newEntries: IndexEntry[]): IndexDiff {
  const previousByPath = new Map<string, IndexEntry>();
  for (const entry of oldEntries) previousByPath.set(entry.path, entry);
  const nextByPath = new Map<string, IndexEntry>();
  for (const entry of newEntries) nextByPath.set(entry.path, entry);

  const added: IndexEntry[] = [];
  const removed: IndexEntry[] = [];
  const changed: IndexChange[] = [];
  let unchanged = 0;

  for (const [path, next] of nextByPath) {
    const previous = previousByPath.get(path);
    if (!previous) {
      added.push(next);
      continue;
    }
    if (previous.fid !== next.fid || previous.size !== next.size || previous.mtime !== next.mtime || previous.type !== next.type) {
      changed.push({ previous, next });
      continue;
    }
    unchanged += 1;
  }
  for (const [path, previous] of previousByPath) {
    if (!nextByPath.has(path)) removed.push(previous);
  }

  return { added, removed, changed, unchanged };
}

/**
 * 索引存储。
 *
 * 典型用法（UI 层）：
 * ```ts
 * const store = new IndexStore({ createBackend: createIdbBackend({ dbName: indexDbNameForVault(name) }) });
 * await store.load();                       // 有快照则 0 请求
 * if (store.entryCount === 0) await store.scan({ rootFid, list });
 * ```
 */
export class IndexStore {
  private readonly createBackend: IndexBackendFactory;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxReopen: number;
  private readonly onStatusChange?: (status: IndexStoreStatus) => void;

  private backend: IndexStoreBackend | null = null;
  /** 降级后使用的内存后端（用于识别「已经降级过」，避免重复重建）。 */
  private memoryBackend: MemoryIndexBackend | null = null;
  private entriesMap = new Map<string, IndexEntry>();
  private meta: IndexMeta = { version: 0, builtAt: 0, rootFid: "" };
  private degraded = false;
  private reason = "";
  private reopenAttempts = 0;
  private lastDiff: IndexDiff = { added: [], removed: [], changed: [], unchanged: 0 };

  constructor(options: IndexStoreOptions) {
    if (!options || typeof options.createBackend !== "function") {
      throw new Error("IndexStore 需要一个 createBackend 工厂");
    }
    this.createBackend = options.createBackend;
    this.now = options.now ?? ((): number => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
    this.maxReopen = Math.max(1, options.maxReopen ?? REOPEN_DELAYS_MS.length);
    this.onStatusChange = options.onStatusChange;
  }

  get status(): IndexStoreStatus {
    return {
      degraded: this.degraded,
      backend: this.backend && this.backend.kind === "memory" ? "memory" : "idb",
      reason: this.reason,
      entryCount: this.entriesMap.size,
      version: this.meta.version,
      builtAt: this.meta.builtAt,
      rootFid: this.meta.rootFid,
      reopenAttempts: this.reopenAttempts,
    };
  }

  get entries(): IndexEntry[] {
    return Array.from(this.entriesMap.values());
  }

  get entryCount(): number {
    return this.entriesMap.size;
  }

  get metaInfo(): IndexMeta {
    return { ...this.meta };
  }

  get lastDiffResult(): IndexDiff {
    return this.lastDiff;
  }

  /** 实例方法形态的 diff（与静态方法一致）。 */
  diff(oldEntries: IndexEntry[], newEntries: IndexEntry[]): IndexDiff {
    return diffEntries(oldEntries, newEntries);
  }

  static diff(oldEntries: IndexEntry[], newEntries: IndexEntry[]): IndexDiff {
    return diffEntries(oldEntries, newEntries);
  }

  /** 建立后端；IDB 不可用则直接降级为内存（`status.degraded = true`）。 */
  async open(): Promise<IndexStoreStatus> {
    await this.ensureBackend();
    return this.status;
  }

  /** 打开并读快照（有快照 = 0 网络请求即可出树）。返回是否读到非空快照。 */
  async load(): Promise<boolean> {
    await this.ensureBackend();
    const entries = await this.exec((backend) => backend.loadEntries());
    const meta = await this.exec((backend) => backend.loadMeta());
    this.entriesMap = new Map(entries.map((entry) => [entry.path, cloneEntry(entry)]));
    this.meta = meta ? { ...meta } : { version: 0, builtAt: 0, rootFid: "" };
    this.emitStatus();
    return entries.length > 0;
  }

  /** 整体覆盖写快照（手动刷新/一次 BFS 完成后调用）。 */
  async writeSnapshot(entries: IndexEntry[], meta: Partial<IndexMeta> = {}): Promise<IndexMeta> {
    const previous = Array.from(this.entriesMap.values());
    const normalized = this.normalizeEntries(entries);
    const nextMeta: IndexMeta = {
      version: (meta.version ?? this.meta.version) + 1,
      builtAt: meta.builtAt ?? this.now(),
      rootFid: meta.rootFid ?? this.meta.rootFid,
    };
    await this.ensureBackend();
    await this.exec(async (backend) => {
      await backend.clearEntries();
      await backend.putEntries(normalized);
      await backend.saveMeta(nextMeta);
      await backend.saveProgress(null);
    });
    this.entriesMap = new Map(normalized.map((entry) => [entry.path, cloneEntry(entry)]));
    this.meta = { ...nextMeta };
    this.lastDiff = diffEntries(previous, normalized);
    this.emitStatus();
    return { ...nextMeta };
  }

  /**
   * 全量 BFS（可断点续扫）。
   *
   * - 有未完成的进度且 rootFid 相同 → 只扫 `pendingFolders` 里剩下的目录；
   * - 每扫完一个目录落一次盘（条目 + 进度），中断后重入不会重扫；
   * - `list` 抛错时把该目录放回队列、落盘后原样抛出（由调用方决定是否重试）。
   */
  async scan(options: ScanOptions): Promise<ScanResult> {
    await this.ensureBackend();
    const rootFid = options.rootFid;
    const previous = Array.from(this.entriesMap.values());

    let progress = await this.exec((backend) => backend.loadProgress());
    const resuming =
      progress !== null && !progress.done && progress.rootFid === rootFid && progress.entryCount > 0;

    // 原子替换（T-10 A9）：新条目先攒在临时 Map 里，扫完才一次性换掉 this.entriesMap，
    // 所以同步期间已挂载的树不会变空；失败/取消时旧索引原样保留。
    let next: Map<string, IndexEntry>;
    if (resuming) {
      next = new Map();
      for (const entry of await this.exec((backend) => backend.loadEntries())) {
        next.set(entry.path, cloneEntry(entry));
      }
    } else {
      progress = freshProgress(rootFid, this.now());
      next = new Map();
      await this.exec((backend) => backend.clearEntries());
    }
    const started = progress as ScanProgress;

    while (started.pendingFolders.length > 0) {
      if (options.signal && options.signal.aborted) {
        started.updatedAt = this.now();
        await this.persistProgress(started);
        return {
          completed: false,
          aborted: true,
          progress: cloneProgress(started),
          diff: { added: [], removed: [], changed: [], unchanged: 0 },
          requests: started.requests,
          note: "扫描被中断，进度已保存，下次从剩余目录继续",
        };
      }

      const folder = started.pendingFolders.shift() as ScanFolder;
      let children: IndexEntry[];
      try {
        children = await options.list(folder);
      } catch (error) {
        started.pendingFolders.unshift(folder);
        started.updatedAt = this.now();
        await this.persistProgress(started);
        throw error;
      }

      started.requests += 1;
      const batch: IndexEntry[] = [];
      for (const child of children) {
        const normalized = this.normalizeEntry(child);
        if (!normalized) continue;
        next.set(normalized.path, normalized);
        batch.push(normalized);
        if (
          normalized.type === "folder" &&
          started.scannedFolders.indexOf(normalized.path) < 0 &&
          !started.pendingFolders.some((queued) => queued.path === normalized.path)
        ) {
          started.pendingFolders.push({ path: normalized.path, fid: normalized.fid });
        }
      }
      if (batch.length > 0) await this.exec((backend) => backend.putEntries(batch));

      started.scannedFolders.push(folder.path);
      started.entryCount = next.size;
      started.updatedAt = this.now();
      await this.persistProgress(started);
      if (options.onProgress) {
        try {
          options.onProgress(cloneProgress(started));
        } catch {
          /* 进度回调异常不影响扫描 */
        }
      }
    }

    const snapshot = Array.from(next.values());
    const diff = diffEntries(previous, snapshot);
    started.done = true;
    started.entryCount = snapshot.length;
    started.updatedAt = this.now();
    this.meta = { version: this.meta.version + 1, builtAt: this.now(), rootFid };
    await this.exec(async (backend) => {
      await backend.saveMeta(this.meta);
      await backend.saveProgress(started);
    });
    // 到这里才原子替换内存视图（失败/取消都走不到这一行）
    this.entriesMap = next;
    this.lastDiff = diff;
    this.emitStatus();
    return {
      completed: true,
      aborted: false,
      progress: cloneProgress(started),
      diff,
      requests: started.requests,
      note: this.degraded ? `索引未持久化（${this.reason}）` : undefined,
    };
  }

  async getProgress(): Promise<ScanProgress | null> {
    await this.ensureBackend();
    return await this.exec((backend) => backend.loadProgress());
  }

  /** 清空快照（索引损坏/重建时用）。 */
  async clearAll(): Promise<void> {
    await this.ensureBackend();
    await this.exec(async (backend) => {
      await backend.clearEntries();
      await backend.saveMeta(null);
      await backend.saveProgress(null);
    });
    this.entriesMap.clear();
    this.meta = { version: 0, builtAt: 0, rootFid: "" };
    this.lastDiff = { added: [], removed: [], changed: [], unchanged: 0 };
    this.emitStatus();
  }

  async close(): Promise<void> {
    await this.closeBackend();
    this.backend = null;
  }

  // ------------------------------------------------------------ 内部

  private async persistProgress(progress: ScanProgress): Promise<void> {
    await this.exec((backend) => backend.saveProgress(progress));
  }

  private normalizeEntries(entries: IndexEntry[]): IndexEntry[] {
    const map = new Map<string, IndexEntry>();
    for (const entry of entries) {
      const normalized = this.normalizeEntry(entry);
      if (normalized) map.set(normalized.path, normalized);
    }
    return Array.from(map.values());
  }

  private normalizeEntry(entry: IndexEntry | null | undefined): IndexEntry | null {
    if (!entry || typeof entry !== "object") return null;
    const path = typeof entry.path === "string" ? entry.path : "";
    if (!path) return null;
    return cloneEntry(entry);
  }

  private async ensureBackend(): Promise<IndexStoreBackend> {
    if (this.backend) return this.backend;
    try {
      this.backend = await this.createBackend();
    } catch (error) {
      await this.degrade(`后端不可用：${errorMessage(error)}`);
    }
    return this.backend as IndexStoreBackend;
  }

  private async closeBackend(): Promise<void> {
    const backend = this.backend;
    this.backend = null;
    if (!backend) return;
    try {
      await backend.close();
    } catch {
      /* close 失败（已被挂起事务打断）忽略 */
    }
  }

  /** 降级为纯内存：把已扫到的条目搬进内存后端，功能可用、只是不持久化。 */
  private async degrade(reason: string): Promise<void> {
    if (this.memoryBackend && this.backend === this.memoryBackend) {
      this.degraded = true;
      this.reason = reason;
      this.emitStatus();
      return;
    }
    const carry = Array.from(this.entriesMap.values());
    await this.closeBackend();
    const memory = new MemoryIndexBackend({
      entries: carry,
      meta: this.meta.version > 0 ? this.meta : null,
    });
    this.memoryBackend = memory;
    this.backend = memory;
    this.degraded = true;
    this.reason = reason;
    this.emitStatus();
  }

  private async exec<T>(operation: (backend: IndexStoreBackend) => Promise<T>): Promise<T> {
    const backend = await this.ensureBackend();
    try {
      return await operation(backend);
    } catch (error) {
      if (isInvalidStateError(error)) return await this.recoverInvalidState(operation);
      if (isQuotaExceededError(error)) return await this.recoverQuota(operation);
      throw error;
    }
  }

  /** `InvalidStateError` → close → 300/900/2700ms 重开（最多 maxReopen 次）→ 仍失败降级。 */
  private async recoverInvalidState<T>(operation: (backend: IndexStoreBackend) => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < this.maxReopen; attempt += 1) {
      this.reopenAttempts += 1;
      const waitMs = REOPEN_DELAYS_MS[Math.min(attempt, REOPEN_DELAYS_MS.length - 1)];
      await this.sleep(waitMs);
      try {
        await this.closeBackend();
        this.backend = await this.createBackend();
      } catch {
        this.backend = null;
        continue;
      }
      try {
        return await operation(this.backend);
      } catch (error) {
        if (isInvalidStateError(error)) {
          this.backend = null;
          continue;
        }
        if (isQuotaExceededError(error)) return await this.recoverQuota(operation);
        throw error;
      }
    }
    await this.degrade(`重开索引库失败（已试 ${this.maxReopen} 次）`);
    return await operation(this.backend as IndexStoreBackend);
  }

  /** `QuotaExceededError` → 清旧快照重试一次 → 仍失败降级。 */
  private async recoverQuota<T>(operation: (backend: IndexStoreBackend) => Promise<T>): Promise<T> {
    const backend = await this.ensureBackend();
    try {
      await backend.clearEntries();
    } catch {
      /* 清空失败就继续尝试重试，最终会走降级 */
    }
    try {
      return await operation(backend);
    } catch (error) {
      if (isQuotaExceededError(error)) {
        await this.degrade("索引库配额不足");
        return await operation(this.backend as IndexStoreBackend);
      }
      if (isInvalidStateError(error)) return await this.recoverInvalidState(operation);
      throw error;
    }
  }

  private emitStatus(): void {
    if (!this.onStatusChange) return;
    try {
      this.onStatusChange(this.status);
    } catch {
      /* 状态回调异常不影响存储逻辑 */
    }
  }
}
