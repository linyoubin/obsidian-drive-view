/**
 * ContentCache —— 正文/附件的纯内存 LRU 缓存（v3 §5）。
 *
 * 硬约束（用户原话「不占用本地空间」）：
 *   - 只在内存里放 `ArrayBuffer`，上限默认 8 MB（可配置），满了逐出最久未用；
 *   - 逐出时若环境提供 `URL.revokeObjectURL` 就调用，避免 blob URL 泄漏；
 *   - 预取受两条闸门控制：一次最多 5 个、单文件 >2 MB 不自动预取；
 *   - 本模块不做任何持久化（不碰 IDB、不碰插件数据、不碰磁盘），因此不需要也不接受存储后端。
 *
 * 交付给 adapter 的接口是 `getResourceUrl(path)`：命中返回 `blob:` URL，未命中返回 `""`
 * （`DataAdapter.getResourcePath` 是同步接口，不能等网络；未命中由调用方排队预取）。
 *
 * 不 import `fs`/`path`/`child_process`/`electron`/`node:`，不引 npm 依赖。
 */

/** 默认上限：8 MB（`ledger-任务.md` 定档）。 */
export const DEFAULT_CONTENT_CACHE_BYTES = 8 * 1024 * 1024;
/** 预取批大小：一次 5 个。 */
export const DEFAULT_PREFETCH_LIMIT = 5;
/** 单文件超过此大小不自动预取：2 MB。 */
export const DEFAULT_PREFETCH_MAX_BYTES = 2 * 1024 * 1024;

export interface ContentCacheOptions {
  /** 总字节上限，默认 8 MB。 */
  maxBytes?: number;
  /** 预取并发/批大小，默认 5。 */
  prefetchLimit?: number;
  /** 单文件自动预取上限，默认 2 MB。 */
  prefetchMaxBytes?: number;
  /** 生成 blob URL；缺省用运行期 `URL.createObjectURL`（不可用则返回空串）。 */
  createObjectUrl?: (data: ArrayBuffer) => string;
  /** 释放 blob URL；缺省用运行期 `URL.revokeObjectURL`。 */
  revokeObjectUrl?: (url: string) => void;
  now?: () => number;
  /** 逐出回调（诊断/状态栏用）。 */
  onEvict?: (path: string, bytes: number) => void;
}

/** 一条缓存条目的公开信息（不含内容本身）。 */
export interface CachedContent {
  path: string;
  bytes: number;
  url: string;
  fid: string;
  mtime: number;
  loadedAt: number;
}

interface CacheEntry extends CachedContent {
  data: ArrayBuffer;
}

export interface ContentMeta {
  fid?: string;
  mtime?: number;
}

export interface PrefetchItem {
  path: string;
  /** 已知大小（来自索引）；超过 `prefetchMaxBytes` 的直接跳过。 */
  size?: number;
}

export type ContentLoader = (path: string) => Promise<ArrayBuffer>;

export interface PrefetchResult {
  loaded: number;
  failed: number;
  skipped: number;
  bytes: number;
}

export interface PutResult {
  cached: boolean;
  evicted: string[];
}

function defaultCreateObjectUrl(data: ArrayBuffer): string {
  const urlApi = (globalThis as { URL?: { createObjectURL?: (blob: unknown) => string } }).URL;
  const BlobCtor = (globalThis as { Blob?: new (parts: unknown[]) => unknown }).Blob;
  if (!urlApi || typeof urlApi.createObjectURL !== "function" || typeof BlobCtor !== "function") return "";
  try {
    return urlApi.createObjectURL(new BlobCtor([data]));
  } catch {
    return "";
  }
}

function defaultRevokeObjectUrl(url: string): void {
  const urlApi = (globalThis as { URL?: { revokeObjectURL?: (target: string) => void } }).URL;
  if (!urlApi || typeof urlApi.revokeObjectURL !== "function") return;
  try {
    urlApi.revokeObjectURL(url);
  } catch {
    /* 释放失败不影响缓存逻辑 */
  }
}

function byteLengthOf(data: ArrayBuffer | Uint8Array | null | undefined): number {
  if (!data) return 0;
  if (typeof (data as ArrayBuffer).byteLength === "number") return (data as ArrayBuffer).byteLength;
  return 0;
}

