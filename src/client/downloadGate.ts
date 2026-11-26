/**
 * downloadGate —— 下载通道的有界并发闸门（0.2.4 → 0.2.11 双优先级）。
 *
 * 真机证据：
 *   - 2026-11-20 09:00:28：Obsidian 挂载后扫全库建元数据，数十个并发下载把通道打爆（超时 + 401）；
 *   - 2026-11-25 07:48:02：打开一篇嵌了上百张 jpeg 的 md，47ms 内几百个 `stage=read hit=false`，
 *     图片读取把正文读取**饿死**在队列后面（md 的 read 行根本没出现）。
 *
 * 本模块只做「排队 + 双优先级 + 并发上限 + 401 短路」，不含网络/存储逻辑：
 *   - `interactive`（用户正在打开的正文/手动点开的文件）：优先，最多 2 路；
 *   - `background`（预取附件）：interactive 有等待项时**不得占用空闲槽位**，最多 2 路；
 *   - 总并发仍受 `concurrency`（默认 4，1–6 可配）约束；
 *   - 401 熔断：`failAuth()` 立即清空两个队列并拒绝排队任务；冷却期内新任务直接拒绝。
 *
 * 事件（0.2.11，供 `stage=gate` 日志）：queued / acquired / abandoned，带 prio 与 waitMs。
 */

export type GatePriority = "interactive" | "background" | "background-user" | "bulk" | "high" | "normal";
export type GatePriorityClass = "i" | "bg" | "bg-user" | "bulk";
export type GateState = "queued" | "acquired" | "abandoned";

/** 可取消信号（结构与 `AbortSignal` 兼容，便于注入）。 */
export interface GateSignal {
  aborted: boolean;
}

export interface GateRunOptions {
  priority?: GatePriority;
  signal?: GateSignal | null;
  /** 库内路径（仅用于 `stage=gate` 日志）。 */
  path?: string;
  /**
   * 0.2.26：判定来源（`recentOpened|active|md-default|bulk|bg|bg-user`），
   * 只用于诊断日志，不参与调度。
   */
  reason?: string;
}

/** 闸门事件（0.2.11）：main 转成 `stage=gate … state=… prio=… waitMs=… reason=…` 日志。 */
export interface GateEvent {
  state: GateState;
  priority: GatePriorityClass;
  path: string;
  waitMs: number;
  /** 0.2.26：优先级判定来源（空串 = 旧调用没传）。 */
  reason: string;
}

export interface DownloadGateOptions {
  /** 总并发上限，默认 4（范围 1–6）。 */
  concurrency?: number;
  /** interactive 通道上限，默认 2。 */
  interactiveLimit?: number;
  /** background 通道上限，默认 2。 */
  backgroundLimit?: number;
  /** bulk 通道上限，默认 2（全库 md 正文，最低优先级）。 */
  bulkLimit?: number;
  /** 时间源（单测注入假时钟），默认 `Date.now`。 */
  now?: () => number;
  /** 事件回调（单测/日志用）。 */
  onEvent?: (event: GateEvent) => void;
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
  priority: GatePriorityClass;
  signal: GateSignal | null;
  path: string;
  enqueuedAt: number;
  /** 0.2.26：判定来源（仅日志）。 */
  reason: string;
}

// 队列元素类型放宽：run<T> 里的 PendingTask<T> 与内部 push 的 PendingTask 需要兼容
type QueuedTask = PendingTask<any>;

/** 默认总并发上限：4（用户口径「超过 4 个就等待」）。 */
export const DEFAULT_DOWNLOAD_CONCURRENCY = 4;
/** interactive 通道默认上限：2。 */
export const DEFAULT_INTERACTIVE_LIMIT = 2;
/** background 通道默认上限：2。 */
export const DEFAULT_BACKGROUND_LIMIT = 2;
/** bulk 通道默认上限：2（全库 md 正文预取，最低优先级）。 */
export const DEFAULT_BULK_LIMIT = 2;
/** 401 后的默认冷却：60 秒。 */
export const DEFAULT_AUTH_COOLDOWN_MS = 60_000;

