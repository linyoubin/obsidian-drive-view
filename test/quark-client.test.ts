/**
 * Quark 认证/Cookie/网络层单测（纯逻辑，全部用假 transport，不打真实夸克接口）。
 *
 * 覆盖契约 A2 要求的六类用例：cookie 合并 / 逗号串切分 / 数组形态 / 401 判定 / 令牌桶限速 / 退避与熔断，
 * 另加六步扫码流程、5 个状态码、180 秒上限、visibilitychange 补轮询。
 */

import { describe, expect, test } from "bun:test";

import {
  CookieStore,
  DEFAULT_COOKIE_STORAGE_KEY,
  collectSetCookieValues,
  mergeCookiePairs,
  parseCookieHeader,
  resolveSecretStorage,
  serializeCookiePairs,
  splitSetCookieValue,
} from "../src/auth/CookieStore";
import {
  QuarkAuthError,
  QuarkClient,
  QuarkRiskControlError,
  TokenBucket,
  buildDriveUrl,
  type QuarkHttpResponse,
  type QuarkTransport,
} from "../src/client/QuarkClient";
import {
  QUARK_CAS_LOGIN_URL,
  QUARK_QR_BIZ_STR,
  QUARK_QR_STATUS,
  QUARK_TICKET_URL,
  QUARK_TOKEN_URL,
  QuarkQrAuth,
  buildQrContent,
  type QuarkQrLoginResult,
} from "../src/auth/QuarkQrAuth";

// ------------------------------------------------------------------ helpers

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | ArrayBuffer;
}

function jsonResponse(
  status: number,
  body: unknown,
  headers: Record<string, string | string[]> = {}
): QuarkHttpResponse {
  return { status, headers, text: JSON.stringify(body) };
}

function makeTransport(handler: (call: Call) => QuarkHttpResponse | Promise<QuarkHttpResponse>): {
  transport: QuarkTransport;
  calls: Call[];
} {
  const calls: Call[] = [];
  const transport: QuarkTransport = async (request) => {
    const call: Call = {
      url: request.url,
      method: request.method ?? "GET",
      headers: request.headers ?? {},
      body: request.body,
    };
    calls.push(call);
    return await handler(call);
  };
  return { transport, calls };
}

/** 不限速、不真等：单测里网络与限速都要可预测。 */
function idleLimiter(now: () => number = () => 0): TokenBucket {
  return new TokenBucket({ ratePerSecond: 1000, now, sleep: async () => undefined });
}

const SORT_URL = "https://drive-pc.quark.cn/1/clouddrive/file/sort";
const DOWNLOAD_URL = "https://drive-pc.quark.cn/1/clouddrive/file/download";
const ACCOUNT_URL = "https://pan.quark.cn/account/info";
const CAS_URL = "https://uop.quark.cn/cas/custom/login";
const TOKEN_URL = "https://uop.quark.cn/cas/ajax/getTokenForQrcodeLogin";
const TICKET_URL = "https://uop.quark.cn/cas/ajax/getServiceTicketByQrcodeToken";

function rootListBody(count: number, code = 0): Record<string, unknown> {
  const list = Array.from({ length: count }, (_, i) => ({
    fid: `fid-${i}`,
    file_name: `file-${i}.md`,
    dir: i % 2 === 0,
    size: 10 + i,
    updated_at: 1700000000000 + i,
  }));
  return { code, message: "ok", data: { list, metadata: { _total: count } } };
}

interface SceneOptions {
  tokenStatus?: number;
  token?: string;
  ticket?: string;
  casThrows?: boolean;
  accountCookies?: string[];
  sortItems?: number;
  sortCode?: number;
}

