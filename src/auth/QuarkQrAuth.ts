/**
 * QuarkQrAuth —— 手机端扫码登录（六步，纯逻辑，已按真机结果定序）。
 *
 * 真机定案（`认证定案.md`，唯一事实来源）：
 *   步 1 建 CAS 会话   GET uop.quark.cn/cas/custom/login?custom_login_type=mobile&client_id=532&display=pc
 *                     → 收 `_UP_*`（尤其 `_UP_F7E_8D_`）；失败不中断，只记一条日志
 *   步 2 取 token      GET uop.quark.cn/cas/ajax/getTokenForQrcodeLogin?client_id=532&v=1.2&request_id=<uuid>
 *   步 3 出二维码内容  5 参数完整 URL，`uc_biz_str` 必须 percent-encode（`%7C/%40/%3A`）
 *   步 4 轮询 ticket   每 2 秒 `getServiceTicketByQrcodeToken?token=<token>`，按 5 个状态码分支
 *   步 5 换 Cookie     `pan.quark.cn/account/info?st=<ticket>&lw=scan`（单跳 200，无 302）
 *   步 6 验活          `drive-pc.quark.cn/1/clouddrive/file/sort?pdir_fid=0` 的 `code===0`
 *
 * 硬约束：
 *   - `service_ticket` 一次性：换 Cookie 失败必须回步 2 重拉 token；
 *   - token 实测 184 秒，客户端上限 180 秒，到点主动停轮询；
 *   - 切后台会挂起轮询：监听 `visibilitychange`，回前台**立即补一次轮询并重置 2 秒计时**；
 *   - `__puus` 登录成功时可能为 false（后续请求才下发），不作为失败判据。
 *
 * 本文件不发网络请求：所有请求经 `QuarkClient.requestRaw`（契约 clarify 第 5 条）。
 */

import type { QuarkClient, QuarkHttpResponse } from "../client/QuarkClient";

/** 应用 client_id（真机实测 532）。 */
export const QUARK_CLIENT_ID = "532";

/** 步 1：建 CAS 会话。 */
export const QUARK_CAS_LOGIN_URL =
  "https://uop.quark.cn/cas/custom/login?custom_login_type=mobile&client_id=532&display=pc";
/** 步 2：取二维码 token（后缀拼 request_id）。 */
export const QUARK_TOKEN_URL = "https://uop.quark.cn/cas/ajax/getTokenForQrcodeLogin?client_id=532&v=1.2&request_id=";
/** 步 4：轮询 service_ticket（后缀拼 token）。 */
export const QUARK_TICKET_URL = "https://uop.quark.cn/cas/ajax/getServiceTicketByQrcodeToken?token=";
/** 步 4 回退形态（官方地址形态，带 client_id 与 v）。 */
export const QUARK_TICKET_URL_OFFICIAL = "https://uop.quark.cn/cas/ajax/getServiceTicketByQrcodeToken?client_id=532&v=1.2";

/** 步 3：二维码前缀（夸克扫码跳转页）。 */
export const QUARK_QR_PREFIX = "https://su.quark.cn/4_eMHBJ?token=";
/** 步 3：`uc_biz_str` 原值（未编码）。 */
export const QUARK_QR_BIZ_STR = "S:custom|OPT:SAREA@0|OPT:IMMERSIVE@1|OPT:BACK_BTN_STYLE@0";
/**
 * 步 3：完整 5 参数后缀。
 * 只带 token 的 66 字符短 URL 会被夸克判「登录请求已过期」——缺会话绑定参数。
 */
export const QUARK_QR_SUFFIX =
  "&client_id=532&ssb=weblogin&uc_param_str=&uc_biz_str=" + encodeURIComponent(QUARK_QR_BIZ_STR);