/** 把 `Uint8Array` 的切片安全转成独立的 `ArrayBuffer`（避免带着底层大 buffer）。 */
function toArrayBuffer(data: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (data instanceof Uint8Array) {
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    return copy.buffer;
  }
  return data;
}

/**
 * 内存 LRU 内容缓存。
 *
 * 迭代顺序即 LRU 顺序：`Map` 头部最旧，命中时把条目移到尾部。
 */
export class ContentCache {
  private readonly maxBytesValue: number;
  private readonly prefetchLimitValue: number;
  private readonly prefetchMaxBytesValue: number;
  private readonly createUrl: (data: ArrayBuffer) => string;
  private readonly revokeUrl: (url: string) => void;
  private readonly now: () => number;
  private readonly onEvict?: (path: string, bytes: number) => void;

  private readonly entries = new Map<string, CacheEntry>();
  private totalBytes = 0;
  private queue: PrefetchItem[] = [];

  constructor(options: ContentCacheOptions = {}) {
    this.maxBytesValue = Math.max(1, options.maxBytes ?? DEFAULT_CONTENT_CACHE_BYTES);
    this.prefetchLimitValue = Math.max(1, options.prefetchLimit ?? DEFAULT_PREFETCH_LIMIT);
    this.prefetchMaxBytesValue = Math.max(1, options.prefetchMaxBytes ?? DEFAULT_PREFETCH_MAX_BYTES);
    this.createUrl = options.createObjectUrl ?? defaultCreateObjectUrl;
    this.revokeUrl = options.revokeObjectUrl ?? defaultRevokeObjectUrl;
    this.now = options.now ?? ((): number => Date.now());
    this.onEvict = options.onEvict;
  }

  get maxBytes(): number {
    return this.maxBytesValue;
  }

  get prefetchLimit(): number {
    return this.prefetchLimitValue;
  }

  get prefetchMaxBytes(): number {
    return this.prefetchMaxBytesValue;
  }

  /** 已占用字节数。 */
  get bytes(): number {
    return this.totalBytes;
  }

  /** 条目数。 */
  get size(): number {
    return this.entries.size;
  }

  /** 键列表：从最久未用到最近使用。 */
  keys(): string[] {
    return Array.from(this.entries.keys());
  }

  has(path: string): boolean {
    return this.entries.has(path);
  }

  /** 只读查看条目（不刷新 LRU）。 */
  peek(path: string): CachedContent | null {
    const entry = this.entries.get(path);
    if (!entry) return null;
    return {
      path: entry.path,
      bytes: entry.bytes,
      url: entry.url,
      fid: entry.fid,
      mtime: entry.mtime,
      loadedAt: entry.loadedAt,
    };
  }

  /** 取内容并刷新 LRU 位置。 */
  get(path: string): ArrayBuffer | null {
    const entry = this.entries.get(path);
    if (!entry) return null;
    this.touch(path, entry);
    return entry.data;
  }

  /** `DataAdapter.getResourcePath` 用：命中给 `blob:` URL，未命中给 `""`（并刷新 LRU）。 */
  getResourceUrl(path: string): string {
    const entry = this.entries.get(path);
    if (!entry) return "";
    this.touch(path, entry);
    return entry.url;
  }

  /**
   * 写入内容。
   *
   * - 单条大于总上限 → 不缓存（返回 `cached:false`，避免进来就把别的全挤掉）；
   * - 写入后超限则从最旧开始逐出，逐出的条目会 `revokeUrl`。
   */
  put(path: string, data: ArrayBuffer | Uint8Array, meta: ContentMeta = {}): PutResult {
    if (!path) return { cached: false, evicted: [] };
    const bytes = byteLengthOf(data as ArrayBuffer);
    if (bytes <= 0) return { cached: false, evicted: [] };
    if (bytes > this.maxBytesValue) return { cached: false, evicted: [] };

    const evicted: string[] = [];
    const existing = this.entries.get(path);
    if (existing) this.removeEntry(path, evicted);

    while (this.totalBytes + bytes > this.maxBytesValue && this.entries.size > 0) {
      const oldestKey = this.entries.keys().next();
      if (!oldestKey || oldestKey.done) break;
      this.removeEntry(oldestKey.value, evicted);
    }

    const buffer = toArrayBuffer(data);
    const entry: CacheEntry = {
      path,
      bytes,
      url: this.createUrl(buffer),
      fid: typeof meta.fid === "string" ? meta.fid : "",
      mtime: typeof meta.mtime === "number" ? meta.mtime : 0,
      loadedAt: this.now(),
      data: buffer,
    };
    this.entries.set(path, entry);
    this.totalBytes += bytes;
    return { cached: true, evicted };
  }

