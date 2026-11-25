/**
 * CookieStore —— 夸克登录态 Cookie 的自管层（纯逻辑，无平台依赖）。
 *
 * 背景（`认证定案.md` 第 3 条 / v3 §7.2）：
 *   Obsidian 桌面端 Electron 默认 `BlockAllCookies`，既不发送也不存储 cookie；手机端同样
 *   没有可用的 cookie jar。因此这里手动维护一条 `k=v; k2=v2` 的 Cookie 字符串：
 *     1. 每个请求由 QuarkClient 注入 `Cookie` 头；
 *     2. 响应的 `set-cookie`（可能是数组，也可能是被合并成的逗号串）解析后按 name 合并回写；
 *     3. 登录态变动时持久化（运行期检测 `secretStorage`，不可用回退插件 `saveData`）。
 *
 * 本文件不 import `obsidian` / `node:` / `fs` / `path` / `electron`，持久化后端由调用方注入，
 * 因此所有导出函数都能直接单测。
 */

/**
 * 平台可能把多条 `set-cookie` 合并成一行 `", "` 分隔的字符串。
 * 只有「逗号后紧跟 `name=`」才允许切分，否则会把 `Expires=Wed, 21 Oct 2015 ...` 里的逗号切坏。
 */
export const SET_COOKIE_SPLIT_RE = /,\s*(?=[A-Za-z_][\w-]*=)/;

/** 默认持久化键名。 */
export const DEFAULT_COOKIE_STORAGE_KEY = "quark-auth-cookie";

/** 0.2.15：固定、合规的 secretStorage id（小写字母/数字/短横线，≤64）。 */
export const QUARK_SECRET_ID = "quark-cookie";

/**
 * 把任意字符串清洗成 Obsidian `secretStorage` 允许的 id：
 * 小写、非法字符（`:` `/` 空格 中文 大写等）→ `-`、合并连续 `-`、去首尾 `-`、截断 64；空则回退 `quark-cookie`。
 */
export function sanitizeSecretId(raw: string): string {
  const cleaned = String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return cleaned || QUARK_SECRET_ID;
}

/** 响应头容器：值可能是单串、数组，也可能缺失。 */
export type HeaderBag = Record<string, string | string[] | null | undefined>;

/** 运行期检测出来的 Obsidian 密钥存储（1.11.4+ 的 `app.secretStorage`）。 */
export interface CookieStorageLike {
  setSecret(id: string, value: string): Promise<void> | void;
  getSecret(id: string): Promise<string | null> | string | null;
}

export interface CookieStoreOptions {
  /** Obsidian `App`（或任何带 `secretStorage` 的对象）；运行期检测，存在才用。 */
  app?: unknown;
  /** 回退持久化：插件 `saveData`。 */
  saveData?: (data: Record<string, unknown>) => Promise<void>;
  /** 回退持久化：插件 `loadData`。 */
  loadData?: () => Promise<Record<string, unknown> | null | undefined>;
  /** 持久化键名，默认 {@link DEFAULT_COOKIE_STORAGE_KEY}。 */
  storageKey?: string;
  /** 0.2.15：secretStorage 使用的 id（会被 sanitize；默认 quark-cookie）。 */
  secretId?: string;
  /** 初始 Cookie（`k=v; k2=v2` 字符串或 `k=v` 数组）。 */
  pairs?: string[] | string;
  /** 持久化失败回调（静默降级为纯内存，不抛给调用方）。 */
  onPersistError?: (error: unknown) => void;
  /** 0.2.17：cookie merge 日志（seq + name + 8 位 hash，绝不记录明文）。 */
  onCookieMerge?: (event: { seq: number; name: string; hash: string }) => void;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** 是否为 `set-cookie` 系响应的头名（大小写不敏感，含 `set-cookie2`）。 */
export function isSetCookieHeaderName(name: string): boolean {
  return typeof name === "string" && name.toLowerCase().indexOf("set-cookie") === 0;
}

/**
 * 把一个 `set-cookie` 头值拆成多条。
 * 支持数组形态（真机实测形态）与逗号合并串。
 */
export function splitSetCookieValue(value: string | string[] | null | undefined): string[] {
  if (value == null) return [];
  if (isStringArray(value)) {
    const out: string[] = [];
    for (const item of value) out.push(...splitSetCookieValue(item));
    return out;
  }
  const text = String(value).trim();
  if (!text) return [];
  const parts = text.split(SET_COOKIE_SPLIT_RE);
  const out: string[] = [];
  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed) out.push(trimmed);
  }
  return out;
}

