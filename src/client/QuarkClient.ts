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
}

export interface TokenBucketOptions {
  ratePerSecond?: number;
  burst?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
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

  /** 取一个令牌；返回本次实际等待的毫秒数（0 = 未受限）。 */
  async acquire(): Promise<number> {
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
    this.limiter =
      options.limiter ??
      new TokenBucket({
        ratePerSecond: options.ratePerSecond ?? QUARK_DEFAULT_RATE,
        now: this.now,
        sleep: this.sleep,
      });
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
    return downloadUrl;
  }

  /** 下载文件内容（签名 URL 第二跳，仍带 Cookie 头，因为 CDN 侧也要登录态）。 */
  async downloadFile(fid: string): Promise<ArrayBuffer> {
    const downloadUrl = await this.resolveDownloadUrl(fid);
    const response = await this.requestRaw(downloadUrl, {
      headers: { Accept: "*/*" },
      checkAuth: false,
    });
    if (response.arrayBuffer && response.arrayBuffer.byteLength > 0) return response.arrayBuffer;
    if (typeof response.text === "string" && response.text) {
      const bytes = new TextEncoder().encode(response.text);
      return bytes.buffer as ArrayBuffer;
    }
    return new ArrayBuffer(0);
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
      throw new QuarkAuthError(
        status === 401 ? "登录态失效（HTTP 401），请重新扫码" : `登录态失效（code=${code ?? "?"}${message ? ` ${message}` : ""}），请重新扫码`,
        { status, code }
      );
    }
  }

  /** 唯一出网口：限速 → 注入 Cookie → 发请求 → 合并 set-cookie（并尽力持久化）。 */
  private async send(request: QuarkHttpRequest): Promise<QuarkHttpResponse> {
    await this.limiter.acquire();

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

    const applied = this.cookieStore.applySetCookie(response ? response.headers : null);
    this.lastSetCookieNames = applied.names;
    if (applied.names.length > 0) {
      // 响应里有 set-cookie 就回写；持久化失败不影响本次请求
      try {
        await this.cookieStore.save();
      } catch {
        /* CookieStore.save 自己吞异常，这里兜一层防御 */
      }
    }
    return response;
  }
}

/** 供调用方核对「响应是否带 set-cookie」（诊断用，不含 cookie 值）。 */
export function countSetCookieHeaders(headers: QuarkHttpResponse["headers"]): number {
  return collectSetCookieValues(headers as Record<string, unknown> | null | undefined).length;
}
