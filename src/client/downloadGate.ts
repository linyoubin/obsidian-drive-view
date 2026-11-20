/**
 * downloadGate —— 下载通道的有界并发闸门（0.2.4）。
 *
 * 真机证据（2026-11-20 09:00:28）：Obsidian 挂载后扫全库建元数据，同一毫秒数十个
 * 下载并发把通道打爆 → 全部 `Request failed. 请求超时`，随后 cookie 被判失效（401）。
 *
 * 本模块只做「排队 + 并发上限 + 401 短路」，不含任何网络/存储逻辑，便于单测：
 *   - FIFO；可选 `high` 优先级插队（同优先级仍 FIFO）；
 *   - 并发峰值可观测（`peak`），默认 2，可 1–3 配置；
 *   - 401 熔断：`failAuth()` 立即清空队列（排队任务以 `auth-expired` 拒绝）、
 *     并在冷却期内直接拒绝新任务（不再发请求）；重新扫码后 `resetAuth()` 恢复。
 */

export type GatePriority = "normal" | "high";

/** 可取消信号（结构与 `AbortSignal` 兼容，便于注入）。 */
export interface GateSignal {
  aborted: boolean;
}

export interface GateRunOptions {
  priority?: GatePriority;
  signal?: GateSignal | null;
}

export interface DownloadGateOptions {
  /** 并发上限，默认 2。 */
  concurrency?: number;
  /** 时间源（单测注入假时钟），默认 `Date.now`。 */
  now?: () => number;
}

export type DownloadGateErrorKind = "auth-expired" | "aborted";

/** 闸门拒绝：登录已失效（熔断中）或任务被取消。 */
export class DownloadGateError extends Error {
  readonly kind: DownloadGateErrorKind;
  readonly retryAfterMs: number;

  constructor(kind: DownloadGateErrorKind, message: string, retryAfterMs = 0) {
    super(message);
    this.name = "DownloadGateError";
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

interface PendingTask<T = unknown> {
  task: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  priority: GatePriority;
  signal: GateSignal | null;
}

// 队列元素类型放宽：run<T> 里的 PendingTask<T> 与内部 push 的 PendingTask 需要兼容
type QueuedTask = PendingTask<any>;

/** 默认并发上限：2（手机端通道很脆，别超过 2 路同时下载）。 */
export const DEFAULT_DOWNLOAD_CONCURRENCY = 2;
/** 401 后的默认冷却：60 秒（期间不再发任何下载请求）。 */
export const DEFAULT_AUTH_COOLDOWN_MS = 60_000;

export class DownloadGate {
  private readonly now: () => number;
  private queue: QueuedTask[] = [];
  private activeCount = 0;
  private peakActive = 0;
  private startedCount = 0;
  private concurrencyValue: number;
  private authExpiredUntil = 0;

  constructor(options: DownloadGateOptions = {}) {
    this.now = options.now ?? ((): number => Date.now());
    this.concurrencyValue = normalizeGateConcurrency(options.concurrency);
  }

  /** 当前并发上限。 */
  get concurrency(): number {
    return this.concurrencyValue;
  }

  /** 正在执行的任务数。 */
  get active(): number {
    return this.activeCount;
  }

  /** 排队中的任务数。 */
  get pending(): number {
    return this.queue.length;
  }

  /** 历史并发峰值（单测断言「never 超过配置值」用）。 */
  get peak(): number {
    return this.peakActive;
  }

  /** 累计已启动任务数。 */
  get started(): number {
    return this.startedCount;
  }

  /** 调整并发上限（1–3 生效范围由设置页保证；这里只做下限/上限保护）。 */
  setConcurrency(value: number): number {
    this.concurrencyValue = normalizeGateConcurrency(value);
    this.pump();
    return this.concurrencyValue;
  }

  /** 排队执行一个任务；返回任务结果或拒绝原因。 */
  run<T>(task: () => Promise<T>, options: GateRunOptions = {}): Promise<T> {
    const signal = options.signal ?? null;
    if (signal && signal.aborted) {
      return Promise.reject(new DownloadGateError("aborted", "下载任务已取消"));
    }
    if (this.isAuthExpired()) {
      return Promise.reject(
        new DownloadGateError(
          "auth-expired",
          `登录已失效，暂不下载（还剩 ${Math.ceil(this.authRetryAfterMs() / 1000)} 秒）`,
          this.authRetryAfterMs()
        )
      );
    }
    return new Promise<T>((resolve, reject) => {
      const pending: PendingTask<T> = {
        task,
        resolve,
        reject,
        priority: options.priority === "high" ? "high" : "normal",
        signal,
      };
      this.enqueue(pending);
      this.pump();
    });
  }

  /**
   * 401 熔断：进入 `auth-expired` 状态（冷却 `cooldownMs`，默认 60s），
   * 清空排队任务并让它们立即以 `auth-expired` 拒绝。已开始的任务不受影响（会自己失败）。
   */
  failAuth(cooldownMs: number = DEFAULT_AUTH_COOLDOWN_MS): void {
    this.authExpiredUntil = this.now() + Math.max(1, cooldownMs);
    const rejected = this.queue.splice(0);
    const error = new DownloadGateError(
      "auth-expired",
      "登录已失效，请重新扫码（下载已暂停）",
      this.authRetryAfterMs()
    );
    for (const item of rejected) item.reject(error);
  }

  /** 是否处于 401 冷却期。 */
  isAuthExpired(): boolean {
    return this.authExpiredUntil > 0 && this.now() < this.authExpiredUntil;
  }

  /** 冷却剩余毫秒数（未熔断为 0）。 */
  authRetryAfterMs(): number {
    return this.isAuthExpired() ? Math.max(0, this.authExpiredUntil - this.now()) : 0;
  }

  /** 重新扫码成功后调用：解除冷却，允许新任务。 */
  resetAuth(): void {
    this.authExpiredUntil = 0;
  }

  private enqueue(pending: QueuedTask): void {
    if (pending.priority === "high") {
      // 插到最后一个 high 之后、所有 normal 之前（同优先级仍 FIFO）
      let index = this.queue.length;
      for (let i = 0; i < this.queue.length; i += 1) {
        if (this.queue[i].priority === "normal") {
          index = i;
          break;
        }
      }
      this.queue.splice(index, 0, pending);
      return;
    }
    this.queue.push(pending);
  }

  private pump(): void {
    while (this.activeCount < this.concurrencyValue && this.queue.length > 0) {
      const pending = this.queue.shift() as QueuedTask;
      if (pending.signal && pending.signal.aborted) {
        pending.reject(new DownloadGateError("aborted", "下载任务已取消"));
        continue;
      }
      if (this.isAuthExpired()) {
        pending.reject(
          new DownloadGateError(
            "auth-expired",
            "登录已失效，请重新扫码（下载已暂停）",
            this.authRetryAfterMs()
          )
        );
        continue;
      }
      this.start(pending);
    }
  }

  private start(pending: QueuedTask): void {
    this.activeCount += 1;
    this.startedCount += 1;
    if (this.activeCount > this.peakActive) this.peakActive = this.activeCount;
    Promise.resolve()
      .then(() => pending.task())
      .then(
        (value) => pending.resolve(value),
        (error) => pending.reject(error)
      )
      .finally(() => {
        this.activeCount -= 1;
        this.pump();
      });
  }
}

/** 并发上限归一：1–8（设置页只暴露 1–3，这里防御更宽的值）。 */
export function normalizeGateConcurrency(value: number | undefined): number {
  const numeric = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : DEFAULT_DOWNLOAD_CONCURRENCY;
  return Math.min(8, Math.max(1, numeric));
}
