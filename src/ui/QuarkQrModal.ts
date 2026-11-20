/**
 * QuarkQrModal —— 手机端扫码登录弹窗（canvas 画二维码）。
 *
 * 依据：
 *   - 真机已验证的渲染路径（qrcode-generator → canvas 逐 module 绘制 → 显示）：不依赖远程图片、
 *     不把 URL 塞进超长 data URL；
 *   - 二维码内容是 QuarkQrAuth 的完整 5 参数 URL（只带 token 的短 URL 会被夸克判「登录请求已过期」）；
 *   - 界面只显示状态/倒计时/进度与 cookie **名称个数**，绝不出现 cookie 值（v3 §7.2）。
 *
 * 纯函数（`formatCountdown` / `describeQrState` / `describeProgress`）导出以便单测。
 */

import * as obsidianRuntime from "obsidian";
import type { App } from "obsidian";

import type { QuarkQrAuth, QuarkQrLoginResult, QuarkQrProgress } from "../auth/QuarkQrAuth";
import { QUARK_QR_TTL_CLIENT_MS, QUARK_QR_TTL_SERVER_MS } from "../auth/QuarkQrAuth";
import { createQrCode } from "../vendor/qr";
import { formatBuiltAt } from "./QuarkSettingsTab";
import type { QuarkUiSnapshot } from "./QuarkSettingsTab";

/** 库根展示文案（确认框/提示共用）。 */
export function describeRootLabel(rootPath: string | null | undefined): string {
  const path = String(rootPath ?? "");
  return path && path !== "/" ? path : "根目录（整个网盘）";
}

/** 确认框三选一结果（T-11）。 */
export type QuarkSyncChoice = "sync" | "change-root" | "cancel";
/** 三个按钮的顺序（供界面与单测共用）。 */
export const QUARK_SYNC_CHOICES: QuarkSyncChoice[] = ["sync", "change-root", "cancel"];

/**
 * 已登录时点 ribbon 的确认框正文（三行，T-11 A3）：
 *   库根：/知识库_云端
 *   上次同步：2026-11-20 15:40 · 索引 128 条
 *   将执行：全量刷新索引
 */
export function describeSyncPrompt(snapshot: QuarkUiSnapshot): string {
  const count = snapshot.indexCount > 0 ? `${snapshot.indexCount} 条` : "无";
  const progress =
    snapshot.indexing && snapshot.scannedFolders + snapshot.pendingFolders > 0
      ? `（同步中：${snapshot.scannedFolders}/${snapshot.scannedFolders + snapshot.pendingFolders} 目录）`
      : "";
  return [
    `库根：${describeRootLabel(snapshot.rootPath)}`,
    `上次同步：${formatBuiltAt(snapshot.builtAt)} · 索引 ${count}${progress}`,
    `将执行：全量刷新索引`,
  ].join("\n");
}

/** 倒计时文案：`剩余 179 秒（服务端实测 184 秒，提前 4 秒停）`；≤30 秒加提醒。 */
export function formatCountdown(remainingMs: number, ttlMs: number = QUARK_QR_TTL_CLIENT_MS): string {
  const left = Math.max(0, Math.ceil(remainingMs / 1000));
  const total = Math.round(ttlMs / 1000);
  const warn = left <= 30 ? "（即将过期）" : "";
  return `剩余 ${left} 秒${warn}（客户端上限 ${total} 秒；服务端实测 ${Math.round(
    QUARK_QR_TTL_SERVER_MS / 1000
  )} 秒）`;
}

/** 状态文案映射：把 QuarkQrAuth 的状态机翻译成给人看的一句话。 */
export function describeQrState(state: QuarkQrLoginResult["state"]): string {
  switch (state) {
    case "preparing":
      return "正在建立会话并申请二维码…";
    case "waiting":
      return "等待扫码：请截图，用夸克 App 识别二维码并确认";
    case "success":
      return "登录成功";
    case "expired":
      return "二维码已过期，请点「重新生成」";
    case "failed":
      return "扫码登录失败，可重试";
    case "canceled":
      return "已在夸克端取消";
    case "timeout":
      return "已到客户端超时上限，请重新生成二维码";
    default:
      return state;
  }
}

