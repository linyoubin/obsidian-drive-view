/**
 * QuarkClient —— 夸克网盘只读网络层（纯逻辑）。
 *
 * 职责（v3 §7.2 / §7.4）：
 *   1. **统一请求方法**：每个请求都注入 `Cookie` 头，并把响应的 `set-cookie` 合并回写
 *      （Obsidian 无 cookie jar，见 `认证定案.md` 第 3 条）；
 *   2. **登录失效**：HTTP `401` 或业务 `code === 31001`（含 `require login [guest]`）→ `QuarkAuthError`；
 *   3. **风控**：`403/412/429/460` → 指数退避 `2s/4s/8s`（最多 3 次）；连续 5 次失败 → 熔断 10 分钟；
 *   4. **限速**：令牌桶 3 req/s（保守取，待真机替换）；
 *   5. 只读业务：`listDir`（`/file/sort` 分页）、`downloadFile`（`/file/download` 签名 URL 两跳）、
 *      `exchangeServiceTicket`（`account/info?st=` 换 Cookie）、`verifyAlive`（`/file/sort?pdir_fid=0` 验活）。
 *
 * 全部网络出口都在本文件；`QuarkQrAuth` 也经由这里发请求（契约 clarify 第 5 条）。
 * 不 import `obsidian` 运行时、不 import `node:`/`fs`/`path`/`electron`；transport 由调用方注入。
 */

import { CookieStore, collectSetCookieValues } from "../auth/CookieStore";
import { DEFAULT_AUTH_COOLDOWN_MS, DEFAULT_DOWNLOAD_CONCURRENCY, DownloadGate } from "./downloadGate";
import type { GateSignal } from "./downloadGate";
import { firstBytesSha8 } from "../utils/diagLog";
import type { DiagEntry } from "../utils/diagLog";
import { InflightRequests } from "./inflight";

/** 桌面 Chrome UA（与已跑通探针一致；手机端 UA 策略见 v3 §9.4 Q6，暂沿用）。 */
export const QUARK_DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36";

/** 业务 API 根（`/file/sort`、`/file/download`）。 */
export const QUARK_DRIVE_BASE = "https://drive-pc.quark.cn/1/clouddrive";
/** 账号域（`/account/info` 换 Cookie）。 */
export const QUARK_PAN_BASE = "https://pan.quark.cn";
/** 列目录。 */
export const QUARK_SORT_PATH = "/file/sort";
/** 取签名下载 URL。 */
export const QUARK_DOWNLOAD_PATH = "/file/download";
/** 每个业务请求都要带的公共查询参数（探针原样：`pr=ucpro&fr=pc`）。 */
export const QUARK_COMMON_QUERY: Record<string, string> = { pr: "ucpro", fr: "pc", uc_param_str: "" };
/** 视为风控的 HTTP 状态（探针判定集）。 */
export const QUARK_RISK_STATUSES = [403, 412, 429, 460];
/** 风控指数退避序列（毫秒）。 */
export const QUARK_BACKOFF_MS = [2000, 4000, 8000];
/** 限速：3 req/s（保守取，待真机替换）。 */
export const QUARK_DEFAULT_RATE = 3;
/** 连续失败多少次后熔断。 */
export const QUARK_RISK_STREAK_THRESHOLD = 5;
/** 熔断时长：10 分钟。 */
export const QUARK_BREAKER_MS = 10 * 60 * 1000;
/** 0.2.19 SF4：单次下载的硬超时（默认 20s；超时抛 `QuarkDownloadTimeoutError`）。 */
export const QUARK_DOWNLOAD_TIMEOUT_MS = 20_000;
/** 0.2.21 S1：僵尸请求记录的存活上限（超过即强制清理，避免永久毒化 fid）。 */
export const QUARK_ZOMBIE_TTL_MS = 60_000;
/** 0.2.21 S1：僵尸记录条数上限（按 fid 记，超出淘汰最旧）。 */
export const QUARK_ZOMBIE_MAX = 32;
/** 0.2.21 S2：等待僵尸的上限（实际取 min(zombieTtlMs, 3s)，不复用整段下载超时）。 */
export const QUARK_ZOMBIE_WAIT_MAX_MS = 3_000;

export interface QuarkHttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
}

export interface QuarkHttpResponse {
  status: number;
  headers?: Record<string, string | string[]> | Record<string, unknown> | null;
  text?: string;
  arrayBuffer?: ArrayBuffer;
}

/** 唯一的网络出口签名：默认实现用 Obsidian 的 `requestUrl`，单测注入假 transport。 */
export type QuarkTransport = (request: QuarkHttpRequest) => Promise<QuarkHttpResponse>;

export type QuarkErrorKind = "auth" | "risk" | "api" | "protocol";

export class QuarkError extends Error {
  readonly kind: QuarkErrorKind;

  constructor(kind: QuarkErrorKind, message: string) {
    super(message);
    this.kind = kind;
    this.name = "QuarkError";
  }
}

/** 登录态失效：需要重新扫码。不自动重试（v3 §7.3）。 */
export class QuarkAuthError extends QuarkError {
  readonly status: number;
  readonly code: number | null;

  constructor(message: string, details: { status?: number; code?: number | null } = {}) {
    super("auth", message);
    this.name = "QuarkAuthError";
    this.status = details.status ?? 0;
    this.code = details.code ?? null;
  }
}

/** 风控拦截或熔断中。 */
export class QuarkRiskControlError extends QuarkError {
  readonly status: number;
  readonly retryAfterMs: number;
  readonly breakerOpen: boolean;

  constructor(message: string, details: { status?: number; retryAfterMs?: number; breakerOpen?: boolean } = {}) {
    super("risk", message);
    this.name = "QuarkRiskControlError";
    this.status = details.status ?? 0;
    this.retryAfterMs = details.retryAfterMs ?? 0;
    this.breakerOpen = details.breakerOpen === true;
  }
}

/** 业务码非 0 或协议异常（非登录、非风控）。 */
export class QuarkApiError extends QuarkError {
  readonly code: number;
  readonly status: number;