/** token 服务端实测有效期（毫秒，仅用于展示）。 */
export const QUARK_QR_TTL_SERVER_MS = 184000;
/** 客户端上限（毫秒）：提前 4 秒主动停，避免「插件还在等、夸克已过期」。 */
export const QUARK_QR_TTL_CLIENT_MS = 180000;
/** 轮询间隔（毫秒）。 */
export const QUARK_QR_POLL_INTERVAL_MS = 2000;
/** CAS 状态码。 */
export const QUARK_QR_STATUS = {
  SUCCESS: 2000000,
  WAITING: 50004001,
  EXPIRED: 50004002,
  FAILED: 50004003,
  CANCELED: 50004004,
} as const;

/** 登录流程状态机。 */
export type QuarkQrState =
  | "idle"
  | "preparing"
  | "waiting"
  | "exchanging"
  | "verifying"
  | "success"
  | "expired"
  | "failed"
  | "canceled"
  | "timeout";

/** 流程阶段（进度回调用）。 */
export type QuarkQrPhase = "cas" | "token" | "qr" | "poll" | "exchange" | "verify" | "done";

export interface QuarkQrLoginResult {
  state: QuarkQrState;
  ok: boolean;
  message: string;
  token?: string;
  qrContent?: string;
  /** CAS 业务状态码（`status` 字段）。 */
  status?: number;
  /** 换 Cookie 时响应下发的 Cookie 名（不含值，可安全落日志）。 */
  cookieNames?: string[];
  /** 验活 `/file/sort?pdir_fid=0` 返回的条目数。 */
  itemCount?: number;
  elapsedMs: number;
  pollCount: number;
}

export interface QuarkQrProgress {
  state: QuarkQrState;
  phase: QuarkQrPhase;
  message: string;
  status?: number;
  remainingMs?: number;
  attempt?: number;
  qrContent?: string;
  cookieNames?: string[];
}