/**
 * 从响应头里收集全部 `set-cookie` 值，已拆分为单条。
 * 头名大小写不敏感；数组与逗号串都能正确展开。
 */
export function collectSetCookieValues(headers: HeaderBag | Record<string, unknown> | null | undefined): string[] {
  if (!headers || typeof headers !== "object") return [];
  const bag = headers as Record<string, unknown>;
  const out: string[] = [];
  for (const key of Object.keys(bag)) {
    if (!isSetCookieHeaderName(key)) continue;
    const value = bag[key];
    if (Array.isArray(value)) {
      for (const item of value) out.push(...splitSetCookieValue(String(item)));
    } else if (typeof value === "string") {
      out.push(...splitSetCookieValue(value));
    }
  }
  return out;
}

/**
 * 取一条 `set-cookie` 的 `name=value` 部分（丢掉 `Path` / `Domain` / `Expires` 等属性）。
 * 非法条目返回空串。
 */
export function cookiePairOf(raw: string): string {
  const first = String(raw == null ? "" : raw).split(";")[0] ?? "";
  const pair = first.trim();
  const eq = pair.indexOf("=");
  return eq > 0 ? pair : "";
}

/** 取 `name=value` 的 name；非法条目返回空串。 */
export function cookieNameOf(pair: string): string {
  const text = String(pair == null ? "" : pair);
  const eq = text.indexOf("=");
  return eq > 0 ? text.slice(0, eq).trim() : "";
}

/** 把一组 `set-cookie` 原文转成 `name=value` 数组（丢弃非法条目）。 */
export function setCookiePairsOf(raws: string[]): string[] {
  const out: string[] = [];
  for (const raw of raws) {
    const pair = cookiePairOf(raw);
    if (pair) out.push(pair);
  }
  return out;
}

/** 一条 `set-cookie` 的解析结果（只取本仓库需要的字段）。 */
export interface ParsedSetCookie {
  raw: string;
  /** `name=value` 部分（已剥离属性）；非法条目为空串。 */
  pair: string;
  name: string;
  value: string;
  /** 删除型：`Max-Age<=0` 或 `Expires` 已过期。 */
  deleted: boolean;
  maxAge: number | null;
  expiresAt: number | null;
}

/**
 * 解析一条 `set-cookie` 原文（属性部分只关心 `Max-Age` 与 `Expires`）。
 *
 * 删除语义（服务端注销 cookie 的标准做法）：`Max-Age<=0`，或 `Expires` 早于当前时间，
 * 都表示「删掉这个 name」。真机未观察到，但 `session` cookie 失效时会出现（保守实现）。
 */
export function parseSetCookie(raw: string, now: number = Date.now()): ParsedSetCookie {
  const text = String(raw == null ? "" : raw).trim();
  if (!text) {
    return { raw: "", pair: "", name: "", value: "", deleted: false, maxAge: null, expiresAt: null };
  }
  const pair = cookiePairOf(text);
  const name = cookieNameOf(pair);
  const value = pair ? pair.slice(pair.indexOf("=") + 1) : "";
  let maxAge: number | null = null;
  let expiresAt: number | null = null;

  const chunks = text.split(";");
  for (let i = 1; i < chunks.length; i += 1) {
    const attribute = chunks[i].trim();
    if (!attribute) continue;
    const eq = attribute.indexOf("=");
    const key = (eq >= 0 ? attribute.slice(0, eq) : attribute).trim().toLowerCase();
    const attrValue = eq >= 0 ? attribute.slice(eq + 1).trim() : "";
    if (key === "max-age") {
      const parsed = Number(attrValue);
      if (Number.isFinite(parsed)) maxAge = parsed;
    } else if (key === "expires") {
      const parsed = Date.parse(attrValue);
      if (Number.isFinite(parsed)) expiresAt = parsed;
    }
  }

  const deleted = name !== "" && ((maxAge !== null && maxAge <= 0) || (expiresAt !== null && expiresAt <= now));
  return { raw: text, pair, name, value, deleted, maxAge, expiresAt };
}