  constructor(message: string, details: { code?: number; status?: number } = {}) {
    super("api", message);
    this.name = "QuarkApiError";
    this.code = details.code ?? -1;
    this.status = details.status ?? 0;
  }
}

/**
 * 文件太大（夸克侧限制，不是本插件 bug）。
 *
 * 两个来源：
 *   - 下载前 precheck：`size > 单文件上限`（默认 5 MB），**不发请求**；
 *   - 服务端 `code=23018 download file size limit`。
 */
export class QuarkFileTooLargeError extends QuarkError {
  /** 触发的文件大小（未知时为 null）。 */
  readonly sizeBytes: number | null;
  /** 服务端业务码（precheck 触发时为 null）。 */
  readonly code: number | null;

  constructor(message: string, details: { sizeBytes?: number | null; code?: number | null } = {}) {
    super("api", message);
    this.name = "QuarkFileTooLargeError";
    this.sizeBytes = details.sizeBytes ?? null;
    this.code = details.code ?? null;
  }
}

/**
 * 用户取消下载（0.2.4 A4′）。
 *
 * 说明：`requestUrl` 没有 AbortSignal，取消**不能中断已发出的 HTTP 请求**；
 * 这里是「丢弃结果 + 不再重试 + 不写缓存」，message 固定「已取消下载」。
 */
export class QuarkDownloadCanceledError extends QuarkError {
  constructor(message = "已取消下载") {
    super("protocol", message);
    this.name = "QuarkDownloadCanceledError";
  }
}

/** 下载超时（已按策略重试过；`retried=true` 表示确实重试了 1 次）。 */
export class QuarkDownloadTimeoutError extends QuarkError {
  readonly retried: boolean;

  constructor(message: string, retried = false) {
    super("protocol", message);
    this.name = "QuarkDownloadTimeoutError";
    this.retried = retried;
  }
}

/** 下载超时 / 网络中断的判定（transport 抛错或 `requestUrl` 超时都走这里）。 */
export function isDownloadTimeoutError(error: unknown): boolean {
  if (error instanceof QuarkDownloadTimeoutError) return true;
  const name = error instanceof Error ? `${error.name} ${error.message}` : String(error ?? "");
  return /timeout|timed out|超时|ETIMEDOUT|ECONNRESET|network error|request failed/i.test(name);
}

/** 夸克「下载文件过大」业务码。 */
export const QUARK_CODE_FILE_TOO_LARGE = 23018;
/** 超时重试退避：1 秒。 */
export const QUARK_DOWNLOAD_RETRY_BACKOFF_MS = 1000;
/** 默认单文件上限：5 MB（夸克 API 下载上限附近）。 */
export const QUARK_DEFAULT_MAX_FILE_BYTES = 5 * 1024 * 1024;

export interface QuarkDirItem {
  fid: string;
  name: string;
  isFolder: boolean;
  size: number;
  updatedAt: number;
  parentFid: string;
}

export interface QuarkListOptions {
  /** 每页条数，默认 100（探针 `_size=100`）。 */
  pageSize?: number;
  /** 是否自动翻页取全量，默认 true（>100 项才不会静默截断）。 */
  all?: boolean;
  /** 排序串，默认 `file_type:asc,updated_at:desc`。 */
  sort?: string;
}

export interface QuarkListResult {
  items: QuarkDirItem[];
  /** 服务端 `metadata._total`；不可用时为已取条数。 */
  total: number;
  /** 实际发出的请求页数。 */
  pages: number;
}

export interface QuarkTicketExchange {
  status: number;
  /** 本次 `account/info` 响应下发的 Cookie 名（换 Cookie 是否成功的判据）。 */
  cookieNames: string[];
  /** 合并后的完整 Cookie 头。 */
  header: string;
}

export interface QuarkVerifyResult {
  code: number;
  itemCount: number;
  cookieNames: string[];
}

export interface QuarkRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  /** 是否按业务口径判定 401 / code=31001，默认 false（认证端点的 `status` 字段是 CAS 状态码）。 */
  checkAuth?: boolean;
  /** 覆盖本次调用的风控重试次数。 */
  maxRiskRetries?: number;
}

export interface QuarkClientOptions {
  transport: QuarkTransport;
  cookieStore?: CookieStore;
  /** 覆盖令牌桶（单测可注入假时钟）。 */
  limiter?: TokenBucket;
  ratePerSecond?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  maxRiskRetries?: number;
  riskStreakThreshold?: number;
  breakerCooldownMs?: number;
  userAgent?: string;
  /** 下载并发闸门（默认内部新建；单测可注入以观察并发峰值）。 */
  gate?: DownloadGate;
  /** 下载并发上限，默认 4（1–6 由设置页暴露）。 */
  downloadConcurrency?: number;
  /** 401 熔断冷却时长，默认 60s。 */
  authCooldownMs?: number;
  /** 登录失效时回调（同一失效期只回调一次；main.ts 据此只弹一次 Notice）。 */
  onAuthExpired?: () => void;
  /** 0.2.10：下载两跳埋点出口（main 注入 DiagLogger.log）。 */
  diag?: (entry: DiagEntry) => void;
  /** 0.2.19 SF4：单次下载硬超时（毫秒，默认 20s；0 = 关闭）。 */
  downloadTimeoutMs?: number;
  /** 0.2.21 S1：僵尸记录 TTL（毫秒，默认 60s）。 */
  zombieTtlMs?: number;
  /** 0.2.21 S2：等待僵尸的上限（毫秒，默认 3s；实际取 min(zombieTtlMs, 该值)）。 */
  zombieWaitMs?: number;
  /** 0.2.21 S1：僵尸记录条数上限，默认 32。 */
  zombieMax?: number;
}

