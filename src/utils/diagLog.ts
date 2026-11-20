/**
 * diagLog —— 夸克只读库的诊断日志（0.2.3）。
 *
 * 目的：真机「打开文件失败」时能回答「读的是哪个 path、映射到哪个 fid、失败在哪一步」。
 * 硬约束：
 *   - **只**记录 path / fid / 阶段 / 错误消息前 200 字符；绝不写 cookie 值，也不写笔记正文；
 *   - 写入走注入的 DataAdapter（`.obsidian/**` 已由 base adapter 转发），不引 fs / path / node:；
 *   - 环形上限 200 KB：超限保留尾部（从整行边界开始），不无限增长；
 *   - 追加是串行队列：并发的失败不会互相覆盖，单次写失败不影响后续。
 *
 * 纯函数（`formatDiagLine` / `truncateDiagLog` / `tailDiagLines` / `redactDiagMessage`）导出以便单测。
 */

/** 允许出现在日志里的阶段名（`download` = client 下载失败）。 */
export type DiagStage = "read" | "readBinary" | "getResourcePath" | "download" | "list" | "sort" | "index" | "write";

/** 日志文件（库内路径，走 Obsidian adapter 写）。 */
export const DIAG_LOG_PATH = ".obsidian/plugins/drive-view/quark-debug.log";
/** 环形上限：200 KB。 */
export const DIAG_LOG_MAX_BYTES = 200 * 1024;
/** 单条错误消息上限：200 字符。 */
export const DIAG_MSG_MAX = 200;
/** 「导出诊断」最多带走的行数。 */
export const DIAG_TAIL_LINES = 200;

/** 失败原因分类（0.2.4 A7）。 */
export type DiagCause = "timeout" | "size" | "auth" | "http" | "canceled" | "readonly" | "unknown";

export interface DiagEntry {
  stage: DiagStage;
  /** 库内路径（根目录用 `/`）。 */
  path: string;
  /** 条目 fid；索引里查不到时为 `-`。 */
  fid?: string;
  /** 原始错误消息（会被截断与脱敏）。 */
  message: string;
  level?: "error" | "warn" | "info";
  /** 失败原因分类；写进日志的 `cause=` 字段。 */
  cause?: DiagCause;
  /** 是否重试过（超时重试 1 次后仍失败为 true）。 */
  retried?: boolean;
}

/**
 * 脱敏：把 cookie / 鉴权类 `key=value` 的 value 抹成 `***`。
 * 只处理日志文本，不影响任何请求或 cookie 存储。
 */
export function redactDiagMessage(message: string): string {
  return String(message ?? "").replace(
    /\b(__pus|__kps|__puus|__puuid|__kp|__uid|cookie|authorization|token)\s*=\s*([^;&\s,]+)/gi,
    (_match, key: string) => `${key}=***`
  );
}

/** 一行日志：`[ISO] level=error stage=<...> path=<路径> fid=<fid> msg=<前200字符>`。 */
export function formatDiagLine(entry: DiagEntry, now: Date = new Date()): string {
  const level = entry.level ?? "error";
  const path = entry.path && entry.path !== "" ? entry.path : "/";
  const fid = entry.fid && entry.fid !== "" ? entry.fid : "-";
  const msg = redactDiagMessage(entry.message).replace(/\s+/g, " ").trim().slice(0, DIAG_MSG_MAX);
  const cause = entry.cause ? ` cause=${entry.cause}` : "";
  const retried = entry.retried === true ? " retried=true" : "";
  return `[${now.toISOString()}] level=${level} stage=${entry.stage} path=${path} fid=${fid}${cause}${retried} msg=${msg}`;
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * 环形截断（A6）：超过 `maxBytes` 时只保留尾部，且从整行边界开始，避免半行。
 * 用 UTF-8 字节数而不是字符数，保证写进文件的体积真的不超上限。
 */
export function truncateDiagLog(text: string, maxBytes: number = DIAG_LOG_MAX_BYTES): string {
  const source = String(text ?? "");
  const limit = maxBytes > 0 ? maxBytes : DIAG_LOG_MAX_BYTES;
  if (utf8Length(source) <= limit) return source;

  const chars = Array.from(source);
  let bytes = 0;
  let start = chars.length;
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const size = utf8Length(chars[i]);
    if (bytes + size > limit) break;
    bytes += size;
    start = i;
  }
  let tail = chars.slice(start).join("");
  const newline = tail.indexOf("\n");
  if (newline >= 0) tail = tail.slice(newline + 1);
  return tail;
}

/** 最近 `maxLines` 行（导出诊断用，A7）。 */
export function tailDiagLines(text: string, maxLines: number = DIAG_TAIL_LINES): string {
  const lines = String(text ?? "").split("\n");
  while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
  const limit = maxLines > 0 ? maxLines : DIAG_TAIL_LINES;
  return lines.slice(-limit).join("\n");
}

/** 日志落盘所需的最小 adapter 接口（`DataAdapter` 结构上满足）。 */
export interface DiagAdapterLike {
  exists?(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, data: string): Promise<void>;
}

export interface DiagLoggerOptions {
  adapter: DiagAdapterLike;
  /** 日志文件路径，默认 `DIAG_LOG_PATH`。 */
  path?: string;
  /** 环形上限，默认 200 KB。 */
  maxBytes?: number;
  /** 时间源（单测固定时间用），默认 `() => new Date()`。 */
  now?: () => Date;
  /** 写失败时的回调（默认吞掉：诊断日志绝不影响主流程）。 */
  onError?: (error: unknown) => void;
}

/**
 * 追加式诊断日志器：`log()` 是同步的（只入队），实际读写异步串行执行。
 * 读失败当作「空日志」继续写；写失败只回调 `onError`，不抛给调用方。
 */
export class DiagLogger {
  private readonly adapter: DiagAdapterLike;
  private readonly path: string;
  private readonly maxBytes: number;
  private readonly now: () => Date;
  private readonly onError?: (error: unknown) => void;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: DiagLoggerOptions) {
    this.adapter = options.adapter;
    this.path = options.path ?? DIAG_LOG_PATH;
    this.maxBytes = options.maxBytes ?? DIAG_LOG_MAX_BYTES;
    this.now = options.now ?? (() => new Date());
    this.onError = options.onError;
  }

  /** 记录一条错误（同步返回，不阻塞调用方）。 */
  log(entry: DiagEntry): void {
    const line = formatDiagLine(entry, this.now());
    this.queue = this.queue
      .then(() => this.append(line))
      .catch((error) => {
        this.onError?.(error);
      });
  }

  /** 等待队列清空（测试/卸载时用）。 */
  async flush(): Promise<void> {
    await this.queue;
  }

  private async append(line: string): Promise<void> {
    let current = "";
    try {
      if (!this.adapter.exists || (await this.adapter.exists(this.path))) {
        current = await this.adapter.read(this.path);
      }
    } catch {
      current = ""; // 文件不存在/读失败：从空日志开始
    }
    const next = truncateDiagLog(`${current}${line}\n`, this.maxBytes);
    await this.adapter.write(this.path, next);
  }
}