/** 假的夸克后端：按 URL 前缀分派，ticket 状态码可由测试逐次推进。 */
function quarkScene(options: SceneOptions = {}): {
  transport: QuarkTransport;
  calls: Call[];
  ticketStatuses: number[];
} {
  const calls: Call[] = [];
  const ticketStatuses: number[] = [QUARK_QR_STATUS.SUCCESS];

  const transport: QuarkTransport = async (request) => {
    const call: Call = {
      url: request.url,
      method: request.method ?? "GET",
      headers: request.headers ?? {},
      body: request.body,
    };
    calls.push(call);
    const url = call.url;

    if (url.startsWith(CAS_URL)) {
      if (options.casThrows) throw new Error("cas unreachable");
      return jsonResponse(200, {}, {
        "set-cookie": ["_UP_F7E_8D_=cas-session; Path=/; Domain=.quark.cn; Max-Age=600"],
      });
    }
    if (url.startsWith(TOKEN_URL)) {
      const status = options.tokenStatus ?? QUARK_QR_STATUS.SUCCESS;
      return jsonResponse(200, {
        status,
        message: status === QUARK_QR_STATUS.SUCCESS ? "ok" : "failed",
        data: { members: { token: options.token ?? "QR_TOKEN_1" } },
      });
    }
    if (url.startsWith(TICKET_URL)) {
      const next =
        ticketStatuses.length > 1 ? (ticketStatuses.shift() as number) : ticketStatuses[0];
      const body: Record<string, unknown> = {
        status: next,
        message: next === QUARK_QR_STATUS.SUCCESS ? "ok" : "waiting",
      };
      if (next === QUARK_QR_STATUS.SUCCESS) {
        // 真机形态：data.members.service_ticket
        body.data = { members: { service_ticket: options.ticket ?? "SERVICE_TICKET_1" } };
      }
      return jsonResponse(200, body);
    }
    if (url.startsWith(ACCOUNT_URL)) {
      // 真机：登录成功时 __puus 可能不出现，只有 __pus/__kps 等
      const cookies = options.accountCookies ?? [
        "__pus=true; Path=/; Domain=.quark.cn",
        "__kps=xxx; Path=/; Domain=.quark.cn",
        "__uid=uid-1; Path=/; Domain=.quark.cn",
      ];
      return jsonResponse(200, { code: 0 }, { "set-cookie": cookies });
    }
    if (url.startsWith(SORT_URL)) {
      const count = options.sortItems ?? 2;
      return jsonResponse(200, rootListBody(count, options.sortCode ?? 0));
    }
    return jsonResponse(404, { code: 404, message: "unknown" });
  };

  return { transport, calls, ticketStatuses };
}

/** 立刻触发的计时器（把 2 秒轮询压成微任务，便于断言次数）。 */
function microtaskTimer(): { setTimeoutFn: (cb: () => void, ms: number) => unknown; clearTimeoutFn: () => void } {
  return {
    setTimeoutFn: (cb: () => void) => {
      queueMicrotask(cb);
      return 0;
    },
    clearTimeoutFn: () => undefined,
  };
}

/** 真实宏任务 flush：让被测试代码的 await 链跑到底。 */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 1));
}

// ------------------------------------------------------------------ CookieStore

