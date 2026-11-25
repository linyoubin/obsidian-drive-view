/**
 * bulkPrefetch —— 全库 md 正文预取（0.2.13，内容搜索用）。
 *
 * 纯调度模块：不读索引、不碰网络，只按顺序/并发窗口调用 `load(path)`；
 * 调用方负责提供路径列表、缓存判断、取消信号与进度回调，便于单测。
 *
 * 规则：
 *   - 并发窗口默认 2（对应 gate 的 bulk 通道）；
 *   - 已缓存 / 在途的跳过；
 *   - 连续失败 5 次 → 暂停 60 秒（对应请求退避），然后继续；
 *   - `shouldStop()` 为 true（切换库根/退出挂载/手动取消）时**不再发起新任务**，返回 canceled。
 */

export interface BulkPrefetchOptions {
  paths: string[];
  load: (path: string) => Promise<ArrayBuffer>;
  isCached: (path: string) => boolean;
  isInFlight?: (path: string) => boolean;
  shouldStop: () => boolean;
  onProgress?: (progress: { done: number; total: number; bytes: number }) => void;
  concurrency?: number;
  maxConsecutiveFailures?: number;
  pauseMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

export interface BulkPrefetchResult {
  downloaded: number;
  bytes: number;
  skipped: number;
  failed: number;
  canceled: boolean;
  elapsedMs: number;
  total: number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function runBulkPrefetch(options: BulkPrefetchOptions): Promise<BulkPrefetchResult> {
  const paths = Array.isArray(options.paths) ? options.paths : [];
  const total = paths.length;
  const startedAt = Date.now();
  const result: BulkPrefetchResult = {
    downloaded: 0,
    bytes: 0,
    skipped: 0,
    failed: 0,
    canceled: false,
    elapsedMs: 0,
    total,
  };
  const concurrency = Math.max(1, options.concurrency ?? 2);
  const maxFailures = Math.max(1, options.maxConsecutiveFailures ?? 5);
  const pauseMs = Math.max(0, options.pauseMs ?? 60_000);
  const sleep = options.sleep ?? defaultSleep;
  let consecutiveFailures = 0;
  let cursor = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      if (options.shouldStop()) {
        result.canceled = true;
        return;
      }
      const index = cursor;
      cursor += 1;
      if (index >= total) return;
      const path = paths[index];
      if (!path || options.isCached(path) || (options.isInFlight && options.isInFlight(path))) {
        result.skipped += 1;
        options.onProgress?.({ done: result.downloaded + result.skipped, total, bytes: result.bytes });
        continue;
      }
      try {
        const data = await options.load(path);
        result.downloaded += 1;
        result.bytes += data && typeof data.byteLength === "number" ? data.byteLength : 0;
        consecutiveFailures = 0;
        options.onProgress?.({ done: result.downloaded + result.skipped, total, bytes: result.bytes });
      } catch {
        result.failed += 1;
        consecutiveFailures += 1;
        if (consecutiveFailures >= maxFailures && !options.shouldStop()) {
          await sleep(pauseMs);
          consecutiveFailures = 0;
        }
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(1, total)) }, () => worker()));
  result.elapsedMs = Date.now() - startedAt;
  return result;
}
