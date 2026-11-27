/**
 * 0.2.34：深链测试器第二阶段 —— 修正内层 URL 编码（用户实测：⑤/⑦ 能唤 App 但 blank/报错）。
 *
 * 结论：外层 `quark://webview?url=` / `quark://open?url=` 正确；内层 URL 里的裸 `#`
 * 被当作外层 fragment 截断，webview 收到半截 → 空白/报错。所以核心变量是「内层怎么编码」。
 *
 * 候选按「最可能 → 对照」排序：
 *   1. webview + 整体 encodeURIComponent(main hash)   ← 最可能
 *   2. webview + 只把 # 换成 %23（其余不编码）
 *   3. open + 上面两种（对照）
 *   4. 无 hash 路由 `/list?fid={fid}`（整体编码）
 *   5. 别名路由 `#/list/{fid}`（整体编码）
 *   6. 直挂 scheme `pan.quark.cn://list#/list/all/{fid}`
 * 其余（file query / 域名 hash / 不编码对照）补齐 ≥16 条。
 *
 * 四选一：`ok`（对了）/ `wrong-place`（进 App 但位置不对）/ `blank`（空白页或报错）/ `no-app`（没进 App）。
 * 只有 `ok` 才写入模板。**不创建分享**（无 `/s/`、无 share API）。
 */

export type InnerEncoding = "full" | "minimal" | "none";
export type DeeplinkOuter = "quark-webview" | "quark-open" | "direct";
export type DeeplinkAnswerResult = "ok" | "wrong-place" | "blank" | "no-app";
export type DeeplinkPriority = "most-likely" | "alternate" | "control";

export const OUTER_PREFIX: Record<Exclude<DeeplinkOuter, "direct">, string> = {
  "quark-webview": "quark://webview?url=",
  "quark-open": "quark://open?url=",
};

/** 内层 URL 变体（每个变体都会 × 两个外层）。 */
export interface InnerVariant {
  id: string;
  /** 含 `{fid}` / `{fileFid}` 占位符的内层 URL。 */
  template: string;
  encoding: InnerEncoding;
  priority: DeeplinkPriority;
  label: string;
}

export const INNER_VARIANTS: readonly InnerVariant[] = [
  {
    id: "main-hash-full",
    template: "https://pan.quark.cn/list#/list/all/{fid}",
    encoding: "full",
    priority: "most-likely",
    label: "整体编码（最可能）",
  },
  {
    id: "main-hash-minimal",
    template: "https://pan.quark.cn/list#/list/all/{fid}",
    encoding: "minimal",
    priority: "most-likely",
    label: "只编码 #（%23）",
  },
  {
    id: "alias-list-full",
    template: "https://pan.quark.cn/list#/list/{fid}",
    encoding: "full",
    priority: "alternate",
    label: "别名路由 #/list/{fid}（整体编码）",
  },
  {
    id: "no-hash-full",
    template: "https://pan.quark.cn/list?fid={fid}",
    encoding: "full",
    priority: "alternate",
    label: "无 hash 路由 /list?fid=（整体编码）",
  },
  {
    id: "main-hash-file-full",
    template: "https://pan.quark.cn/list#/list/all/{fid}?fid={fileFid}",
    encoding: "full",
    priority: "alternate",
    label: "目录 + 文件 query（整体编码）",
  },
  {
    id: "domain-hash-full",
    template: "https://pan.quark.cn/#/list/all/{fid}",
    encoding: "full",
    priority: "alternate",
    label: "hash 在域名后（整体编码）",
  },
  {
    id: "main-hash-none",
    template: "https://pan.quark.cn/list#/list/all/{fid}",
    encoding: "none",
    priority: "control",
    label: "不编码（当前失败对照）",
  },
  {
    id: "alias-list-minimal",
    template: "https://pan.quark.cn/list#/list/{fid}",
    encoding: "minimal",
    priority: "alternate",
    label: "别名路由 #/list/{fid}（只编码 #）",
  },
  {
    id: "no-hash-minimal",
    template: "https://pan.quark.cn/list?fid={fid}",
    encoding: "minimal",
    priority: "alternate",
    label: "无 hash 路由 /list?fid=（只编码 #）",
  },
  {
    id: "direct-scheme",
    template: "pan.quark.cn://list#/list/all/{fid}",
    encoding: "none",
    priority: "alternate",
    label: "直挂自定义 scheme（若 App 支持路由）",
  },
];