/** 进度文案：只含阶段与计数，不含任何凭据。 */
export function describeProgress(progress: QuarkQrProgress): string {
  const parts = [`[${progress.phase}]`];
  if (typeof progress.status === "number") parts.push(`status=${progress.status}`);
  if (typeof progress.attempt === "number") parts.push(`第 ${progress.attempt} 次`);
  if (typeof progress.remainingMs === "number") parts.push(formatCountdown(progress.remainingMs));
  if (Array.isArray(progress.cookieNames) && progress.cookieNames.length > 0) {
    parts.push(`收到 ${progress.cookieNames.length} 条 cookie`);
  }
  parts.push(progress.message);
  return parts.join(" ");
}

export interface QuarkQrModalOptions {
  app: App;
  /** 由 main.ts 提供：每次「重新生成」都新建一个 auth（service_ticket 一次性）。 */
  createAuth: (onProgress: (progress: QuarkQrProgress) => void) => QuarkQrAuth;
  /** 流程结束（成功/失败/过期都回调）。 */
  onDone?: (result: QuarkQrLoginResult) => void | Promise<void>;
}

interface ModalLike {
  app: App;
  contentEl: HTMLElement;
  open(): void;
  close(): void;
  onOpen(): void;
  onClose(): void;
}
type ModalCtor = new (app: App) => ModalLike;

/**
 * 取运行期的 `Modal` 基类。
 *
 * 走命名空间访问而不是命名导入，是为了在没有 UI 运行时的环境（单测里 `obsidian` 被最小 mock）
 * 也能加载本模块——拿不到真实 `Modal` 时退回一个同形状的桩类，纯函数照常可测。
 */
function modalBase(): ModalCtor {
  const runtime = obsidianRuntime as unknown as { Modal?: ModalCtor };
  if (runtime.Modal) return runtime.Modal;
  class StubModal implements ModalLike {
    app: App;
    contentEl: HTMLElement;
    constructor(app: App) {
      this.app = app;
      this.contentEl = {} as HTMLElement;
    }
    open(): void {}
    close(): void {}
    onOpen(): void {}
    onClose(): void {}
  }
  return StubModal;
}

export class QuarkQrModal extends modalBase() {
  private readonly options: QuarkQrModalOptions;
  private auth: QuarkQrAuth | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private statusEl: HTMLElement | null = null;
  private countdownEl: HTMLElement | null = null;
  private timelineEl: HTMLPreElement | null = null;
  private timelineToggleEl: HTMLButtonElement | null = null;
  private timeline: string[] = [];
  private countdownTimer: number | null = null;
  private startedAt = 0;
  private closed = false;

  constructor(options: QuarkQrModalOptions) {
    super(options.app);
    this.options = options;
  }

  onOpen(): void {
    const content = this.contentEl;
    content.empty();
    content.createEl("h3", { text: "Quark：扫码登录" });

    this.statusEl = content.createEl("div", { text: describeQrState("preparing") });
    this.canvas = content.createEl("canvas");
    this.canvas.style.width = "260px";
    this.canvas.style.height = "260px";
    this.canvas.style.background = "#fff";
    this.countdownEl = content.createEl("div", { text: "" });

    const actions = content.createEl("div");
    const regen = actions.createEl("button", { text: "重新生成" });
    regen.addEventListener("click", () => {
      void this.startFlow();
    });

    this.timelineToggleEl = actions.createEl("button", { text: "显示时间线" });
    this.timelineEl = content.createEl("pre");
    this.timelineEl.style.display = "none";
    this.timelineEl.style.whiteSpace = "pre-wrap";
    this.timelineEl.style.fontSize = "12px";
    this.timelineEl.style.maxHeight = "180px";
    this.timelineEl.style.overflow = "auto";
    this.timelineToggleEl.addEventListener("click", () => this.toggleTimeline());

    void this.startFlow();
  }

  onClose(): void {
    this.closed = true;
    this.stopCountdown();
    this.auth?.cancel();
    this.auth = null;
    this.contentEl.empty();
  }

  private toggleTimeline(): void {
    if (!this.timelineEl || !this.timelineToggleEl) return;
    const show = this.timelineEl.style.display === "none";
    this.timelineEl.style.display = show ? "block" : "none";
    this.timelineToggleEl.setText(show ? "隐藏时间线" : "显示时间线");
    if (show) this.renderTimeline();
  }

  private pushTimeline(line: string): void {
    this.timeline.push(line);
    if (this.timeline.length > 200) this.timeline.shift();
    if (this.timelineEl && this.timelineEl.style.display !== "none") this.renderTimeline();
  }

  private renderTimeline(): void {
    if (!this.timelineEl) return;
    this.timelineEl.setText(this.timeline.join("\n"));
  }