/** 该条 `set-cookie` 是否表示删除（`Max-Age<=0` 或 `Expires` 已过期）。 */
export function isSetCookieDeletion(raw: string, now: number = Date.now()): boolean {
  return parseSetCookie(raw, now).deleted;
}

/**
 * 把一批 `set-cookie` 原文应用到 Cookie 集合：删除型移除同 name 项，其余按 name 覆盖合并。
 *
 * @returns `applied` = 本次写入的 name；`removed` = 本次删除的 name
 */
export function mergeSetCookies(
  pairs: string[],
  raws: string[],
  now: number = Date.now()
): { pairs: string[]; applied: string[]; removed: string[] } {
  const live: string[] = [];
  const applied: string[] = [];
  const removed: string[] = [];

  for (const raw of raws) {
    const parsed = parseSetCookie(raw, now);
    if (!parsed.name) continue;
    if (parsed.deleted) {
      if (removed.indexOf(parsed.name) < 0) removed.push(parsed.name);
      continue;
    }
    live.push(parsed.pair);
    if (applied.indexOf(parsed.name) < 0) applied.push(parsed.name);
  }

  let next = mergeCookiePairs(pairs, live);
  if (removed.length > 0) {
    next = next.filter((pair) => {
      const name = cookieNameOf(pair);
      return name !== "" && removed.indexOf(name) < 0;
    });
  }
  return { pairs: next, applied, removed };
}

/** 解析一条 Cookie 头字符串（允许带 `Cookie:` 前缀）。 */
export function parseCookieHeader(header: string | null | undefined): string[] {
  if (header == null) return [];
  let text = String(header).trim();
  if (!text) return [];
  text = text.replace(/^cookie:\s*/i, "");
  const out: string[] = [];
  for (const chunk of text.split(";")) {
    const pair = chunk.trim();
    if (!pair) continue;
    const eq = pair.indexOf("=");
    if (eq > 0) out.push(pair);
  }
  return out;
}

/**
 * 按 name 合并：后来的覆盖先来的，未提及的保留；同 name 只留一条，并保持首次出现的位置。
 * 这就是「Cookie 合并回写」的核心语义。
 */
export function mergeCookiePairs(base: string[], add: string[]): string[] {
  const out: string[] = [];
  const indexByName = new Map<string, number>();
  const put = (raw: string): void => {
    // 统一剥离 `Path` / `Domain` 等属性：Cookie 请求头里只能出现 name=value
    const pair = cookiePairOf(raw);
    const name = cookieNameOf(pair);
    if (!name) return;
    const at = indexByName.get(name);
    if (at === undefined) {
      indexByName.set(name, out.length);
      out.push(pair);
    } else {
      out[at] = pair;
    }
  };
  for (const pair of base) put(pair);
  for (const pair of add) put(pair);
  return out;
}

/** 序列化为可放进请求头的 `k=v; k2=v2`。 */
export function serializeCookiePairs(pairs: string[]): string {
  const parts: string[] = [];
  for (const pair of pairs) {
    const normalized = String(pair == null ? "" : pair).trim();
    if (!normalized) continue;
    if (normalized.indexOf("=") <= 0) continue;
    parts.push(normalized);
  }
  return parts.join("; ");
}

/** 运行期检测 `secretStorage`：必须同时具备 `setSecret` 与 `getSecret` 才认。 */
export function resolveSecretStorage(host: unknown): CookieStorageLike | null {
  if (!host || typeof host !== "object") return null;
  const candidate = (host as { secretStorage?: unknown }).secretStorage;
  if (!candidate || typeof candidate !== "object") return null;
  const store = candidate as Partial<CookieStorageLike>;
  if (typeof store.setSecret !== "function" || typeof store.getSecret !== "function") return null;
  return candidate as CookieStorageLike;
}