/** 优先级归一：`high`/`interactive` → i；`background-user` → bg-user；其余 → bg。 */
export function normalizeGatePriority(priority: GatePriority | undefined): GatePriorityClass {
  if (priority === "interactive" || priority === "high") return "i";
  if (priority === "background-user") return "bg-user";
  if (priority === "bulk") return "bulk";
  return "bg";
}

export class DownloadGate {
  private readonly now: () => number;
  private readonly onEvent?: (event: GateEvent) => void;
  private interactiveQueue: QueuedTask[] = [];
  private backgroundQueue: QueuedTask[] = [];
  /** 0.2.21 S3：用户点开的附件（最高 bg 优先级，预取不得堵住它）。 */
  private backgroundUserQueue: QueuedTask[] = [];
  private interactiveActive = 0;
  private backgroundActive = 0;
  private backgroundUserActive = 0;
  private bulkQueue: QueuedTask[] = [];
  private bulkActive = 0;
  private peakActive = 0;
  private startedCount = 0;
  private concurrencyValue: number;
  private interactiveLimitValue: number;
  private backgroundLimitValue: number;
  private bulkLimitValue: number;
  private authExpiredUntil = 0;
  /** 0.2.16：点击让路——bulk 暂停到此时间（0 = 未暂停）。 */
  private bulkPausedUntil = 0;

  constructor(options: DownloadGateOptions = {}) {
    this.now = options.now ?? ((): number => Date.now());
    this.onEvent = options.onEvent;
    this.concurrencyValue = normalizeGateConcurrency(options.concurrency);
    this.interactiveLimitValue = Math.max(1, options.interactiveLimit ?? DEFAULT_INTERACTIVE_LIMIT);
    this.backgroundLimitValue = Math.max(1, options.backgroundLimit ?? DEFAULT_BACKGROUND_LIMIT);
    this.bulkLimitValue = Math.max(1, options.bulkLimit ?? DEFAULT_BULK_LIMIT);
  }

  get concurrency(): number {
    return this.concurrencyValue;
  }

  get interactiveLimit(): number {
    return this.interactiveLimitValue;
  }

  get backgroundLimit(): number {
    return this.backgroundLimitValue;
  }

  /** 正在执行的任务数（全部通道合计）。 */
  get active(): number {
    return this.interactiveActive + this.backgroundActive + this.backgroundUserActive + this.bulkActive;
  }

  get interactiveActiveCount(): number {
    return this.interactiveActive;
  }

  /** 0.2.26：interactive 排队数（md 默认 interactive 的预算判定用）。 */
  get interactivePendingCount(): number {
    return this.interactiveQueue.length;
  }

  get backgroundActiveCount(): number {
    return this.backgroundActive;
  }

  /** 0.2.21 S3：用户点开的附件正在下载数。 */
  get backgroundUserActiveCount(): number {
    return this.backgroundUserActive;
  }

  /** 正在执行的 bulk 任务数（0.2.18：failAuth 后必须归零）。 */
  get bulkActiveCount(): number {
    return this.bulkActive;
  }

  /** 排队中的任务数（全部通道合计）。 */
  get pending(): number {
    return (
      this.interactiveQueue.length +
      this.backgroundQueue.length +
      this.backgroundUserQueue.length +
      this.bulkQueue.length
    );
  }

  /** 历史并发峰值（单测断言「never 超过配置值」用）。 */
  get peak(): number {
    return this.peakActive;
  }

  /** 累计已启动任务数。 */
  get started(): number {
    return this.startedCount;
  }

  /** 调整总并发上限（1–6 由设置页保证；这里只做下限/上限保护）。 */
  setConcurrency(value: number): number {
    this.concurrencyValue = normalizeGateConcurrency(value);
    this.pump();
    return this.concurrencyValue;
  }