  /** 删除一条（会 revoke URL）。 */
  delete(path: string): boolean {
    if (!this.entries.has(path)) return false;
    const evicted: string[] = [];
    this.removeEntry(path, evicted);
    return true;
  }

  /** 清空（逐条 revoke）。 */
  clear(): void {
    const evicted: string[] = [];
    for (const path of Array.from(this.entries.keys())) this.removeEntry(path, evicted);
    this.queue = [];
  }

  // ------------------------------------------------------------ 预取

  get pendingPrefetch(): number {
    return this.queue.length;
  }

  /**
   * 入队待预取项。
   *
   * 跳过：已缓存、已在队列、无 path、以及已知大小 > `prefetchMaxBytes`（2 MB）的文件。
   */
  enqueuePrefetch(items: PrefetchItem[]): { queued: number; skipped: number } {
    let queued = 0;
    let skipped = 0;
    for (const item of items) {
      const path = item && typeof item.path === "string" ? item.path : "";
      if (!path || this.entries.has(path) || this.queue.some((queuedItem) => queuedItem.path === path)) {
        skipped += 1;
        continue;
      }
      if (typeof item.size === "number" && item.size > this.prefetchMaxBytesValue) {
        // 大文件不自动取：一期按需打开时再走下载
        skipped += 1;
        continue;
      }
      this.queue.push({ path, size: item.size });
      queued += 1;
    }
    return { queued, skipped };
  }

  clearPrefetch(): void {
    this.queue = [];
  }

  /**
   * 执行预取队列：每批最多 `prefetchLimit`（5）个并发，批间串行。
   *
   * 加载失败不计入缓存、不重试（一期口径：手动/按需）。
   */
  async runPrefetch(loader: ContentLoader): Promise<PrefetchResult> {
    const result: PrefetchResult = { loaded: 0, failed: 0, skipped: 0, bytes: 0 };
    if (typeof loader !== "function") return result;

    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.prefetchLimitValue);
      const outcomes = await Promise.all(
        batch.map(async (item) => {
          if (this.entries.has(item.path)) return { status: "skipped" as const, bytes: 0 };
          try {
            const data = await loader(item.path);
            const bytes = byteLengthOf(data);
            if (bytes <= 0) return { status: "skipped" as const, bytes: 0 };
            const put = this.put(item.path, data);
            return put.cached ? { status: "loaded" as const, bytes } : { status: "skipped" as const, bytes: 0 };
          } catch {
            return { status: "failed" as const, bytes: 0 };
          }
        })
      );
      for (const outcome of outcomes) {
        if (outcome.status === "loaded") {
          result.loaded += 1;
          result.bytes += outcome.bytes;
        } else if (outcome.status === "failed") {
          result.failed += 1;
        } else {
          result.skipped += 1;
        }
      }
    }
    return result;
  }

  /** 便捷方法：入队 + 立即执行。 */
  async prefetch(items: PrefetchItem[], loader: ContentLoader): Promise<PrefetchResult> {
    this.enqueuePrefetch(items);
    return await this.runPrefetch(loader);
  }

  // ------------------------------------------------------------ 内部

  private touch(path: string, entry: CacheEntry): void {
    this.entries.delete(path);
    this.entries.set(path, entry);
  }

  private removeEntry(path: string, evicted: string[]): void {
    const entry = this.entries.get(path);
    if (!entry) return;
    this.entries.delete(path);
    this.totalBytes = Math.max(0, this.totalBytes - entry.bytes);
    if (entry.url) this.revokeUrl(entry.url);
    evicted.push(path);
    if (this.onEvict) {
      try {
        this.onEvict(path, entry.bytes);
      } catch {
        /* 回调异常不影响逐出 */
      }
    }
  }
}