/**
 * 内存 + 持久化的 Cookie 容器。
 *
 * 持久化优先级（v3 §9.4 Q7）：`secretStorage` 运行期存在才用 → 否则插件 `saveData` → 都没有则纯内存。
 */
export class CookieStore {
  private pairs: string[] = [];
  private readonly app: unknown;
  private readonly saveData?: (data: Record<string, unknown>) => Promise<void>;
  private readonly loadData?: () => Promise<Record<string, unknown> | null | undefined>;
  private readonly storageKey: string;
  private readonly secretId: string;
  private readonly onPersistError?: (error: unknown) => void;
  private readonly onCookieMerge?: (event: { seq: number; name: string; hash: string }) => void;
  /** 0.2.17：cookie 合并单调序号（防乱序覆盖）。 */
  private mergeSeq = 0;
  private readonly seqByName = new Map<string, number>();
  /** 0.2.15：secretStorage 失败一次后本会话永久降级（不重试、不重复打日志）。 */
  private secretDisabled = false;

  constructor(options: CookieStoreOptions = {}) {
    this.app = options.app;
    this.saveData = options.saveData;
    this.loadData = options.loadData;
    this.storageKey = options.storageKey ?? DEFAULT_COOKIE_STORAGE_KEY;
    this.secretId = sanitizeSecretId(options.secretId ?? QUARK_SECRET_ID);
    this.onPersistError = options.onPersistError;
    this.onCookieMerge = options.onCookieMerge;
    if (options.pairs !== undefined) this.setPairs(options.pairs);
  }

  /** 当前生效的持久化后端（每次实时检测，便于运行期变化与单测）。 */
  get storageMode(): "secret" | "data" | "none" {
    // 0.2.15：只允许 secretStorage，不存在回退「文件」通道
    if (!this.secretDisabled && resolveSecretStorage(this.app)) return "secret";
    return "none";
  }

  /** 已持有的 Cookie 条数。 */
  get size(): number {
    return this.pairs.length;
  }

  /** 是否为空（未登录的判定之一，不能作为唯一判据）。 */
  get isEmpty(): boolean {
    return this.pairs.length === 0;
  }

  /** 当前全部 Cookie 名（顺序稳定）。 */
  names(): string[] {
    const out: string[] = [];
    for (const pair of this.pairs) {
      const name = cookieNameOf(pair);
      if (name) out.push(name);
    }
    return out;
  }

  has(name: string): boolean {
    return this.names().indexOf(name) >= 0;
  }

  get(name: string): string | null {
    for (const pair of this.pairs) {
      if (cookieNameOf(pair) === name) {
        return pair.slice(pair.indexOf("=") + 1);
      }
    }
    return null;
  }

  /** 整体替换（支持 `k=v; k2=v2` 字符串或 `k=v` 数组）。 */
  setPairs(pairs: string[] | string): void {
    const next = Array.isArray(pairs) ? pairs : parseCookieHeader(pairs);
    this.pairs = mergeCookiePairs([], next);
  }

  /** 整体替换为一条 Cookie 头字符串（用于手贴/导入登录态）。 */
  setHeader(header: string | null | undefined): void {
    this.pairs = mergeCookiePairs([], parseCookieHeader(header));
  }

  /** 当前 Cookie 头字符串；空则返回 `""`（调用方不应发送空 Cookie 头）。 */
  getHeader(): string {
    return serializeCookiePairs(this.pairs);
  }

  /** 是否持有登录态判据 `__pus`（`__puus` 登录成功时可能为 false，不能当判据）。 */
  hasLoginCookie(): boolean {
    const pus = this.get("__pus");
    return pus !== null && pus !== "" && pus !== "false";
  }