describe("CookieStore：set-cookie 解析与合并", () => {
  test("数组形态：多条 set-cookie 全部收下（真机实测形态）", () => {
    const headers = {
      "Set-Cookie": [
        "_UP_28A_52_=a; Path=/; Domain=.quark.cn",
        "_UP_F7E_8D_=b; Path=/; Domain=.quark.cn; Max-Age=600",
        "__pus=true; Path=/",
      ],
    };
    const raws = collectSetCookieValues(headers);
    expect(raws.length).toBe(3);
    expect(raws[1].startsWith("_UP_F7E_8D_=b")).toBe(true);
    // 头名大小写不敏感
    expect(collectSetCookieValues({ "set-cookie": ["x=1"] }).length).toBe(1);
  });

  test("逗号串：按 `, name=` 切分，多条不被吞成一条", () => {
    const merged =
      "_UP_28A_52_=a; Path=/, _UP_F7E_8D_=b; Path=/; Max-Age=600, __pus=true; Path=/";
    const parts = splitSetCookieValue(merged);
    expect(parts.length).toBe(3);
    expect(parts.map((p) => p.split("=")[0])).toEqual([" _UP_28A_52_", " _UP_F7E_8D_", " __pus"].map((s) => s.trim()));
  });

  test("逗号串：Expires 里的逗号不能被当成分隔符", () => {
    const merged = "__kps=1; Expires=Wed, 21 Oct 2015 07:28:00 GMT, __pus=true; Path=/";
    const parts = splitSetCookieValue(merged);
    expect(parts.length).toBe(2);
    expect(parts[0]).toContain("Expires=Wed, 21 Oct 2015 07:28:00 GMT");
    expect(parts[1].startsWith("__pus=true")).toBe(true);
  });

  test("按 name 合并：新值覆盖旧值，未提及项保留，同 name 只留一条", () => {
    const merged = mergeCookiePairs(
      ["__pus=false; Path=/", "_UP_D_=keep-me", "__kps=old"],
      ["__pus=true; Path=/", "__puus=false; Path=/"]
    );
    expect(merged.length).toBe(4);
    const header = serializeCookiePairs(merged);
    expect(header).toBe("__pus=true; _UP_D_=keep-me; __kps=old; __puus=false");
  });

  test("CookieStore.applySetCookie：响应头合并回写并导出 `k=v; k2=v2`", () => {
    const store = new CookieStore({ pairs: "__pus=false; _UP_D_=seed" });
    const applied = store.applySetCookie({
      // Expires 用未来时间：删除型语义（T-07）已落地，过去时间会被当作「删除该 cookie」
      "set-cookie": ["__pus=true; Path=/", "__puus=false; Path=/; Expires=Sat, 21 Oct 2033 07:28:00 GMT"],
    });
    expect(applied.names).toEqual(["__pus", "__puus"]);
    expect(applied.removed).toEqual([]);
    expect(applied.total).toBe(3);
    expect(store.getHeader()).toBe("__pus=true; _UP_D_=seed; __puus=false");
    expect(store.has("__puus")).toBe(true);
    expect(store.hasLoginCookie()).toBe(true);
  });

  test("空/缺失响应头不炸，也不改动已有 Cookie", () => {
    const store = new CookieStore({ pairs: "__pus=true" });
    expect(store.applySetCookie(null).names).toEqual([]);
    expect(store.applySetCookie({}).names).toEqual([]);
    expect(store.applySetCookie({ "set-cookie": [] }).names).toEqual([]);
    expect(store.getHeader()).toBe("__pus=true");
    expect(splitSetCookieValue("")).toEqual([]);
    expect(splitSetCookieValue(undefined)).toEqual([]);
  });

  test("删除语义：`Max-Age<=0` 从集合里移除同 name 项（A7）", () => {
    const store = new CookieStore({ pairs: "__pus=true; __kps=keep; __puus=false" });
    const applied = store.applySetCookie({
      "set-cookie": ["__pus=; Max-Age=0; Path=/", "__puus=; Max-Age=-1; Path=/"],
    });
    expect(applied.removed.slice().sort()).toEqual(["__pus", "__puus"]);
    expect(applied.names).toEqual([]);
    expect(store.has("__pus")).toBe(false);
    expect(store.getHeader()).toBe("__kps=keep");
  });

  test("删除语义：`Expires` 已过期即删除；删不存在的 name 不报错（A7）", () => {
    const now = Date.parse("2026-11-20T00:00:00Z");
    const store = new CookieStore({ pairs: "__pus=true; _UP_D_=keep" });
    const applied = store.applySetCookie(
      { "set-cookie": ["__pus=gone; Expires=Thu, 01 Jan 2020 00:00:00 GMT", "__nope=; Max-Age=0"] },
      now
    );
    expect(applied.removed).toEqual(["__pus", "__nope"]);
    expect(store.has("__pus")).toBe(false);
    expect(store.getHeader()).toBe("_UP_D_=keep");

    // 未来的 Expires 不算删除
    const alive = new CookieStore({ pairs: "_UP_D_=keep" });
    const kept = alive.applySetCookie(
      { "set-cookie": ["__pus=true; Expires=Sat, 21 Oct 2033 07:28:00 GMT"] },
      now
    );
    expect(kept.removed).toEqual([]);
    expect(alive.has("__pus")).toBe(true);
  });

  test("parseCookieHeader：支持 `k=v; k2=v2` 与 `Cookie:` 前缀回读", () => {
    expect(parseCookieHeader("__pus=true; __kps=2")).toEqual(["__pus=true", "__kps=2"]);
    expect(parseCookieHeader("Cookie: a=1; b=2")).toEqual(["a=1", "b=2"]);
    const store = new CookieStore({ pairs: "Cookie: a=1; b=2" });
    expect(store.getHeader()).toBe("a=1; b=2");
    store.clear();
    expect(store.getHeader()).toBe("");
    expect(store.isEmpty).toBe(true);
  });

  test("持久化：secretStorage 运行期存在就用它", async () => {
    const saved: Record<string, string> = {};
    const app = {
      secretStorage: {
        setSecret: (id: string, value: string) => {
          saved[id] = value;
        },
        getSecret: (id: string) => (id === "quark-cookie" ? "__pus=true; __kps=ok" : null),
      },
    };
    expect(resolveSecretStorage(app)).not.toBeNull();
    const store = new CookieStore({ app, saveData: async () => undefined });
    expect(store.storageMode).toBe("secret");
    expect(await store.load()).toBe(true);
    expect(store.getHeader()).toBe("__pus=true; __kps=ok");
    expect(await store.save()).toBe(true);
    expect(saved["quark-cookie"]).toBe("__pus=true; __kps=ok");
  });

  test("持久化：无 secretStorage → storageMode=none，不写文件", async () => {
    const saved: Array<Record<string, unknown>> = [];
    const store = new CookieStore({
      app: {},
      saveData: async (data) => {
        saved.push(data);
      },
      loadData: async () => ({ [DEFAULT_COOKIE_STORAGE_KEY]: "__pus=true" }),
    });
    // 0.2.15：只允许 secretStorage；无 secretStorage 不写文件
    expect(store.storageMode).toBe("none");
    expect(await store.load()).toBe(false);
    expect(await store.save()).toBe(false);
    expect(saved).toEqual([]);
  });
  test("持久化：两者都不可用 → 纯内存，save 返回 false 不抛", async () => {
    const store = new CookieStore({ pairs: "__pus=true" });
    expect(store.storageMode).toBe("none");
    expect(await store.load()).toBe(false);
    expect(await store.save()).toBe(false);
    expect(await store.load()).toBe(false);
  });
});