/** 按模式编码内层 URL；`minimal` 只处理 `#`。 */
export function encodeInnerUrl(inner: string, encoding: InnerEncoding): string {
  if (encoding === "full") return encodeURIComponent(inner);
  if (encoding === "minimal") return inner.replace(/#/g, "%23");
  return inner;
}

/** 把编码结果里的占位符还原成 `{fid}` / `{fileFid}`（模板里必须保留占位符）。 */
function restorePlaceholders(encoded: string): string {
  return encoded.replace(/%7Bfid%7D/gi, "{fid}").replace(/%7BfileFid%7D/gi, "{fileFid}");
}

function fillPlaceholders(text: string, fid: string, fileFid: string): string {
  return text
    .replace(/\{fid\}/g, encodeURIComponent(fid))
    .replace(/\{fileFid\}/g, encodeURIComponent(fileFid));
}

export interface DeeplinkCandidate2 {
  caseId: number;
  id: string;
  outer: DeeplinkOuter;
  outerPrefix: string;
  /** 外层显示名（`quark://webview?url=` / `quark://open?url=` / 直挂）。 */
  outerLabel: string;
  /** 内层模板（含占位符）。 */
  innerTemplate: string;
  encoding: InnerEncoding;
  encoded: boolean;
  priority: DeeplinkPriority;
  /** 实际发出的完整串（已替换实际 id）。 */
  url: string;
  /** 确认可用后写入设置的模板（外层 + 编码后的内层，保留占位符）。 */
  template: string;
  label: string;
}

const OUTER_ORDER: Array<Exclude<DeeplinkOuter, "direct">> = ["quark-webview", "quark-open"];

function makeCandidate(
  caseId: number,
  outer: DeeplinkOuter,
  variant: InnerVariant,
  info: { fid: string; fileFid: string }
): DeeplinkCandidate2 {
  const outerPrefix = outer === "direct" ? "" : OUTER_PREFIX[outer];
  const innerTemplate = variant.template;
  const encodedInnerTemplate = restorePlaceholders(encodeInnerUrl(innerTemplate, variant.encoding));
  const template = outer === "direct" ? encodedInnerTemplate : `${outerPrefix}${encodedInnerTemplate}`;
  const innerActual = fillPlaceholders(innerTemplate, info.fid, info.fileFid);
  const encodedInnerActual =
    variant.encoding === "full"
      ? encodeURIComponent(innerActual)
      : variant.encoding === "minimal"
        ? innerActual.replace(/#/g, "%23")
        : innerActual;
  const url = outer === "direct" ? encodedInnerActual : `${outerPrefix}${encodedInnerActual}`;
  return {
    caseId,
    id: `${variant.id}:${outer}`,
    outer,
    outerPrefix,
    outerLabel: outer === "direct" ? "直挂 scheme" : outerPrefix,
    innerTemplate,
    encoding: variant.encoding,
    encoded: variant.encoding !== "none",
    priority: variant.priority,
    url,
    template,
    label:
      outer === "direct"
        ? `${variant.label}（直挂）`
        : `${variant.label} · ${outerPrefix.replace("?url=", "")}`,
  };
}

/**
 * 生成第二阶段候选（≥16 条）。
 *
 * 排序：先「最可能」（webview full/minimal，open 对照），再备用路由，最后不编码对照；直挂 scheme 单独一条。
 */
export function buildDeeplinkCandidates2(info: { fid: string; fileFid: string }): DeeplinkCandidate2[] {
  const fid = String(info?.fid ?? "").trim();
  if (!fid) return [];
  const fileFid = String(info?.fileFid ?? "").trim();

  const rows: DeeplinkCandidate2[] = [];
  // 1) 最可能的四种：webview full/minimal → open full/minimal
  const mainVariants = INNER_VARIANTS.filter(
    (item) => item.id === "main-hash-full" || item.id === "main-hash-minimal"
  );
  for (const outer of OUTER_ORDER) {
    for (const variant of mainVariants) rows.push(makeCandidate(0, outer, variant, { fid, fileFid }));
  }
  // 2) 备用路由（别名 / 无 hash / 文件 query / 域名 hash）× 两个 outer
  for (const variant of INNER_VARIANTS.filter(
    (item) => item.priority === "alternate" && item.id !== "direct-scheme"
  )) {
    for (const outer of OUTER_ORDER) rows.push(makeCandidate(0, outer, variant, { fid, fileFid }));
  }
  // 3) 直挂 scheme（单独一条，不套 outer）
  const direct = INNER_VARIANTS.find((item) => item.id === "direct-scheme")!;
  rows.push(makeCandidate(0, "direct", direct, { fid, fileFid }));
  // 4) 不编码对照（两个 outer）
  for (const outer of OUTER_ORDER) rows.push(makeCandidate(0, outer, INNER_VARIANTS.find((item) => item.id === "main-hash-none")!, { fid, fileFid }));

  return rows.map((row, index) => ({ ...row, caseId: index + 1 }));
}

/** 只有「对了」才写入模板。 */
export function shouldSaveTemplate(result: DeeplinkAnswerResult): boolean {
  return result === "ok";
}

/** 确认可用后写入的模板（外层 + 编码后的内层，含 `{fid}`/`{fileFid}`）。 */
export function candidateTemplate2(candidate: DeeplinkCandidate2): string {
  return candidate.template;
}

export interface DeeplinkTestLogInput2 {
  caseId: number;
  outer: DeeplinkOuter;
  /** 内层模板（含占位符；便于对照）。 */
  inner: string;
  encoded: boolean;
  result?: DeeplinkAnswerResult;
}

export interface DeeplinkTestLogFields2 {
  caseId: number;
  outer: DeeplinkOuter;
  inner: string;
  innerLen: number;
  encoded: boolean;
  result?: DeeplinkAnswerResult;
}

/** 日志字段（main 落 `stage=deeplink-test`，含 innerLen 便于判断是否被截断）。 */
export function formatDeeplinkTestLog2(input: DeeplinkTestLogInput2): DeeplinkTestLogFields2 {
  return {
    caseId: input.caseId,
    outer: input.outer,
    inner: input.inner,
    innerLen: input.inner.length,
    encoded: input.encoded,
    ...(input.result ? { result: input.result } : {}),
  };
}