  /**
   * 合并一个响应的 `set-cookie` 并回写。
   *
   * 删除型条目（`Max-Age<=0` / `Expires` 已过期）会从集合里移除同 name 项。
   *
   * @returns `names` = 本次写入的 name（用于日志与「换 Cookie 是否成功」判定）、
   *          `removed` = 本次删除的 name
   */
  applySetCookie(
    headers: HeaderBag | Record<string, unknown> | null | undefined,
    reqSeq?: number,
    now: number = Date.now()
  ): { names: string[]; header: string; total: number; removed: string[] } {
    this.mergeSeq += 1;
    const seq = typeof reqSeq === "number" && Number.isFinite(reqSeq) ? reqSeq : this.mergeSeq;
    // 0.2.17：__puus 只接受「发起序号不小于已合并序号」的值（晚到的旧响应丢弃）
    const raws = collectSetCookieValues(headers).filter((raw) => {
      const match = /^\s*([^=;\s]+)=/.exec(raw);
      const name = match ? match[1] : "";
      if (name !== "__puus") return true;
      return seq >= (this.seqByName.get("__puus") ?? -1);
    });
    const result = mergeSetCookies(this.pairs, raws, now);
    this.pairs = result.pairs;
    for (const name of result.applied) {
      this.seqByName.set(name, Math.max(seq, this.seqByName.get(name) ?? -1));
      if (name === "__puus") {
        const pair = this.pairs.find((item) => item.startsWith("__puus=")) ?? "";
        this.onCookieMerge?.({ seq, name, hash: hash8(pair.slice("__puus=".length)) });
      }
    }
    return { names: result.applied, header: this.getHeader(), total: this.pairs.length, removed: result.removed };
  }

  clear(): void {
    this.pairs = [];
  }

  /** 序列化为持久化格式 `k=v; k2=v2`。 */
  toJSON(): string {
    return this.getHeader();
  }

  /** 0.2.15：只从 secretStorage 读；不可用返回 false（不降级、不读明文）。 */
  async load(): Promise<boolean> {
    const secret = resolveSecretStorage(this.app);
    if (this.secretDisabled || !secret) return false;
    try {
      const raw = await secret.getSecret(this.secretId);
      return this.restore(typeof raw === "string" ? raw : "");
    } catch (error) {
      this.disableSecret(error);
      return false;
    }
  }

  /** 0.2.15：只允许 secretStorage；失败返回 false（不降级、不写明文）。 */
  async save(): Promise<boolean> {
    const header = this.getHeader();
    const secret = resolveSecretStorage(this.app);
    if (this.secretDisabled || !secret) {
      this.disableSecret(new Error("secretStorage 不可用"));
      return false;
    }
    try {
      await secret.setSecret(this.secretId, header);
      return true;
    } catch (error) {
      this.disableSecret(error);
      return false;
    }
  }
  /** secretStorage 是否已降级（设置页显示「文件（降级）」）。 */
  get secretFallback(): boolean {
    return this.secretDisabled;
  }

  /** 0.2.15：secretStorage 是否可用（不可用 = 登录入口禁用）。 */
  get secretAvailable(): boolean {
    return !this.secretDisabled && resolveSecretStorage(this.app) !== null;
  }

  private disableSecret(error: unknown): void {
    if (this.secretDisabled) return;
    this.secretDisabled = true;
    this.warnPersistError(error);
  }

  private restore(raw: string): boolean {
    this.setHeader(raw);
    return this.pairs.length > 0;
  }

  private warnPersistError(error: unknown): void {
    if (this.onPersistError) {
      try {
        this.onPersistError(error);
      } catch {
        /* 回调自身异常一并吞掉，持久化失败不得影响网络层 */
      }
    }
  }
}

/** 0.2.15：启动时清理历史明文 cookie 字段（返回新对象，不修改入参）。 */
export function migrateLegacyCookieData(
  data: Record<string, unknown> | null | undefined,
  key: string = DEFAULT_COOKIE_STORAGE_KEY
): { data: Record<string, unknown>; removed: boolean } {
  const source = data && typeof data === "object" ? { ...data } : {};
  const removed = typeof source[key] === "string" && source[key] !== "";
  if (removed) delete source[key];
  return { data: source, removed };
}
/** 8 位非明文 hash（0.2.17 日志用；不记录 cookie 值）。 */
export function hash8(value: string): string {
  let hash = 5381;
  const text = String(value ?? "");
  for (let i = 0; i < text.length; i += 1) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 8);
}