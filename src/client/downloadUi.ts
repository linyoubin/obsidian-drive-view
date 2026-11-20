/**
 * downloadUi —— 下载中的「正在下载 … [取消]」单例提示（0.2.4 A4′）。
 *
 * 用户原话：「文件还没打开时转圈等待，可以点击取消，取消就不下载了。」
 *
 * 约束：
 *   - **同一时间只保留一条**下载提示：新的下载更新同一条文案并带 `(1/3)` 这类计数，不刷屏；
 *   - 取消 = 丢弃结果 + 停止后续：`requestUrl` 没有 AbortSignal，
 *     **无法中断已发出的 HTTP 连接**，只能让结果被丢弃、不再重试、不写缓存；
 *   - 提示的创建与「取消」按钮的挂载由注入的 host 完成，纯逻辑可单测（不碰真实 DOM）。
 */

export type DownloadEndOutcome = "done" | "failed" | "canceled";

/** 一次下载的取消令牌（`aborted=true` 后该结果应被丢弃）。 */
export interface DownloadToken {
  readonly id?: string;
  aborted: boolean;
}

/** 提示对象的最小接口（Obsidian `Notice` 结构上满足）。 */
export interface DownloadNoticeLike {
  setMessage?(message: string): void;
  noticeEl?: unknown;
  hide?(): void;
}

export interface DownloadNoticeHost {
  /** 建一条常驻提示（`new Notice(message, 0)`）。 */
  create(message: string): DownloadNoticeLike;
  /** 在提示里追加可点击的「取消」元素（真实 DOM 由调用方实现）。 */
  attachCancel(notice: DownloadNoticeLike, onCancel: () => void): void;
}

export interface DownloadNoticeBookOptions {
  /** 提醒阈值（字节）；`<= 0` 表示不提醒。默认 50 MB。 */
  thresholdBytes?: () => number;
}

export interface DownloadBeginInfo {
  /** 库内路径（取文件名用）。 */
  path: string;
  fid: string;
  /** 文件大小（未知为 0）。 */
  sizeBytes: number;
}

/** 字节数 → `12.3 MB` / `640 KB` / `900 B`。 */
export function formatDownloadSize(bytes: number): string {
  const value = Number.isFinite(bytes) && bytes > 0 ? bytes : 0;
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** 文件名（取路径最后一段）。 */
export function downloadFileName(path: string): string {
  const clean = String(path ?? "");
  const index = clean.lastIndexOf("/");
  return index >= 0 ? clean.slice(index + 1) : clean || "（未知文件）";
}

/**
 * 下载提示文案：`正在下载 notes.pdf（12.3 MB）… (1/2)``；
 * 超过提醒阈值（>0）时追加 `· 超过 50 MB 提醒阈值`（**只提醒，不拦截**）。
 */
export function describeDownloadNotice(options: {
  fileName: string;
  sizeBytes: number;
  active: number;
  /** 本次下载在队列里的序号（1 起）；`active > 1` 时显示 `(1/2)`。 */
  position?: number;
  thresholdBytes?: number;
}): string {
  const size = formatDownloadSize(options.sizeBytes);
  const position = options.position ?? options.active;
  const count = options.active > 1 ? ` (${position}/${options.active})` : "";
  const threshold = options.thresholdBytes ?? 0;
  const hint =
    threshold > 0 && options.sizeBytes > threshold
      ? ` · 超过 ${formatDownloadSize(threshold)} 提醒阈值`
      : "";
  return `正在下载 ${options.fileName}（${size}）…${count}${hint}`.trim();
}

/**
 * 单例下载提示簿：管理「正在下载」提示与取消令牌。
 *
 * 取消语义（务必别误解）：`requestUrl` 无 AbortSignal，这里只能标记 `aborted`
 * 让调用方**丢弃结果、不再重试、不写缓存**；已发出的 HTTP 请求仍会跑完。
 */
export class DownloadNoticeBook {
  private readonly host: DownloadNoticeHost;
  private readonly thresholdBytes: () => number;
  private notice: DownloadNoticeLike | null = null;
  private cancelAttached = false;
  private readonly active = new Map<DownloadToken, DownloadBeginInfo>();
  private sequence = 0;

  constructor(host: DownloadNoticeHost, options: DownloadNoticeBookOptions = {}) {
    this.host = host;
    this.thresholdBytes = options.thresholdBytes ?? ((): number => 0);
  }

  /** 正在下载的文件数（含排队）。 */
  get activeCount(): number {
    return this.active.size;
  }

  /** 当前提示文案（无提示时为 `""`）。 */
  get text(): string {
    return this.noticeText;
  }

  private noticeText = "";

  /** 开始一个下载：复用同一条提示，更新文案与计数，返回取消令牌。 */
  begin(info: DownloadBeginInfo): DownloadToken {
    const token: DownloadToken = { id: `dl-${++this.sequence}`, aborted: false };
    this.active.set(token, info);
    this.noticeText = describeDownloadNotice({
      fileName: downloadFileName(info.path),
      sizeBytes: info.sizeBytes,
      active: this.active.size,
      position: this.active.size,
      thresholdBytes: this.thresholdBytes(),
    });
    if (!this.notice) {
      this.notice = this.host.create(this.noticeText);
    } else if (typeof this.notice.setMessage === "function") {
      this.notice.setMessage(this.noticeText);
    }
    void token;
    if (!this.cancelAttached) {
      this.cancelAttached = true;
      this.host.attachCancel(this.notice, () => this.cancelAll());
    }
    return token;
  }

  /** 结束一个下载；全部结束则隐藏提示。 */
  end(token: DownloadToken | null, outcome: DownloadEndOutcome = "done"): void {
    if (token) this.active.delete(token);
    if (this.active.size > 0) {
      const last = Array.from(this.active.values()).pop();
      if (last) {
        this.noticeText = describeDownloadNotice({
          fileName: downloadFileName(last.path),
          sizeBytes: last.sizeBytes,
          active: this.active.size,
          position: this.active.size,
          thresholdBytes: this.thresholdBytes(),
        });
        if (this.notice && typeof this.notice.setMessage === "function") {
          this.notice.setMessage(this.noticeText);
        }
      }
      return;
    }
    if (outcome === "canceled") this.noticeText = "已取消下载";
    this.hide();
  }

  /** 取消当前所有下载（同一时刻最多 2 个并发）：标记 `aborted`，提示换成「已取消下载」。 */
  cancelAll(): void {
    for (const token of this.active.keys()) token.aborted = true;
    this.noticeText = "已取消下载";
    if (this.notice && typeof this.notice.setMessage === "function") {
      this.notice.setMessage(this.noticeText);
    }
  }

  /** 插件卸载/重置时隐藏并清空。 */
  reset(): void {
    for (const token of this.active.keys()) token.aborted = true;
    this.active.clear();
    this.hide();
  }

  private hide(): void {
    if (this.notice && typeof this.notice.hide === "function") this.notice.hide();
    this.notice = null;
    this.cancelAttached = false;
    this.noticeText = "";
  }
}