// ------------------------------------------------------------------ 令牌桶

describe("QuarkClient：令牌桶限速 3 req/s", () => {
  test("前 3 次不等待，第 4 次按缺口等约 1/3 秒", async () => {
    const sleeps: number[] = [];
    const bucket = new TokenBucket({
      ratePerSecond: 3,
      now: () => 0,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    const waits: number[] = [];
    for (let i = 0; i < 4; i += 1) waits.push(await bucket.acquire());
    expect(waits.slice(0, 3)).toEqual([0, 0, 0]);
    expect(waits[3]).toBeGreaterThan(300);
    expect(waits[3]).toBeLessThan(400);
    expect(sleeps.length).toBe(1);
    expect(bucket.totalWaitedMs).toBe(waits[3]);
  });

  test("Client 的每个请求都过限速器", async () => {
    const sleeps: number[] = [];
    const limiter = new TokenBucket({
      ratePerSecond: 3,
      now: () => 0,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    const { transport, calls } = makeTransport(() => jsonResponse(200, rootListBody(1)));
    const client = new QuarkClient({ transport, limiter });
    await client.listDir("0", { all: false });
    await client.listDir("0", { all: false });
    await client.listDir("0", { all: false });
    await client.listDir("0", { all: false });
    expect(calls.length).toBe(4);
    expect(sleeps.length).toBe(1);
  });
});

// ------------------------------------------------------------------ 统一请求方法

describe("QuarkClient：Cookie 自管 / 401 判定 / 退避与熔断", () => {
  test("每个请求都带 Cookie 头，并合并响应 set-cookie 回写", async () => {
    const store = new CookieStore({ pairs: "__pus=false; _UP_F7E_8D_=cas" });
    const { transport, calls } = makeTransport(() =>
      jsonResponse(200, rootListBody(1), { "set-cookie": ["__puus=renewed; Path=/"] })
    );
    const client = new QuarkClient({ transport, cookieStore: store, limiter: idleLimiter() });
    await client.listDir("0", { all: false });

    expect(calls.length).toBe(1);
    expect(calls[0].headers.Cookie).toBe("__pus=false; _UP_F7E_8D_=cas");
    expect(store.has("__puus")).toBe(true);
    expect(store.getHeader()).toContain("__puus=renewed");
  });

  test("HTTP 401 → QuarkAuthError（不重试）", async () => {
    const { transport, calls } = makeTransport(() => jsonResponse(401, { code: 31001, message: "guest" }));
    const client = new QuarkClient({ transport, limiter: idleLimiter() });
    await expect(client.listDir("0", { all: false })).rejects.toBeInstanceOf(QuarkAuthError);
    expect(calls.length).toBe(1);
  });

  test("HTTP 200 但 code=31001 → QuarkAuthError", async () => {
    const { transport } = makeTransport(() => jsonResponse(200, { code: 31001, message: "require login [guest]" }));
    const client = new QuarkClient({ transport, limiter: idleLimiter() });
    await expect(client.listDir("0", { all: false })).rejects.toBeInstanceOf(QuarkAuthError);
  });

  test("412 → 指数退避 2s/4s/8s（最多 3 次）后抛风控错误", async () => {
    const sleeps: number[] = [];
    const { transport, calls } = makeTransport(() => jsonResponse(412, { code: 412, message: "risk" }));
    const client = new QuarkClient({
      transport,
      limiter: idleLimiter(),
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      now: () => 0,
    });
    await expect(client.listDir("0", { all: false })).rejects.toBeInstanceOf(QuarkRiskControlError);
    expect(sleeps).toEqual([2000, 4000, 8000]);
    expect(calls.length).toBe(4);
    expect(client.isBreakerOpen()).toBe(false);
  });

  test("429 连续 5 次 → 熔断 10 分钟，期间不再发请求，冷却后自动恢复", async () => {
    let clock = 0;
    const { transport, calls } = makeTransport(() => jsonResponse(429, { code: 429, message: "too many" }));
    const client = new QuarkClient({
      transport,
      limiter: idleLimiter(() => clock),
      sleep: async () => undefined,
      now: () => clock,
    });

    for (let i = 0; i < 5; i += 1) {
      await expect(client.listDir("0", { all: false })).rejects.toBeInstanceOf(QuarkRiskControlError);
    }
    expect(client.isBreakerOpen()).toBe(true);
    expect(calls.length).toBe(5 * 4);

    const callsBefore = calls.length;
    await expect(client.listDir("0", { all: false })).rejects.toBeInstanceOf(QuarkRiskControlError);
    expect(calls.length).toBe(callsBefore); // 熔断中：一个请求都不发

    clock += 10 * 60 * 1000 + 1;
    expect(client.isBreakerOpen()).toBe(false);
    client.resetBreaker();
    expect(client.isBreakerOpen()).toBe(false);
  });

  test("成功一次就清零风控连击（不会 4 次失败 + 1 次成功后误熔断）", async () => {
    let clock = 0;
    let fail = true;
    const { transport } = makeTransport(() =>
      fail ? jsonResponse(429, { code: 429 }) : jsonResponse(200, rootListBody(0))
    );
    const client = new QuarkClient({
      transport,
      limiter: idleLimiter(() => clock),
      sleep: async () => undefined,
      now: () => clock,
    });
    for (let i = 0; i < 4; i += 1) {
      await expect(client.listDir("0", { all: false })).rejects.toBeInstanceOf(QuarkRiskControlError);
    }
    fail = false;
    await client.listDir("0", { all: false });
    expect(client.stats.riskStreak).toBe(0);
    expect(client.isBreakerOpen()).toBe(false);
  });
});

// ------------------------------------------------------------------ 只读业务

describe("QuarkClient：listDir / downloadFile / verifyAlive", () => {
  test("listDir：解析条目并按 metadata._total 自动翻页", async () => {
    const pages: Array<{ list: unknown[]; total: number }> = [
      { list: [{ fid: "a", file_name: "a.md", dir: 1, size: 0, updated_at: 1 }], total: 2 },
      { list: [{ fid: "b", file_name: "b.md", dir: 0, size: 33, updated_at: 2 }], total: 2 },
    ];
    let index = 0;
    const { transport, calls } = makeTransport(() => {
      const page = pages[Math.min(index, pages.length - 1)];
      index += 1;
      return jsonResponse(200, { code: 0, data: { list: page.list, metadata: { _total: page.total } } });
    });
    const client = new QuarkClient({ transport, limiter: idleLimiter() });
    const result = await client.listDir("pdir-1", { pageSize: 1 });

    expect(result.items.length).toBe(2);
    expect(result.pages).toBe(2);
    expect(result.total).toBe(2);
    expect(calls.length).toBe(2);
    expect(result.items[0].isFolder).toBe(true);
    expect(result.items[1].isFolder).toBe(false);
    expect(result.items[1].size).toBe(33);
    expect(calls[0].url).toContain(`${SORT_URL}?`);
    expect(calls[0].url).toContain("pdir_fid=pdir-1");
    expect(calls[0].url).toContain("pr=ucpro");
    expect(calls[0].url).toContain("fr=pc");
  });

  test("downloadFile：/file/download 取签名 URL 后第二跳下载，两跳都带 Cookie", async () => {
    const { transport, calls } = makeTransport((call) => {
      if (call.url.startsWith(DOWNLOAD_URL)) {
        return jsonResponse(200, { code: 0, data: [{ download_url: "https://dl.quark.cn/signed?x=1" }] });
      }
      return { status: 200, headers: {}, text: "", arrayBuffer: new Uint8Array([1, 2, 3]).buffer };
    });
    const client = new QuarkClient({
      transport,
      cookieStore: new CookieStore({ pairs: "__pus=true" }),
      limiter: idleLimiter(),
    });
    const buffer = await client.downloadFile("fid-9");

    expect(buffer.byteLength).toBe(3);
    expect(calls.length).toBe(2);
    expect(calls[0].method).toBe("POST");
    expect(String(calls[0].body)).toContain("fid-9");
    expect(calls[1].url).toBe("https://dl.quark.cn/signed?x=1");
    expect(calls[1].method).toBe("GET");
    expect(calls[0].headers.Cookie).toBe("__pus=true");
    expect(calls[1].headers.Cookie).toBe("__pus=true");
  });

  test("verifyAlive：/file/sort?pdir_fid=0 且 code=0 才算登录成功", async () => {
    const { transport, calls } = makeTransport(() => jsonResponse(200, rootListBody(3)));
    const client = new QuarkClient({
      transport,
      cookieStore: new CookieStore({ pairs: "__pus=true; __puus=false" }),
      limiter: idleLimiter(),
    });
    const verified = await client.verifyAlive();
    expect(verified.code).toBe(0);
    expect(verified.itemCount).toBe(3);
    expect(calls[0].url).toContain("pdir_fid=0");
    // __puus=false 不是失败判据
    expect(verified.cookieNames).toContain("__puus");
  });

  test("buildDriveUrl：带公共参数 pr=ucpro&fr=pc", () => {
    const url = buildDriveUrl("/file/sort", { pdir_fid: "0" });
    expect(url.startsWith(SORT_URL)).toBe(true);
    expect(url).toContain("pr=ucpro");
    expect(url).toContain("fr=pc");
    expect(url).toContain("pdir_fid=0");
  });
});

// ------------------------------------------------------------------ 二维码内容

describe("QuarkQrAuth：二维码内容", () => {
  test("完整 5 参数，且 uc_biz_str percent-encode（%7C/%40/%3A）", () => {
    const content = buildQrContent("TOKEN_ABC");
    expect(content.startsWith("https://su.quark.cn/4_eMHBJ?token=TOKEN_ABC")).toBe(true);
    expect(content).toBe(
      "https://su.quark.cn/4_eMHBJ?token=TOKEN_ABC&client_id=532&ssb=weblogin&uc_param_str=&uc_biz_str=" +
        encodeURIComponent(QUARK_QR_BIZ_STR)
    );
    expect(content).toContain("&client_id=532");
    expect(content).toContain("&ssb=weblogin");
    expect(content).toContain("&uc_param_str=");
    expect(content).toContain("%7C"); // |
    expect(content).toContain("%40"); // @
    expect(content).toContain("%3A"); // :
    expect(content).not.toContain("|");
    expect(content).not.toContain("@");
    // 只带 token 的短 URL 会被夸克判「登录请求已过期」，因此长度远超 66
    expect(content.length).toBeGreaterThan(150);
  });
});

// ------------------------------------------------------------------ 六步流程

describe("QuarkQrAuth：六步扫码流程", () => {
  test("六步顺序：CAS 会话 → token → 二维码 → ticket → account/info → file/sort 验活", async () => {
    const scene = quarkScene();
    const client = new QuarkClient({ transport: scene.transport, limiter: idleLimiter() });
    const qrContents: string[] = [];
    const auth = new QuarkQrAuth({
      client,
      now: () => 0,
      ...microtaskTimer(),
      onQr: (content) => qrContents.push(content),
    });

    const started = await auth.start();
    expect(started.state).toBe("waiting");
    expect(started.token).toBe("QR_TOKEN_1");
    expect(qrContents.length).toBe(1);
    expect(qrContents[0]).toBe(buildQrContent("QR_TOKEN_1"));

    const done = await auth.waitForLogin();
    expect(done.ok).toBe(true);
    expect(done.state).toBe("success");
    expect(done.itemCount).toBe(2);

    const order = scene.calls.map((call) => {
      if (call.url.startsWith(CAS_URL)) return "cas";
      if (call.url.startsWith(TOKEN_URL)) return "token";
      if (call.url.startsWith(TICKET_URL)) return "ticket";
      if (call.url.startsWith(ACCOUNT_URL)) return "account";
      if (call.url.startsWith(SORT_URL)) return "sort";
      return "other";
    });
    expect(order).toEqual(["cas", "token", "ticket", "account", "sort"]);

    // 步 4 之后不再轮询（ticket 一次性，成功后停止）
    expect(auth.pollCount).toBe(1);
    // 步 1 的 CAS 会话 cookie 在步 2 就带上了
    expect(scene.calls[1].headers.Cookie).toContain("_UP_F7E_8D_");
    // 步 5 换到的 cookie 在步 6 验活时带上
    expect(scene.calls[4].headers.Cookie).toContain("__pus=true");
    // __puus 登录成功时可以不存在，不能当失败判据
    expect(client.cookieStore.has("__puus")).toBe(false);
  });

  test("50004001（等待扫码）→ 继续轮询，第 3 次成功", async () => {
    const scene = quarkScene();
    scene.ticketStatuses.length = 0;
    scene.ticketStatuses.push(QUARK_QR_STATUS.WAITING, QUARK_QR_STATUS.WAITING, QUARK_QR_STATUS.SUCCESS);
    const client = new QuarkClient({ transport: scene.transport, limiter: idleLimiter() });
    const auth = new QuarkQrAuth({ client, now: () => 0, ...microtaskTimer() });

    await auth.start();
    const done: QuarkQrLoginResult = await auth.waitForLogin();
    expect(done.ok).toBe(true);
    expect(auth.pollCount).toBe(3);
    const ticketCalls = scene.calls.filter((call) => call.url.startsWith(TICKET_URL));
    expect(ticketCalls.length).toBe(3);
  });

  test("50004002（二维码过期）→ 停止轮询并报过期", async () => {
    const scene = quarkScene();
    scene.ticketStatuses.length = 0;
    scene.ticketStatuses.push(QUARK_QR_STATUS.EXPIRED);
    const client = new QuarkClient({ transport: scene.transport, limiter: idleLimiter() });
    const auth = new QuarkQrAuth({ client, now: () => 0, ...microtaskTimer() });

    await auth.start();
    const done = await auth.waitForLogin();
    expect(done.state).toBe("expired");
    expect(done.ok).toBe(false);
    expect(done.status).toBe(50004002);
    expect(scene.calls.filter((call) => call.url.startsWith(ACCOUNT_URL)).length).toBe(0);
  });

  test("50004003（失败）与 50004004（用户取消）分别终止流程", async () => {
    for (const [status, expected] of [
      [QUARK_QR_STATUS.FAILED, "failed"],
      [QUARK_QR_STATUS.CANCELED, "canceled"],
    ] as Array<[number, string]>) {
      const scene = quarkScene();
      scene.ticketStatuses.length = 0;
      scene.ticketStatuses.push(status);
      const client = new QuarkClient({ transport: scene.transport, limiter: idleLimiter() });
      const auth = new QuarkQrAuth({ client, now: () => 0, ...microtaskTimer() });
      await auth.start();
      const done = await auth.waitForLogin();
      expect(done.state as string).toBe(expected);
      expect(done.status).toBe(status);
      expect(auth.pollCount).toBe(1);
    }
  });

  test("累计 180 秒主动停止（服务端实测 184 秒）", async () => {
    let clock = 0;
    const scene = quarkScene();
    scene.ticketStatuses.length = 0;
    scene.ticketStatuses.push(QUARK_QR_STATUS.WAITING); // 永远是「等待中」
    const client = new QuarkClient({ transport: scene.transport, limiter: idleLimiter(() => clock) });
    const auth = new QuarkQrAuth({
      client,
      now: () => clock,
      ttlMs: 180000,
      pollIntervalMs: 2000,
      // 假计时器：每次触发就把时钟推进到该等待的时点
      setTimeoutFn: (cb: () => void, ms: number) => {
        clock += ms;
        queueMicrotask(cb);
        return 0;
      },
      clearTimeoutFn: () => undefined,
    });

    await auth.start();
    const done = await auth.waitForLogin();
    expect(done.state).toBe("timeout");
    expect(done.ok).toBe(false);
    expect(clock).toBeGreaterThanOrEqual(180000);
    expect(auth.pollCount).toBeGreaterThanOrEqual(90);
    expect(auth.pollCount).toBeLessThanOrEqual(92);
  });

  test("visibilitychange 回前台：立即补一次轮询并重置 2 秒计时", async () => {
    let clock = 0;
    let pendingTimer: (() => void) | null = null;
    const scene = quarkScene();
    scene.ticketStatuses.length = 0;
    scene.ticketStatuses.push(QUARK_QR_STATUS.WAITING, QUARK_QR_STATUS.WAITING, QUARK_QR_STATUS.SUCCESS);
    const client = new QuarkClient({ transport: scene.transport, limiter: idleLimiter(() => clock) });
    const auth = new QuarkQrAuth({
      client,
      now: () => clock,
      setTimeoutFn: (cb: () => void) => {
        pendingTimer = cb;
        return 0;
      },
      clearTimeoutFn: () => {
        pendingTimer = null;
      },
    });

    await auth.start();
    const pending = auth.waitForLogin();
    await flush();
    expect(auth.pollCount).toBe(1);
    // 没有 kick 时不会自己再轮询（2 秒计时未到）
    await flush();
    expect(auth.pollCount).toBe(1);
    expect(pendingTimer).not.toBeNull();

    // 模拟从夸克 App 切回：立即补一次轮询
    auth.handleVisibilityChange("visible");
    await flush();
    expect(auth.pollCount).toBe(2);

    // 再补一次，这次命中成功
    auth.handleVisibilityChange("visible");
    const done = await pending;
    expect(done.ok).toBe(true);
    expect(done.itemCount).toBe(2);
    expect(pendingTimer).toBeNull();
  });

  test("切后台只记事件，不触发轮询", async () => {
    let clock = 0;
    const scene = quarkScene();
    scene.ticketStatuses.length = 0;
    scene.ticketStatuses.push(QUARK_QR_STATUS.WAITING, QUARK_QR_STATUS.SUCCESS);
    const client = new QuarkClient({ transport: scene.transport, limiter: idleLimiter(() => clock) });
    const auth = new QuarkQrAuth({
      client,
      now: () => clock,
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => undefined,
    });
    await auth.start();
    auth.handleVisibilityChange("hidden");
    expect(auth.pollCount).toBe(0);
    const pending = auth.waitForLogin();
    await flush();
    expect(auth.pollCount).toBe(1);
    auth.handleVisibilityChange("visible");
    const done = await pending;
    expect(done.ok).toBe(true);
  });

  test("建 CAS 会话失败不中断（真机：只记一条日志）", async () => {
    const scene = quarkScene({ casThrows: true });
    const client = new QuarkClient({ transport: scene.transport, limiter: idleLimiter() });
    const messages: string[] = [];
    const auth = new QuarkQrAuth({
      client,
      now: () => 0,
      ...microtaskTimer(),
      onProgress: (progress) => messages.push(`${progress.phase}:${progress.message}`),
    });
    const started = await auth.start();
    expect(started.state).toBe("waiting");
    expect(started.qrContent).toBe(buildQrContent("QR_TOKEN_1"));
    expect(messages.some((m) => m.startsWith("cas:") && m.includes("失败"))).toBe(true);
    expect(scene.calls.some((call) => call.url.startsWith(TOKEN_URL))).toBe(true);
  });

  test("换 Cookie 失败 / 验活失败都给出 failed 结果", async () => {
    const noCookie = quarkScene({ accountCookies: [] });
    const clientA = new QuarkClient({ transport: noCookie.transport, limiter: idleLimiter() });
    const authA = new QuarkQrAuth({ client: clientA, now: () => 0, ...microtaskTimer() });
    await authA.start();
    const doneA = await authA.waitForLogin();
    expect(doneA.state).toBe("failed");
    expect(doneA.message).toContain("set-cookie");

    const badSort = quarkScene({ sortCode: 31001 });
    const clientB = new QuarkClient({ transport: badSort.transport, limiter: idleLimiter() });
    const authB = new QuarkQrAuth({ client: clientB, now: () => 0, ...microtaskTimer() });
    await authB.start();
    const doneB = await authB.waitForLogin();
    expect(doneB.state).toBe("failed");
    expect(doneB.message).toContain("验活失败");
  });

  test("cancel() 立即结束轮询", async () => {
    let clock = 0;
    const scene = quarkScene();
    scene.ticketStatuses.length = 0;
    scene.ticketStatuses.push(QUARK_QR_STATUS.WAITING);
    const client = new QuarkClient({ transport: scene.transport, limiter: idleLimiter(() => clock) });
    const auth = new QuarkQrAuth({
      client,
      now: () => clock,
      setTimeoutFn: () => 0,
      clearTimeoutFn: () => undefined,
    });
    await auth.start();
    const pending = auth.waitForLogin();
    await flush();
    auth.cancel();
    const done = await pending;
    expect(done.state).toBe("canceled");
  });
});