/** 最小 DOM 依赖：只要求 visibilityState 与 visibilitychange 监听。 */
export interface VisibilityTarget {
  visibilityState?: string;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

export interface QuarkQrAuthOptions {
  client: QuarkClient;
  /** 轮询间隔，默认 2000 毫秒。 */
  pollIntervalMs?: number;
  /** 客户端上限，默认 180000 毫秒。 */
  ttlMs?: number;
  now?: () => number;
  /** 计时器注入（单测用假计时器）。 */
  setTimeoutFn?: (callback: () => void, ms: number) => unknown;
  clearTimeoutFn?: (handle: unknown) => void;
  /** 进度回调：UI 用它渲染状态与倒计时。 */
  onProgress?: (progress: QuarkQrProgress) => void;
  /** 二维码内容就绪回调：UI 用它编码并显示二维码。 */
  onQr?: (content: string, token: string) => void;
  /** request_id 生成器（默认 crypto.randomUUID，回退 32 位十六进制）。 */
  requestId?: () => string;
}

/** 步 3：拼出完整 5 参数二维码内容。 */
export function buildQrContent(token: string): string {
  return `${QUARK_QR_PREFIX}${token}${QUARK_QR_SUFFIX}`;
}

/** 生成 request_id（crypto.randomUUID 优先，避免引入依赖）。 */
export function createRequestId(): string {
  try {
    const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (cryptoObj && typeof cryptoObj.randomUUID === "function") return cryptoObj.randomUUID();
  } catch {
    /* 回退到伪随机 */
  }
  let out = "";
  for (let i = 0; i < 32; i += 1) {
    out += "0123456789abcdef".charAt(Math.floor(Math.random() * 16));
  }
  return out;
}

function parseJsonObject(text: string | undefined | null): Record<string, unknown> | null {
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

function stringOr(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return String(error);
}

/** 从 CAS 响应里读 service_ticket（真机响应结构：`data.members.service_ticket`）。 */
export function readServiceTicket(json: Record<string, unknown>): string {
  const data = json.data && typeof json.data === "object" ? (json.data as Record<string, unknown>) : {};
  const members = data.members && typeof data.members === "object" ? (data.members as Record<string, unknown>) : {};
  const candidates = [members.service_ticket, data.service_ticket, members.ticket, data.ticket];
  for (const candidate of candidates) {
    const text = stringOr(candidate);
    if (text) return text;
  }
  return "";
}

/** 从 token 响应里读 token（真机响应结构：`data.members.token`）。 */
export function readQrToken(json: Record<string, unknown>): string {
  const data = json.data && typeof json.data === "object" ? (json.data as Record<string, unknown>) : {};
  const members = data.members && typeof data.members === "object" ? (data.members as Record<string, unknown>) : {};
  const candidates = [members.token, data.token];
  for (const candidate of candidates) {
    const text = stringOr(candidate);
    if (text) return text;
  }
  return "";
}

/**
 * 扫码登录流程。
 *
 * 用法（UI 层）：
 * ```ts
 * const auth = new QuarkQrAuth({ client, onQr: (content) => renderQr(content) });
 * auth.attachVisibility();               // 回前台立即补一次轮询
 * const started = await auth.start();    // 步 1-3
 * if (started.state === "waiting") {
 *   const done = await auth.waitForLogin(); // 步 4-6
 * }
 * ```
 */
export class QuarkQrAuth {
  private readonly client: QuarkClient;
  private readonly pollIntervalMs: number;
  private readonly ttlMs: number;
  private readonly now: () => number;
  private readonly setTimer: (callback: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;
  private readonly onProgress?: (progress: QuarkQrProgress) => void;
  private readonly onQr?: (content: string, token: string) => void;
  private readonly requestIdFn: () => string;

  private phase: QuarkQrState = "idle";
  private token: string | null = null;
  private qrContentValue: string | null = null;
  private startedAt = 0;
  private pollCountValue = 0;
  private canceled = false;
  private running = false;
  private kicked = false;
  private waitTimer: unknown = null;
  private waitResolve: (() => void) | null = null;
  private visibilityHandler: (() => void) | null = null;
  private visibilityTarget: VisibilityTarget | null = null;

  constructor(options: QuarkQrAuthOptions) {
    if (!options || !options.client) {
      throw new Error("QuarkQrAuth 需要一个 QuarkClient");
    }
    this.client = options.client;
    this.pollIntervalMs = Math.max(0, options.pollIntervalMs ?? QUARK_QR_POLL_INTERVAL_MS);
    this.ttlMs = Math.max(0, options.ttlMs ?? QUARK_QR_TTL_CLIENT_MS);
    this.now = options.now ?? ((): number => Date.now());
    this.setTimer = options.setTimeoutFn ?? ((callback, ms) => setTimeout(callback, ms));
    this.clearTimer =
      options.clearTimeoutFn ??
      ((handle) => {
        clearTimeout(handle as ReturnType<typeof setTimeout>);
      });
    this.onProgress = options.onProgress;
    this.onQr = options.onQr;
    this.requestIdFn = options.requestId ?? createRequestId;
  }

  get state(): QuarkQrState {
    return this.phase;
  }

  get qrContent(): string | null {
    return this.qrContentValue;
  }

  get tokenValue(): string | null {
    return this.token;
  }

  get pollCount(): number {
    return this.pollCountValue;
  }

  /** 步 1-3：建 CAS 会话 → 取 token → 出二维码内容。 */
  async start(): Promise<QuarkQrLoginResult> {
    this.reset();
    this.setPhase("preparing");

    // 步 1：建 CAS 会话。失败不中断（真机：失败只记日志，后续步骤仍可能成功）
    this.emit("cas", "建立 CAS 会话…");
    try {
      await this.client.requestRaw(QUARK_CAS_LOGIN_URL, { checkAuth: false });
    } catch (error) {
      this.emit("cas", `建立 CAS 会话失败（继续后续步骤）：${errorMessage(error)}`);
    }

    // 步 2：取 token（带上步 1 的会话 cookie，QuarkClient 自动注入）
    this.emit("token", "获取二维码 token…");
    const requestId = this.requestIdFn();
    let response: QuarkHttpResponse;
    try {
      response = await this.client.requestRaw(QUARK_TOKEN_URL + encodeURIComponent(requestId), { checkAuth: false });
    } catch (error) {
      this.setPhase("failed");
      return this.result("failed", `获取二维码 token 异常：${errorMessage(error)}`);
    }

    const json = parseJsonObject(response.text) ?? {};
    const status = numberOr(json.status, -1);
    const token = readQrToken(json);
    if (status !== QUARK_QR_STATUS.SUCCESS || !token) {
      this.setPhase("failed");
      return this.result(
        "failed",
        `获取二维码失败：status=${status}${stringOr(json.message) ? `（${stringOr(json.message)}）` : ""}`,
        { status }
      );
    }

    this.token = token;
    this.qrContentValue = buildQrContent(token);
    this.startedAt = this.now();
    this.setPhase("waiting");

    // 步 3：出二维码内容（完整 5 参数 + percent-encode）
    this.emit("qr", "二维码已生成，请用夸克 App 扫码", { qrContent: this.qrContentValue });
    if (this.onQr) this.onQr(this.qrContentValue, token);

    return this.result("waiting", "等待扫码/确认…", {
      status: QUARK_QR_STATUS.SUCCESS,
      token,
      qrContent: this.qrContentValue ?? undefined,
    });
  }

  /** 步 4：轮询一次。拿到 ticket 时顺带做步 5-6。 */
  async pollOnce(): Promise<QuarkQrLoginResult> {
    if (!this.token) {
      this.setPhase("failed");
      return this.result("failed", "尚未生成二维码 token，请先调用 start()");
    }
    if (this.canceled) {
      this.setPhase("canceled");
      return this.result("canceled", "已取消扫码登录");
    }

    const remaining = this.ttlMs - (this.now() - this.startedAt);
    if (remaining <= 0) {
      this.setPhase("timeout");
      this.kick();
      return this.result(
        "timeout",
        `已到客户端上限 ${Math.round(this.ttlMs / 1000)} 秒（服务端实测 ${Math.round(
          QUARK_QR_TTL_SERVER_MS / 1000
        )} 秒），请重新生成二维码`
      );
    }

    this.pollCountValue += 1;
    this.emit("poll", "轮询 service_ticket…", { attempt: this.pollCountValue, remainingMs: remaining });

    let json: Record<string, unknown> = {};
    try {
      const response = await this.client.requestRaw(QUARK_TICKET_URL + encodeURIComponent(this.token), {
        checkAuth: false,
      });
      json = parseJsonObject(response.text) ?? {};
    } catch (error) {
      // 单次轮询失败不终止流程（切后台/偶发网络抖动都会导致一次失败）
      this.emit("poll", `轮询异常（继续等待）：${errorMessage(error)}`, { attempt: this.pollCountValue });
      return this.result("waiting", "轮询异常，继续等待…", { status: -1 });
    }

    const status = numberOr(json.status, -1);
    const message = stringOr(json.message);

    // 五个状态码逐个分支
    switch (status) {
      case QUARK_QR_STATUS.SUCCESS:
        return await this.complete(json, status, message);
      case QUARK_QR_STATUS.WAITING:
        this.emit("poll", "等待扫码/确认…", { status, remainingMs: remaining, attempt: this.pollCountValue });
        return this.result("waiting", "等待扫码/确认…", { status, token: this.token });
      case QUARK_QR_STATUS.EXPIRED:
        this.setPhase("expired");
        this.kick();
        return this.result(
          "expired",
          `二维码已过期（50004002，服务端实测 ${Math.round(QUARK_QR_TTL_SERVER_MS / 1000)} 秒）${message ? `：${message}` : ""}，请重新生成`,
          { status }
        );
      case QUARK_QR_STATUS.FAILED:
        this.setPhase("failed");
        this.kick();
        return this.result("failed", `扫码登录失败（50004003）${message ? `：${message}` : ""}`, { status });
      case QUARK_QR_STATUS.CANCELED:
        this.setPhase("canceled");
        this.kick();
        return this.result("canceled", `已在夸克端取消（50004004）${message ? `：${message}` : ""}`, { status });
      default:
        this.emit("poll", `未知状态 ${status}，继续等待…`, { status, remainingMs: remaining });
        return this.result("waiting", `未知状态 ${status}，继续等待…`, { status });
    }
  }

  /**
   * 步 4-6：按 2 秒间隔轮询，累计到 180 秒停止。
   * 被 {@link kick}（如 `visibilitychange` 回前台）打断时立即补一次轮询并重置计时。
   */
  async waitForLogin(): Promise<QuarkQrLoginResult> {
    if (this.running) return this.result("failed", "已有轮询正在进行中");
    if (!this.token) {
      this.setPhase("failed");
      return this.result("failed", "尚未生成二维码 token，请先调用 start()");
    }

    this.running = true;
    try {
      for (;;) {
        if (this.canceled) {
          this.setPhase("canceled");
          return this.result("canceled", "已取消扫码登录");
        }
        const remaining = this.ttlMs - (this.now() - this.startedAt);
        if (remaining <= 0) {
          this.setPhase("timeout");
          return this.result(
            "timeout",
            `已到客户端上限 ${Math.round(this.ttlMs / 1000)} 秒（服务端实测 ${Math.round(
              QUARK_QR_TTL_SERVER_MS / 1000
            )} 秒），请重新生成二维码`
          );
        }

        const tick = await this.pollOnce();
        if (tick.state !== "waiting") return tick;

        await this.waitForTick(Math.min(this.pollIntervalMs, remaining));
      }
    } finally {
      this.running = false;
      this.clearWait();
    }
  }

  /** 一键流程：`start()` + `waitForLogin()`。 */
  async login(): Promise<QuarkQrLoginResult> {
    const started = await this.start();
    if (started.state !== "waiting") return started;
    return await this.waitForLogin();
  }

  /** 取消：立即结束轮询，回到未登录态。 */
  cancel(): void {
    this.canceled = true;
    this.kick();
  }

  /**
   * 处理前后台切换：回前台立即补一次轮询并重置 2 秒计时（真机时间线：切回夸克后 +0s 就拿到 ticket）。
   */
  handleVisibilityChange(visibility: string): void {
    if (visibility === "hidden") {
      this.emit("poll", "已切到后台，轮询暂停（回前台会立即补一次）");
      return;
    }
    if (visibility !== "visible") return;
    if (!this.token || this.phase !== "waiting") return;
    this.emit("poll", "回到前台，立即补一次轮询");
    this.kick();
  }

  /** 绑定 `document.visibilitychange`；返回解绑函数。 */
  attachVisibility(target?: VisibilityTarget | null): () => void {
    const resolved = target ?? (typeof document === "undefined" ? null : (document as unknown as VisibilityTarget));
    if (!resolved) return () => undefined;
    this.detachVisibility();
    const handler = (): void => {
      const state = typeof resolved.visibilityState === "string" ? resolved.visibilityState : "visible";
      this.handleVisibilityChange(state);
    };
    resolved.addEventListener("visibilitychange", handler);
    this.visibilityHandler = handler;
    this.visibilityTarget = resolved;
    return () => this.detachVisibility();
  }

  detachVisibility(): void {
    if (this.visibilityTarget && this.visibilityHandler) {
      this.visibilityTarget.removeEventListener("visibilitychange", this.visibilityHandler);
    }
    this.visibilityTarget = null;
    this.visibilityHandler = null;
  }

  /** 打断当前等待（回前台补轮询、取消、状态终结时用）。 */
  kick(): boolean {
    if (this.waitResolve) {
      const resolve = this.waitResolve;
      this.waitResolve = null;
      this.clearWaitTimer();
      resolve();
      return true;
    }
    // 不在等待中（例如正卡在一次网络请求里）：标记一次，让下一轮不等满 2 秒
    this.kicked = true;
    return false;
  }

  /** 步 5-6：换 Cookie + 验活。 */
  private async complete(
    json: Record<string, unknown>,
    status: number,
    message: string
  ): Promise<QuarkQrLoginResult> {
    const ticket = readServiceTicket(json);
    if (!ticket) {
      this.setPhase("failed");
      return this.result("failed", "已返回成功（2000000）但未找到 service_ticket 字段，响应结构可能已变化", {
        status,
      });
    }

    // 步 5：换 Cookie（service_ticket 一次性）
    this.setPhase("exchanging");
    this.emit("exchange", "已拿到 service_ticket，正在换 Cookie…", { status });
    let exchange;
    try {
      exchange = await this.client.exchangeServiceTicket(ticket);
    } catch (error) {
      this.setPhase("failed");
      return this.result("failed", `换 Cookie 失败：${errorMessage(error)}（请重新生成二维码，ticket 一次性）`, {
        status,
      });
    }
    const cookieNames = exchange.cookieNames.slice();
    if (cookieNames.length === 0) {
      this.setPhase("failed");
      return this.result("failed", "换 Cookie 失败：account/info 响应没有 set-cookie", { status });
    }
    // 注意：不检查 __puus。登录成功时可能为 false，判据只看下一步 code===0
    this.emit("exchange", `换 Cookie 成功，收到 ${cookieNames.length} 条`, { status, cookieNames });

    // 步 6：验活
    this.setPhase("verifying");
    this.emit("verify", "验活：GET /file/sort?pdir_fid=0 …", { cookieNames });
    let verified;
    try {
      verified = await this.client.verifyAlive();
    } catch (error) {
      this.setPhase("failed");
      return this.result("failed", `验活失败：${errorMessage(error)}`, { status, cookieNames });
    }

    this.setPhase("success");
    const finalResult = this.result(
      "success",
      `登录成功：验活 code=${verified.code}，根目录条目数=${verified.itemCount}`,
      { status, token: this.token ?? undefined, cookieNames, itemCount: verified.itemCount }
    );
    this.emit("done", finalResult.message, { status, cookieNames });
    return finalResult;
  }

  private async waitForTick(ms: number): Promise<void> {
    if (this.kicked) {
      this.kicked = false;
      return;
    }
    await new Promise<void>((resolve) => {
      this.waitResolve = (): void => {
        this.waitResolve = null;
        resolve();
      };
      this.waitTimer = this.setTimer(() => {
        this.waitTimer = null;
        this.waitResolve = null;
        resolve();
      }, Math.max(0, ms));
    });
  }

  private clearWaitTimer(): void {
    if (this.waitTimer !== null) {
      const handle = this.waitTimer;
      this.waitTimer = null;
      try {
        this.clearTimer(handle);
      } catch {
        /* 计时器清理失败无需上抛 */
      }
    }
  }

  private clearWait(): void {
    this.clearWaitTimer();
    this.waitResolve = null;
    this.kicked = false;
  }

  private reset(): void {
    this.clearWait();
    this.phase = "idle";
    this.token = null;
    this.qrContentValue = null;
    this.startedAt = 0;
    this.pollCountValue = 0;
    this.canceled = false;
    this.kicked = false;
  }

  private setPhase(state: QuarkQrState): void {
    this.phase = state;
  }

  private elapsedMs(): number {
    return this.startedAt > 0 ? Math.max(0, this.now() - this.startedAt) : 0;
  }

  private result(state: QuarkQrState, message: string, extra: Partial<QuarkQrLoginResult> = {}): QuarkQrLoginResult {
    return {
      state,
      ok: state === "success",
      message,
      elapsedMs: this.elapsedMs(),
      pollCount: this.pollCountValue,
      ...extra,
    };
  }

  private emit(
    phase: QuarkQrPhase,
    message: string,
    extra: Partial<Omit<QuarkQrProgress, "state" | "phase" | "message">> = {}
  ): void {
    if (!this.onProgress) return;
    const progress: QuarkQrProgress = {
      state: this.phase,
      phase,
      message,
      ...extra,
    };
    try {
      this.onProgress(progress);
    } catch {
      /* 回调异常不得影响登录流程 */
    }
  }
}