  /** 排队执行一个任务；返回任务结果或拒绝原因。 */
  run<T>(task: () => Promise<T>, options: GateRunOptions = {}): Promise<T> {
    const signal = options.signal ?? null;
    const priority = normalizeGatePriority(options.priority);
    const path = options.path ?? "";
    const reason = options.reason ?? "";
    if (signal && signal.aborted) {
      this.emit("abandoned", priority, path, 0, reason);
      return Promise.reject(new DownloadGateError("aborted", "下载任务已取消"));
    }
    if (this.isAuthExpired()) {
      this.emit("abandoned", priority, path, 0, reason);
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
        priority,
        signal,
        path,
        enqueuedAt: this.now(),
        reason,
      };
      this.enqueue(pending);
      this.emit("queued", priority, path, 0, reason);
      this.pump();
    });
  }

  /**
   * 401 熔断：进入 `auth-expired` 状态（冷却 `cooldownMs`，默认 60s），
   * 清空 interactive + background + background-user + bulk **四个队列**并让排队任务立即以
   * `auth-expired` 拒绝。已开始的任务不受影响（会自己失败）。
   *
   * 0.2.18 B4：bulk 队列此前漏清 —— 只能靠「另一个任务跑完 → finally 里的 pump」顺带拒绝。
   * 0.2.22 M1：`backgroundUserQueue` 同样漏清 —— 401 后用户点开的附件会一直 pending。
   * 现在按队列实际清空四个，并在末尾 `pump()` 兜底。
   */
  failAuth(cooldownMs: number = DEFAULT_AUTH_COOLDOWN_MS): void {
    this.authExpiredUntil = this.now() + Math.max(1, cooldownMs);
    const rejected = [
      ...this.interactiveQueue,
      ...this.backgroundQueue,
      ...this.backgroundUserQueue,
      ...this.bulkQueue,
    ];
    this.interactiveQueue = [];
    this.backgroundQueue = [];
    this.backgroundUserQueue = [];
    this.bulkQueue = [];
    const error = new DownloadGateError(
      "auth-expired",
      "登录已失效，请重新扫码（下载已暂停）",
      this.authRetryAfterMs()
    );
    for (const item of rejected) {
      this.emit("abandoned", item.priority, item.path, this.now() - item.enqueuedAt, item.reason);
      item.reject(error);
    }
    // 队列已空；pump 一次让「刚好在 start 里没被熔断拦住」的边界状态收敛（幂等）
    this.pump();
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
    if (pending.priority === "i") this.interactiveQueue.push(pending);
    else if (pending.priority === "bulk") this.bulkQueue.push(pending);
    else if (pending.priority === "bg-user") this.backgroundUserQueue.push(pending);
    else this.backgroundQueue.push(pending);
  }

  /**
   * 调度（0.2.11 双通道）：
   *   - interactive 有等待项 → 只启动 interactive（background 不得占用空闲槽位）；
   *   - interactive 队列空 → 用 background 填满剩余槽位；
   *   - 总启动数始终 ≤ `concurrency`；单通道不超过各自上限。
   */
  /**
   * 调度（0.2.16 三通道 + 留槽 + 让路）：
   *   - interactive 队列非空 → 只启动 interactive（bg/bulk 不抢槽位）；
   *   - **强制留 1 槽**：bg+bulk 合计并发 ≤ max(1, concurrency-1)；
   *   - 点击让路：bulk 在 `bulkPausedUntil` 之前不启动。
   */
  private pump(): void {
    for (;;) {
      if (this.active >= this.concurrencyValue) return;

      if (this.interactiveQueue.length > 0) {
        if (this.interactiveActive < this.interactiveLimitValue) {
          const pending = this.interactiveQueue.shift() as QueuedTask;
          if (!this.start(pending)) continue;
          continue;
        }
        return; // interactive 等待项存在：bg/bulk 不启动新任务
      }

      // 0.2.22 M4：用户点开的附件允许用满 `concurrency`（只有 1 并发硬上限，
      // 且预取最多 backgroundLimit-1，滥用风险已被限制），不受 lowCap 影响
      if (this.backgroundUserQueue.length > 0 && this.backgroundUserActive < 1) {
        const pending = this.backgroundUserQueue.shift() as QueuedTask;
        if (!this.start(pending)) continue;
        continue;
      }

      // 0.2.16：给 interactive 强制留 1 个槽位
      const lowCap = Math.max(1, this.concurrencyValue - 1);
      if (this.backgroundActive + this.backgroundUserActive + this.bulkActive >= lowCap) return;

      // 0.2.21 S3：预取（background）最多占 backgroundLimit-1，为 bg-user 保留 1 个槽位
      if (this.backgroundQueue.length > 0) {
        const prefetchCap = Math.max(1, this.backgroundLimitValue - 1);
        if (
          this.backgroundActive < prefetchCap &&
          this.backgroundActive + this.backgroundUserActive < this.backgroundLimitValue
        ) {
          const pending = this.backgroundQueue.shift() as QueuedTask;
          if (!this.start(pending)) continue;
          continue;
        }
        // 0.2.22 M3：预取满额时，只有「有 bg-user 在等」才让路；
        // 否则继续往下给 bulk 分配空闲槽位（不再把空槽一起丢掉）
        if (this.backgroundUserQueue.length > 0) return;
      }

      if (this.now() < this.bulkPausedUntil) return; // 点击让路：暂停 bulk 3 秒
      if (this.bulkQueue.length > 0 && this.bulkActive < this.bulkLimitValue) {
        const pending = this.bulkQueue.shift() as QueuedTask;
        if (!this.start(pending)) continue;
        continue;
      }
      return;
    }
  }

  /** 0.2.16：点击让路——暂停 bulk `ms` 毫秒（默认 3000）。 */
  pauseBulk(ms: number = 3000): void {
    this.bulkPausedUntil = this.now() + Math.max(0, ms);
  }

  /** 0.2.16：活动笔记已读完 → 提前恢复 bulk。 */
  resumeBulk(): void {
    this.bulkPausedUntil = 0;
    this.pump();
  }
  /** 启动一个任务；被取消/熔断则返回 false（继续尝试下一个）。 */
  private start(pending: QueuedTask): boolean {
    if (pending.signal && pending.signal.aborted) {
      this.emit("abandoned", pending.priority, pending.path, this.now() - pending.enqueuedAt, pending.reason);
      pending.reject(new DownloadGateError("aborted", "下载任务已取消"));
      return false;
    }
    if (this.isAuthExpired()) {
      this.emit("abandoned", pending.priority, pending.path, this.now() - pending.enqueuedAt, pending.reason);
      pending.reject(
        new DownloadGateError(
          "auth-expired",
          "登录已失效，请重新扫码（下载已暂停）",
          this.authRetryAfterMs()
        )
      );
      return false;
    }
    if (pending.priority === "i") this.interactiveActive += 1;
    else if (pending.priority === "bulk") this.bulkActive += 1;
    else if (pending.priority === "bg-user") this.backgroundUserActive += 1;
    else this.backgroundActive += 1;
    this.startedCount += 1;
    if (this.active > this.peakActive) this.peakActive = this.active;
    this.emit("acquired", pending.priority, pending.path, this.now() - pending.enqueuedAt, pending.reason);
    Promise.resolve()
      .then(() => pending.task())
      .then(
        (value) => pending.resolve(value),
        (error) => pending.reject(error)
      )
      .finally(() => {
        if (pending.priority === "i") this.interactiveActive -= 1;
        else if (pending.priority === "bulk") this.bulkActive -= 1;
        else if (pending.priority === "bg-user") this.backgroundUserActive -= 1;
        else this.backgroundActive -= 1;
        this.pump();
      });
    return true;
  }

  private emit(
    state: GateState,
    priority: GatePriorityClass,
    path: string,
    waitMs: number,
    reason = ""
  ): void {
    try {
      this.onEvent?.({ state, priority, path, waitMs: Math.max(0, Math.round(waitMs)), reason });
    } catch {
      /* 事件回调失败不影响调度 */
    }
  }
}

/** 并发上限归一：1–6（设置页暴露 1–6，这里防御越界值）。 */
export function normalizeGateConcurrency(value: number | undefined): number {
  const numeric =
    typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : DEFAULT_DOWNLOAD_CONCURRENCY;
  return Math.min(6, Math.max(1, numeric));
}