export interface TokenBucketOptions {
  ratePerSecond?: number;
  burst?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** 0.2.20 N3：单次下载的控制位（外层超时置 aborted，底层据此停止后续跳/重试）。 */
interface DownloadControl {
  aborted: boolean;
}

/**
 * 0.2.21 S1/S2：僵尸记录。
 *
 * 下载超时后底层请求仍在跑 → 按 fid 登记；TTL 到期强制清理（不永久毒化 fid），
 * 成功后把 buffer 留给等待者复用（不白等），失败则下次重下。
 */
interface FidZombie {
  startedAt: number;
  settled: boolean;
  value?: ArrayBuffer;
  error?: unknown;
  promise: Promise<ArrayBuffer>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    // bun/node 的 timer 对象有 unref；浏览器端没有，忽略即可
    const maybeUnref = timer as unknown as { unref?: () => void };
    if (typeof maybeUnref.unref === "function") maybeUnref.unref();
  });
}

/** 令牌桶限速：默认 3 req/s。超出配额时按缺口等待（不丢请求）。 */
export class TokenBucket {
  private readonly rate: number;
  private readonly capacity: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private tokens: number;
  private lastRefillAt: number;
  private waitedMs = 0;
  /** 0.2.19 SF1：acquire 串行链（并发调用按到达顺序排队，不会读到同一个 now）。 */
  private chain: Promise<void> = Promise.resolve();

  constructor(options: TokenBucketOptions = {}) {
    this.rate = Math.max(0.001, options.ratePerSecond ?? QUARK_DEFAULT_RATE);
    this.capacity = Math.max(1, options.burst ?? Math.ceil(this.rate));
    this.now = options.now ?? ((): number => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
    this.tokens = this.capacity;
    this.lastRefillAt = this.now();
  }

  /** 累计等待毫秒数（观测/单测用）。 */
  get totalWaitedMs(): number {
    return this.waitedMs;
  }

  /**
   * 取一个令牌；返回本次实际等待的毫秒数（0 = 未受限）。
   *
   * 0.2.19 SF1：并发安全 —— 用 `chain` 串行化「读令牌 → 计算等待 → 扣令牌」，
   * 每次 acquire 原子地占用下一个槽位。改前 10 个并发都算出同一个 waitMs，
   * sleep 结束后集体放行（3 req/s 的桶实测 ≈30 req/s）。
   */
  async acquire(): Promise<number> {
    let release!: () => void;
    const previous = this.chain;
    this.chain = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      this.refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return 0;
      }
      // 缺口按速率换算成等待时长；等待后按等待时长补令牌（不依赖注入时钟是否前进）
      const deficit = 1 - this.tokens;
      const waitMs = Math.max(1, Math.ceil((deficit / this.rate) * 1000));
      await this.sleep(waitMs);
      this.waitedMs += waitMs;
      this.tokens = Math.min(this.capacity, this.tokens + (waitMs / 1000) * this.rate);
      this.tokens = Math.max(0, this.tokens - 1);
      this.lastRefillAt = this.now();
      return waitMs;
    } finally {
      release();
    }
  }

  private refill(): void {
    const at = this.now();
    const elapsed = at - this.lastRefillAt;
    if (elapsed > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + (elapsed / 1000) * this.rate);
      this.lastRefillAt = at;
    }
  }
}