  private setStatus(text: string): void {
    if (this.statusEl) this.statusEl.setText(text);
  }

  /** 一次完整流程：start（步 1-3）→ waitForLogin（步 4-6）。 */
  private async startFlow(): Promise<void> {
    this.stopCountdown();
    this.timeline = [];
    this.timeline.push(`+0s | 开始新一轮扫码`);
    this.renderTimeline();
    this.setStatus(describeQrState("preparing"));

    const auth = this.options.createAuth((progress) => {
      this.pushTimeline(describeProgress(progress));
    });
    this.auth = auth;
    this.startedAt = Date.now();

    let started: QuarkQrLoginResult;
    try {
      started = await auth.start();
    } catch (error) {
      this.setStatus(`获取二维码异常：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (this.closed) return;
    this.pushTimeline(`qr | ${started.state} | ${started.message}`);

    if (started.state !== "waiting" || !started.qrContent) {
      this.setStatus(`${describeQrState(started.state)}：${started.message}`);
      this.options.onDone?.(started);
      return;
    }

    this.drawQr(started.qrContent);
    this.setStatus(describeQrState("waiting"));
    this.startCountdown();

    const done = await auth.waitForLogin();
    if (this.closed) return;
    this.stopCountdown();
    this.setStatus(`${describeQrState(done.state)}：${done.message}`);
    this.pushTimeline(`done | ${done.state} | poll=${done.pollCount}`);
    // A7：登录成功立刻关窗，同步在后台继续（不要求用户手动关）
    if (done.state === "success") this.close();
    await this.options.onDone?.(done);
  }

  /** 逐 module 画到 canvas（真机验证过的路径）。 */
  private drawQr(payload: string): void {
    const canvas = this.canvas;
    if (!canvas) return;
    const qr = createQrCode(0, "M");
    qr.addData(payload);
    qr.make();
    const count = qr.getModuleCount();
    const scale = 6;
    const margin = 4 * scale;
    const size = count * scale + margin * 2;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, size, size);
    ctx.fillStyle = "#000000";
    for (let row = 0; row < count; row += 1) {
      for (let col = 0; col < count; col += 1) {
        if (qr.isDark(row, col)) {
          ctx.fillRect(margin + col * scale, margin + row * scale, scale, scale);
        }
      }
    }
  }

  private startCountdown(): void {
    this.stopCountdown();
    const tick = (): void => {
      if (!this.countdownEl) return;
      const left = QUARK_QR_TTL_CLIENT_MS - (Date.now() - this.startedAt);
      this.countdownEl.setText(formatCountdown(left));
      this.countdownEl.style.color = left <= 30000 ? "#d14343" : "";
    };
    tick();
    this.countdownTimer = window.setInterval(tick, 1000);
  }

  private stopCountdown(): void {
    if (this.countdownTimer !== null) {
      window.clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
  }
}

export interface QuarkSyncConfirmOptions {
  app: App;
  /** 正文（库根 + 上次同步 + 将执行），由 `describeSyncPrompt` 生成。 */
  body: string;
  onChoose: (choice: QuarkSyncChoice) => void;
}

/**
 * 已登录时点 ribbon 的确认框（A4）：两个按钮「现在同步」/「取消」，
 * 默认焦点在「取消」上（不让回车直接触发同步）。
 */
export class QuarkSyncConfirmModal extends modalBase() {
  private readonly options: QuarkSyncConfirmOptions;
  private settled = false;

  constructor(options: QuarkSyncConfirmOptions) {
    super(options.app);
    this.options = options;
  }

  onOpen(): void {
    const content = this.contentEl;
    content.empty();
    content.createEl("h3", { text: "现在同步夸克索引？" });
    content.createEl("p", { text: this.options.body });

    const actions = content.createEl("div");
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.choose("cancel"));
    const changeRoot = actions.createEl("button", { text: "修改库根" });
    changeRoot.addEventListener("click", () => this.choose("change-root"));
    const confirm = actions.createEl("button", { text: "现在同步" });
    confirm.addEventListener("click", () => this.choose("sync"));
    // 默认焦点放在「取消」上（不让回车直接触发同步）
    window.setTimeout(() => cancel.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.settled) {
      this.settled = true;
      this.options.onChoose("cancel");
    }
  }

  private choose(choice: QuarkSyncChoice): void {
    if (this.settled) return;
    this.settled = true;
    this.options.onChoose(choice);
    this.close();
  }
}