/** 拼业务 URL：`${QUARK_DRIVE_BASE}${path}?pr=ucpro&fr=pc&...`。 */
export function buildDriveUrl(path: string, query: Record<string, string | number | undefined> = {}): string {
  const url = new URL(QUARK_DRIVE_BASE + path);
  const merged: Record<string, string | number | undefined> = { ...QUARK_COMMON_QUERY, ...query };
  for (const key of Object.keys(merged)) {
    const value = merged[key];
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function parseJsonText(text: string | undefined | null): Record<string, unknown> | null {
  if (typeof text !== "string" || !text) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

function numberOr(value: unknown, fallback: number): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function isRiskStatus(status: number): boolean {
  return QUARK_RISK_STATUSES.indexOf(status) >= 0;
}

function toDirItem(raw: unknown, parentFid: string): QuarkDirItem | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;
  const fidRaw = item.fid;
  if (fidRaw === undefined || fidRaw === null) return null;
  const name = typeof item.file_name === "string" ? item.file_name : String(item.file_name ?? "");
  const dirFlag = item.dir;
  const isFolder = dirFlag === true || dirFlag === 1 || dirFlag === "1";
  return {
    fid: String(fidRaw),
    name,
    isFolder,
    size: isFolder ? 0 : numberOr(item.size, 0),
    updatedAt: numberOr(item.updated_at, 0),
    parentFid,
  };
}

/**
 * 夸克只读客户端。
 *
 * 所有请求都走 `requestRaw` → 统一注入 `Cookie` 头、合并 `set-cookie`、令牌桶限速、风控退避。
 */
export class QuarkClient {
  readonly cookieStore: CookieStore;

  private readonly transport: QuarkTransport;
  private readonly limiter: TokenBucket;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRiskRetries: number;
  private readonly riskStreakThreshold: number;
  private readonly breakerCooldownMs: number;
  private readonly userAgent: string;
  /** 下载并发闸门（0.2.4：真机并发风暴后加的全局 ≤N 闸）。 */
  readonly downloadGate: DownloadGate;
  private readonly authCooldownMs: number;
  private readonly onAuthExpired?: () => void;
  /** 0.2.10：下载两跳埋点（main 注入 DiagLogger.log）。 */
  private readonly diag?: (entry: DiagEntry) => void;
  /** 0.2.19 SF4：单次下载硬超时（毫秒；0 = 关闭）。 */
  private readonly downloadTimeoutMs: number;
  /** 0.2.21 S1：僵尸记录 TTL / 条数上限。 */
  private readonly zombieTtlMs: number;
  private readonly zombieMax: number;
  /** 0.2.21 S2：等待僵尸的上限（实际取 min(zombieTtlMs, 该值)）。 */
  private readonly zombieWaitMs: number;
  /** 同一失效期内只回调一次（main.ts 只弹一次 Notice）。 */
  private authNotified = false;
  /** 0.2.17：请求序号（cookie 合并单调保护用）。 */
  private reqCounter = 0;
  /** 0.2.5：同一 fid 的进行中下载（去重表，完成即清理）。 */
  private readonly inflight = new InflightRequests();
  /** 0.2.20 N3 / 0.2.21 S1-S2：超时后仍在跑的「僵尸」请求（有 TTL/条数上限，成功结果可复用）。 */
  private readonly fidZombies = new Map<string, FidZombie>();

  private riskStreak = 0;
  private breakerOpenUntil = 0;
  private requestCount = 0;
  private lastSetCookieNames: string[] = [];

  constructor(options: QuarkClientOptions) {
    if (!options || typeof options.transport !== "function") {
      throw new QuarkError("protocol", "QuarkClient 需要一个 transport 函数");
    }
    this.transport = options.transport;
    this.cookieStore = options.cookieStore ?? new CookieStore();
    this.now = options.now ?? ((): number => Date.now());
    this.sleep = options.sleep ?? defaultSleep;
    this.maxRiskRetries = Math.max(0, options.maxRiskRetries ?? QUARK_BACKOFF_MS.length);
    this.riskStreakThreshold = Math.max(1, options.riskStreakThreshold ?? QUARK_RISK_STREAK_THRESHOLD);
    this.breakerCooldownMs = Math.max(1, options.breakerCooldownMs ?? QUARK_BREAKER_MS);
    this.userAgent = options.userAgent ?? QUARK_DEFAULT_UA;
    this.authCooldownMs = Math.max(1, options.authCooldownMs ?? DEFAULT_AUTH_COOLDOWN_MS);
    this.onAuthExpired = options.onAuthExpired;
    this.diag = options.diag;
    this.downloadTimeoutMs = Math.max(0, options.downloadTimeoutMs ?? QUARK_DOWNLOAD_TIMEOUT_MS);
    this.zombieTtlMs = Math.max(0, options.zombieTtlMs ?? QUARK_ZOMBIE_TTL_MS);
    this.zombieWaitMs = Math.max(0, options.zombieWaitMs ?? QUARK_ZOMBIE_WAIT_MAX_MS);
    this.zombieMax = Math.max(1, options.zombieMax ?? QUARK_ZOMBIE_MAX);
    this.downloadGate =
      options.gate ??
      new DownloadGate({
        concurrency: options.downloadConcurrency ?? DEFAULT_DOWNLOAD_CONCURRENCY,
        now: this.now,
        onEvent: (event) => this.logGate(event),
      });
    this.limiter =
      options.limiter ??
      new TokenBucket({
        ratePerSecond: options.ratePerSecond ?? QUARK_DEFAULT_RATE,
        now: this.now,
        sleep: this.sleep,
      });
  }

  /** 调整下载并发（设置页改完立即生效）。 */
  setDownloadConcurrency(value: number): number {
    return this.downloadGate.setConcurrency(value);
  }

  /** 登录是否处于 401 熔断期（tooltip/状态栏显示「已登录（过期）」用）。 */
  isAuthExpired(): boolean {
    return this.downloadGate.isAuthExpired();
  }

  /** 重新扫码成功后调用：解除 401 熔断与「只提示一次」标记。 */
  resetAuth(): void {
    this.authNotified = false;
    this.downloadGate.resetAuth();
    try {
      this.diag?.({ level: "info", stage: "auth", path: "/", fid: "-", message: "state=circuit-closed" });
    } catch {
      /* 日志失败忽略 */
    }
  }

  /** 观测快照：请求数、风控连击、熔断状态、当前 Cookie 名。 */
  get stats(): {
    requests: number;
    riskStreak: number;
    breakerOpen: boolean;
    breakerOpenUntil: number;
    cookieNames: string[];
    lastSetCookieNames: string[];
  } {
    return {
      requests: this.requestCount,
      riskStreak: this.riskStreak,
      breakerOpen: this.isBreakerOpen(),
      breakerOpenUntil: this.breakerOpenUntil,
      cookieNames: this.cookieStore.names(),
      lastSetCookieNames: this.lastSetCookieNames,
    };
  }

  isBreakerOpen(): boolean {
    return this.breakerOpenUntil > 0 && this.now() < this.breakerOpenUntil;
  }

  /** 手动解除熔断（重扫登录后调用）。 */
  resetBreaker(): void {
    this.breakerOpenUntil = 0;
    this.riskStreak = 0;
  }

  /**
   * 统一请求方法。
   *
   * - 注入 `Cookie` 头、合并响应 `set-cookie`、令牌桶限速；
   * - 风控状态码按 `2s/4s/8s` 退避重试，重试耗尽后计一次失败并抛 `QuarkRiskControlError`；
   * - `options.checkAuth` 为真时，`401` / `code=31001` / `require login` 抛 `QuarkAuthError`（不重试）。
   */
  async requestRaw(url: string, options: QuarkRequestOptions = {}): Promise<QuarkHttpResponse> {
    this.assertBreaker();
    const maxRetries = Math.max(0, options.maxRiskRetries ?? this.maxRiskRetries);
    let attempt = 0;

    for (;;) {
      const response = await this.send({
        url,
        method: options.method ?? "GET",
        headers: options.headers,
        body: options.body,
      });
      const status = typeof response.status === "number" ? response.status : 0;
      const json = parseJsonText(response.text);

      if (options.checkAuth === true) this.throwIfUnauthorized(response, json);

      if (isRiskStatus(status)) {
        if (attempt >= maxRetries) {
          this.recordRiskFailure();
          throw new QuarkRiskControlError(`风控拦截（HTTP ${status}），已重试 ${attempt} 次`, {
            status,
            retryAfterMs: this.isBreakerOpen() ? Math.max(0, this.breakerOpenUntil - this.now()) : 0,
            breakerOpen: this.isBreakerOpen(),
          });
        }
        const waitMs = QUARK_BACKOFF_MS[Math.min(attempt, QUARK_BACKOFF_MS.length - 1)] ?? 8000;
        await this.sleep(waitMs);
        attempt += 1;
        continue;
      }

      if (status >= 500) {
        throw new QuarkApiError(`服务端错误（HTTP ${status}）`, { status });
      }

      // 成功：清零风控连击（「连续 5 次」才熔断）
      this.riskStreak = 0;
      return response;
    }
  }

  /**
   * 列一个目录的直系子项（`/file/sort`），默认自动翻页取全量。
   * 只读：不触发任何写接口。
   */
  async listDir(pdirFid: string | number = "0", options: QuarkListOptions = {}): Promise<QuarkListResult> {
    const pageSize = Math.max(1, options.pageSize ?? 100);
    const fetchAll = options.all !== false;
    const sort = options.sort ?? "file_type:asc,updated_at:desc";
    const parentFid = String(pdirFid);
    const items: QuarkDirItem[] = [];
    let total = 0;
    let page = 1;
    let pages = 0;

    for (;;) {
      const url = buildDriveUrl(QUARK_SORT_PATH, {
        pdir_fid: parentFid,
        _page: page,
        _size: pageSize,
        _sort: sort,
        _fetch_total: 1,
      });
      const response = await this.requestRaw(url, { checkAuth: true });
      const json = parseJsonText(response.text);
      if (!json) throw new QuarkApiError("file/sort 返回非 JSON", { status: response.status });
      const code = numberOr(json.code, -1);
      if (code !== 0) {
        throw new QuarkApiError(`file/sort 失败：code=${code} ${String(json.message ?? "")}`.trim(), {
          code,
          status: response.status,
        });
      }

      const data = json.data && typeof json.data === "object" ? (json.data as Record<string, unknown>) : {};
      const list = Array.isArray(data.list) ? data.list : [];
      pages += 1;
      for (const raw of list) {
        const item = toDirItem(raw, parentFid);
        if (item) items.push(item);
      }
      if (total === 0) {
        const metadata = data.metadata && typeof data.metadata === "object" ? (data.metadata as Record<string, unknown>) : null;
        const reported = metadata ? numberOr(metadata._total, 0) : 0;
        total = reported;
      }

      const done = !fetchAll || list.length === 0 || (total > 0 && items.length >= total) || page >= 50;
      if (done) break;
      page += 1;
    }

    return { items, total: total > 0 ? total : items.length, pages };
  }

  /** 取某个 fid 的签名下载 URL（`/file/download` 第一跳）。 */
  async resolveDownloadUrl(fid: string): Promise<string> {
    const result = await this.resolveDownloadUrlDetailed(fid);
    return result.url;
  }

  /** 0.2.10：第一跳带 status/code/urlLen 的诊断版本（公开方法行为不变）。 */
  private async resolveDownloadUrlDetailed(
    fid: string
  ): Promise<{ url: string; status: number; code: number }> {
    const url = buildDriveUrl(QUARK_DOWNLOAD_PATH);
    const response = await this.requestRaw(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/plain, */*" },
      body: JSON.stringify({ fids: [fid] }),
      checkAuth: true,
    });
    const json = parseJsonText(response.text);
    if (!json) throw new QuarkApiError("file/download 返回非 JSON", { status: response.status });
    const code = numberOr(json.code, -1);
    if (code !== 0) {
      throw new QuarkApiError(`file/download 失败：code=${code} ${String(json.message ?? "")}`.trim(), {
        code,
        status: response.status,
      });
    }
    const data = json.data;
    const first = Array.isArray(data) && data.length > 0 ? data[0] : null;
    const downloadUrl =
      first && typeof first === "object" && typeof (first as Record<string, unknown>).download_url === "string"
        ? String((first as Record<string, unknown>).download_url)
        : "";
    if (!downloadUrl) throw new QuarkApiError("file/download 未返回 download_url", { code, status: response.status });
    return { url: downloadUrl, status: response.status, code };
  }

  /**
   * 下载文件内容（签名 URL 第二跳，仍带 Cookie 头，因为 CDN 侧也要登录态）。
   *
   * 0.2.4：
   *   - 所有下载走全局并发闸门 `downloadGate`（默认 ≤2）；
   *   - 超时退避 1s 重试 **1 次**，仍失败抛 `QuarkDownloadTimeoutError(retried=true)`；
   *   - `code=23018`（夸克单文件下载上限）映射为 `QuarkFileTooLargeError`，不重试；
   *   - 401 → `authExpired`（清队列 + 暂停 60s + 只回调一次），后续下载直接快速失败。
   *
   * 0.2.5：同一 fid 的并发请求在**发起网络请求之前**按 fid 合并（in-flight 去重）——
   * 连续点同一个文件 10 次只会发 1 次请求；取消只放弃**调用方自己**的等待，
   * 共享的那次下载继续（其它调用方照常拿到结果并写缓存）。
   */
  async downloadFile(
    fid: string,
    options: {
      signal?: GateSignal | null;
      path?: string;
      priority?: "interactive" | "background" | "background-user" | "bulk";
      /** 0.2.26：优先级判定来源（仅 `stage=gate` 日志）。 */
      reason?: string;
    } = {}
  ): Promise<ArrayBuffer> {
    const signal = options.signal ?? null;
    const path = options.path || fid;
    const priority = options.priority ?? "background";
    const reason = options.reason ?? "";
    // 0.2.20 N3：控制位（外层超时时置 aborted → 僵尸请求不再发后续跳/不再重试）
    const control: DownloadControl = { aborted: false };
    // 去重在闸门之前：同一个 fid 全局只有一份“闸门任务 + 网络请求”
    // 0.2.19 SF4：硬超时放在闸门任务内部 —— 超时后闸门槽位与 inflight 表项都会释放
    // 0.2.21 S1/S2：先看有没有可复用的僵尸结果（TTL 内成功结果直接复用，否则最多等 min(ttl,3s)）
    const shared = this.inflight.run(fid, async () => {
      const reused = await this.reuseFidZombie(fid);
      if (reused) return reused;
      return await this.downloadGate.run(() => {
        const underlying = this.downloadWithRetry(fid, signal, path, control);
        // 超时后底层继续跑：登记为僵尸（有 TTL/条数上限），供同 fid 复用或串行等待
        return this.withDownloadTimeout(control, () => underlying, () =>
          this.rememberZombie(fid, underlying)
        );
      }, { path, priority, reason });
    });
    if (!signal) return shared;
    return this.raceCallerCancel(shared, signal);
  }

  /**
   * 0.2.21 S2：复用/等待同一个 fid 的僵尸。
   *
   * - TTL 到期 → 强制清理，返回 null（调用方重新发请求，避免永久毒化）；
   * - 僵尸已成功 → 直接复用它的 buffer（不再发请求）；
   * - 僵尸失败 → 清理，返回 null；
   * - 僵尸仍在跑 → 最多等 `min(zombieTtlMs, zombieWaitMs)`；等不到就清理并自行发起。
   */
  private async reuseFidZombie(fid: string): Promise<ArrayBuffer | null> {
    const record = this.fidZombies.get(fid);
    if (!record) return null;
    if (this.zombieTtlMs > 0 && this.now() - record.startedAt > this.zombieTtlMs) {
      this.fidZombies.delete(fid);
      return null;
    }
    if (record.settled) {
      this.fidZombies.delete(fid);
      return record.error || !record.value ? null : record.value;
    }
    const waitMs = Math.max(0, Math.min(this.zombieTtlMs > 0 ? this.zombieTtlMs : this.zombieWaitMs, this.zombieWaitMs));
    if (waitMs <= 0) {
      this.fidZombies.delete(fid);
      return null;
    }
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        record.promise.then(
          () => undefined,
          () => undefined
        ),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, waitMs);
          const maybeUnref = timer as unknown as { unref?: () => void };
          if (typeof maybeUnref.unref === "function") maybeUnref.unref();
        }),
      ]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
    if (record.settled && !record.error && record.value) {
      this.fidZombies.delete(fid);
      return record.value;
    }
    // 超期/失败：清掉记录，调用方自行发起
    this.fidZombies.delete(fid);
    return null;
  }

  /** 0.2.21 S1：登记一个超时后仍在跑的请求（带 TTL 与条数上限）。 */
  private rememberZombie(fid: string, underlying: Promise<ArrayBuffer>): void {
    const record: FidZombie = { startedAt: this.now(), settled: false, promise: underlying };
    this.fidZombies.set(fid, record);
    this.trimZombies();
    void underlying.then(
      (value) => {
        record.settled = true;
        record.value = value;
      },
      (error) => {
        record.settled = true;
        record.error = error;
      }
    );
  }

  /** 0.2.21 S1：条数上限（32）：超出淘汰最旧的僵尸记录。 */
  private trimZombies(): void {
    while (this.fidZombies.size > this.zombieMax) {
      let oldestFid: string | null = null;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [fid, record] of this.fidZombies) {
        if (record.startedAt < oldestAt) {
          oldestAt = record.startedAt;
          oldestFid = fid;
        }
      }
      if (!oldestFid) return;
      this.fidZombies.delete(oldestFid);
    }
  }

  /**
   * 0.2.19 SF4 / 0.2.20 N3：单次下载硬超时（可配，默认 20s）。
   *
   * 超时后：调用方立即拿到 `QuarkDownloadTimeoutError`；同时把 `control.aborted` 置位，
   * 让仍在跑的底层请求**不再发后续跳、不再退避重试**（否则请求数会在超时后继续增长）。
   */
  private withDownloadTimeout<T>(
    control: DownloadControl,
    run: () => Promise<T>,
    onTimeout?: () => void
  ): Promise<T> {
    const timeoutMs = this.downloadTimeoutMs;
    if (!(timeoutMs > 0)) return run();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        control.aborted = true;
        try {
          onTimeout?.();
        } catch {
          /* 僵尸登记失败不影响超时语义 */
        }
        reject(new QuarkDownloadTimeoutError(`下载超时（>${timeoutMs}ms）`, false));
      }, timeoutMs);
      const maybeUnref = timer as unknown as { unref?: () => void };
      if (typeof maybeUnref.unref === "function") maybeUnref.unref();
      Promise.resolve()
        .then(run)
        .then(
          (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve(value);
          },
          (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
          }
        );
    });
  }

  /** 0.2.19 SF4：进行中的下载数（超时/失败后必须归零；观测与单测用）。 */
  get inflightCount(): number {
    return this.inflight.size;
  }

  /** 进行中的下载 key（fid 列表）。 */
  inflightKeys(): string[] {
    return this.inflight.keys();
  }

  /**
   * 调用方取消：只让**这一个调用方**提前 reject，共享下载不受影响。
   * `requestUrl` 没有 AbortSignal，这里用轻量轮询感知 `signal.aborted`（默认 50ms）。
   */
  private raceCallerCancel<T>(shared: Promise<T>, signal: GateSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(new QuarkDownloadCanceledError());
    return new Promise<T>((resolve, reject) => {
      const timer = setInterval(() => {
        if (!signal.aborted) return;
        clearInterval(timer);
        reject(new QuarkDownloadCanceledError());
      }, 50);
      shared.then(
        (value) => {
          clearInterval(timer);
          resolve(value);
        },
        (error) => {
          clearInterval(timer);
          reject(error);
        }
      );
    });
  }

  private async downloadWithRetry(
    fid: string,
    signal: GateSignal | null = null,
    path: string = fid,
    control: DownloadControl = { aborted: false }
  ): Promise<ArrayBuffer> {
    try {
      return await this.downloadOnce(fid, path, control);
    } catch (error) {
      if (!isDownloadTimeoutError(error)) throw error;
      // 0.2.20 N3：外层已超时 → 不再重试（否则请求数在超时后继续增长）
      if (control.aborted) {
        throw new QuarkDownloadTimeoutError(`下载超时（>${this.downloadTimeoutMs}ms）`, false);
      }
      // 用户已取消：不重试（取消 = 丢弃结果 + 停止后续，不假装能中断已发出的 TCP）
      if (signal && signal.aborted) throw new QuarkDownloadCanceledError();
      // 超时：退避 1 秒后重试 1 次
      await this.sleep(QUARK_DOWNLOAD_RETRY_BACKOFF_MS);
      if (control.aborted) {
        throw new QuarkDownloadTimeoutError(`下载超时（>${this.downloadTimeoutMs}ms）`, false);
      }
      if (signal && signal.aborted) throw new QuarkDownloadCanceledError();
      try {
        return await this.downloadOnce(fid, path, control);
      } catch (second) {
        if (second instanceof QuarkAuthError || second instanceof QuarkFileTooLargeError) throw second;
        if (second instanceof QuarkDownloadCanceledError) throw second;
        if (isDownloadTimeoutError(second)) {
          throw new QuarkDownloadTimeoutError(
            `下载超时（已重试 1 次）：${second instanceof Error ? second.message : String(second)}`,
            true
          );
        }
        throw second;
      }
    }
  }

  /**
   * 单次下载（两跳）；失败统一映射为可诊断的错误类型。
   *
   * 0.2.10：两跳都写 `stage=download` 诊断（hop=1/2、status、code、urlLen、contentType、bytes、firstBytes），
   * 只记元信息，**绝不记录正文**。
   */
  private async downloadOnce(
    fid: string,
    path: string = fid,
    control: DownloadControl = { aborted: false }
  ): Promise<ArrayBuffer> {
    let resolved: { url: string; status: number; code: number };
    try {
      resolved = await this.resolveDownloadUrlDetailed(fid);
    } catch (error) {
      this.logDownload(path, fid, { hop: 1, status: statusOf(error), code: codeOf(error), urlLen: 0 }, errorText(error));
      throw this.mapDownloadError(error);
    }
    this.logDownload(
      path,
      fid,
      { hop: 1, status: resolved.status, code: resolved.code, urlLen: resolved.url.length },
      ""
    );

    // 0.2.20 N3：第一跳与第二跳之间检查 aborted —— 超时后不再发起大文件传输
    if (control.aborted) {
      throw new QuarkDownloadTimeoutError(`下载超时（>${this.downloadTimeoutMs}ms）`, false);
    }

    let response: QuarkHttpResponse;
    try {
      response = await this.requestRaw(resolved.url, {
        headers: { Accept: "*/*" },
        checkAuth: false,
      });
    } catch (error) {
      this.logDownload(path, fid, { hop: 2, status: statusOf(error) }, errorText(error));
      throw this.mapDownloadError(error);
    }

    const buffer =
      response.arrayBuffer && response.arrayBuffer.byteLength > 0
        ? response.arrayBuffer
        : typeof response.text === "string" && response.text
          ? (new TextEncoder().encode(response.text).buffer as ArrayBuffer)
          : new ArrayBuffer(0);
    // 0.2.20 N7：响应体只记长度与不可逆 sha8，不记任何原始字节
    const sha8 = await firstBytesSha8(buffer);
    this.logDownload(
      path,
      fid,
      {
        hop: 2,
        status: response.status,
        contentType: headerValue(response.headers, "content-type"),
        bytes: buffer.byteLength,
        ...(sha8 ? { sha8 } : {}),
      },
      buffer.byteLength === 0 ? "empty-body" : ""
    );
    return buffer;
  }

  /** 闸门事件埋点（0.2.11）：`stage=gate state=… prio=… waitMs=…`。 */
  private logGate(event: {
    state: "queued" | "acquired" | "abandoned";
    priority: "i" | "bg" | "bg-user" | "bulk";
    path: string;
    waitMs: number;
    reason?: string;
  }): void {
    try {
      this.diag?.({
        level: "info",
        stage: "gate",
        path: event.path || "/",
        fid: "-",
        message: "",
        fields: {
          state: event.state,
          prio: event.priority,
          waitMs: event.waitMs,
          ...(event.reason ? { reason: event.reason } : {}),
        },
      });
    } catch {
      /* 日志失败不影响调度 */
    }
  }

  /** 下载埋点（0.2.10）：失败只影响日志，不影响下载结果。 */
  private logDownload(
    path: string,
    fid: string,
    fields: Record<string, string | number | boolean>,
    message: string
  ): void {
    try {
      this.diag?.({ level: "info", stage: "download", path, fid, message, fields });
    } catch {
      /* 日志失败不影响下载 */
    }
  }

  /** 下载错误归一：23018 → 文件过大；401 → 熔断；其它原样。 */
  private mapDownloadError(error: unknown): unknown {
    if (error instanceof QuarkAuthError) {
      this.handleAuthExpired();
      return error;
    }
    if (error instanceof QuarkApiError) {
      if (error.code === QUARK_CODE_FILE_TOO_LARGE || /size limit/i.test(error.message)) {
        return new QuarkFileTooLargeError(
          "夸克拒绝下载该文件（code=23018，可能超过单文件下载上限）",
          { code: error.code }
        );
      }
      return error;
    }
    return error;
  }

  /** 401 熔断：清队列 + 暂停 60s + 同一失效期只回调一次（main.ts 只弹一次 Notice）。 */
  private handleAuthExpired(): void {
    this.downloadGate.failAuth(this.authCooldownMs);
    if (this.authNotified) return;
    this.authNotified = true;
    try {
      this.diag?.({ level: "warn", stage: "auth", path: "/", fid: "-", message: "state=circuit-open" });
    } catch {
      /* 日志失败忽略 */
    }
    try {
      this.onAuthExpired?.();
    } catch {
      /* 回调失败不影响请求处理 */
    }
  }

  /**
   * 第 5 步：`account/info?st=<service_ticket>&lw=scan` 换登录态 Cookie。
   * 真机实测单跳 200、无 302（`认证定案.md` 第 47 行）。`service_ticket` 一次性，调用方负责失败后重拉 token。
   */
  async exchangeServiceTicket(serviceTicket: string, options: { lw?: string } = {}): Promise<QuarkTicketExchange> {
    const ticket = String(serviceTicket ?? "").trim();
    if (!ticket) throw new QuarkAuthError("service_ticket 为空");
    const lw = options.lw ?? "scan";
    const url = `${QUARK_PAN_BASE}/account/info?st=${encodeURIComponent(ticket)}&lw=${encodeURIComponent(lw)}`;
    this.lastSetCookieNames = [];
    const response = await this.requestRaw(url, { checkAuth: false });
    if (response.status >= 400) {
      throw new QuarkAuthError(`换 Cookie 失败：account/info HTTP ${response.status}`, { status: response.status });
    }
    return {
      status: response.status,
      cookieNames: this.lastSetCookieNames.slice(),
      header: this.cookieStore.getHeader(),
    };
  }

  /**
   * 第 6 步验活：`/file/sort?pdir_fid=0` 的 `code === 0` 才算登录成功。
   * 不用「有没有 `__puus`」当判据（登录成功时可能为 false，见 `认证定案.md` 第 35-38 行）。
   */
  async verifyAlive(): Promise<QuarkVerifyResult> {
    const result = await this.listDir("0", { pageSize: 20, all: false });
    return { code: 0, itemCount: result.items.length, cookieNames: this.cookieStore.names() };
  }

  /** 导入一条现成的 Cookie 头（手贴兜底路径，v3 §9.5 备选 A 用得上）。 */
  importCookieHeader(header: string): void {
    this.cookieStore.setHeader(header);
  }

  private assertBreaker(): void {
    if (this.breakerOpenUntil > 0 && this.now() >= this.breakerOpenUntil) {
      // 冷却结束，自动恢复
      this.breakerOpenUntil = 0;
      this.riskStreak = 0;
    }
    if (this.isBreakerOpen()) {
      throw new QuarkRiskControlError("风控熔断中，请稍后再试（或重新扫码）", {
        retryAfterMs: Math.max(0, this.breakerOpenUntil - this.now()),
        breakerOpen: true,
      });
    }
  }

  private recordRiskFailure(): void {
    this.riskStreak += 1;
    if (this.riskStreak >= this.riskStreakThreshold) {
      this.breakerOpenUntil = this.now() + this.breakerCooldownMs;
      this.riskStreak = 0;
    }
  }

  private throwIfUnauthorized(response: QuarkHttpResponse, json: Record<string, unknown> | null): void {
    const status = typeof response.status === "number" ? response.status : 0;
    const code = json && typeof json.code === "number" ? json.code : null;
    const message = json && typeof json.message === "string" ? json.message : "";
    const needLogin = /require\s+login/i.test(message);
    if (status === 401 || code === 31001 || needLogin) {
      // 0.2.4：任何被判定为登录失效的响应都触发一次熔断（清队列 + 暂停 60s + 只提示一次）
      this.handleAuthExpired();
      throw new QuarkAuthError(
        status === 401 ? "登录态失效（HTTP 401），请重新扫码" : `登录态失效（code=${code ?? "?"}${message ? ` ${message}` : ""}），请重新扫码`,
        { status, code }
      );
    }
  }

  /** 唯一出网口：限速 → 注入 Cookie → 发请求 → 合并 set-cookie（并尽力持久化）。 */
  private async send(request: QuarkHttpRequest, retriedAuth = false): Promise<QuarkHttpResponse> {
    await this.limiter.acquire();
    const reqSeq = ++this.reqCounter;

    const headers: Record<string, string> = {
      "User-Agent": this.userAgent,
      Accept: "application/json, text/plain, */*",
      Referer: `${QUARK_PAN_BASE}/`,
      Origin: QUARK_PAN_BASE,
    };
    if (request.body !== undefined && headers["Content-Type"] === undefined) {
      headers["Content-Type"] = "application/json";
    }
    if (request.headers) {
      for (const key of Object.keys(request.headers)) {
        const value = request.headers[key];
        if (typeof value === "string") headers[key] = value;
      }
    }
    const cookie = this.cookieStore.getHeader();
    if (cookie) headers.Cookie = cookie;

    this.requestCount += 1;
    const response = await this.transport({
      url: request.url,
      method: request.method ?? "GET",
      headers,
      body: request.body,
    });

    const applied = this.cookieStore.applySetCookie(response ? response.headers : null, reqSeq);
    this.lastSetCookieNames = applied.names;
    if (applied.names.length > 0) {
      // 响应里有 set-cookie 就回写；持久化失败不影响本次请求
      try {
        await this.cookieStore.save();
      } catch {
        /* CookieStore.save 自己吞异常，这里兜一层防御 */
      }
    }
    // 0.2.17：401 → 先从 secretStorage 重读 cookie，再重试 1 次；仍 401 才熔断
    if (response && response.status === 401 && !retriedAuth) {
      try {
        await this.cookieStore.load();
      } catch {
        /* 读失败按原样重试 */
      }
      return this.send(request, true);
    }
    return response;
  }
}

/** 取响应头（大小写不敏感，数组取第一个）。 */
function headerValue(
  headers: QuarkHttpResponse["headers"],
  name: string
): string {
  if (!headers || typeof headers !== "object") return "";
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers as Record<string, unknown>)) {
    if (key.toLowerCase() !== lower) continue;
    const value = (headers as Record<string, unknown>)[key];
    if (Array.isArray(value)) return value.length > 0 ? String(value[0]) : "";
    if (value === undefined || value === null) return "";
    return String(value);
  }
  return "";
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error ?? "");
  return text.replace(/\s+/g, " ").slice(0, 120);
}

function statusOf(error: unknown): number {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" ? status : 0;
}

function codeOf(error: unknown): number {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "number" ? code : -1;
}
/** 供调用方核对「响应是否带 set-cookie」（诊断用，不含 cookie 值）。 */
export function countSetCookieHeaders(headers: QuarkHttpResponse["headers"]): number {
  return collectSetCookieValues(headers as Record<string, unknown> | null | undefined).length;
}
