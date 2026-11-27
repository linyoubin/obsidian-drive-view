/**
 * 0.2.35：控制组测试（判断「URL 形式问题」还是「App 不支持外部 webview」）。
 *
 * 0.2.34 的 19 条（含整体编码/只编 #/无 hash/直挂）全部空白或报错 → 不再微调目标 URL，
 * 先用最简单的合法页面做控制组：
 *   A `quark://webview?url=` + 编码后的 https://www.baidu.com
 *   B `quark://webview?url=` + 编码后的 https://pan.quark.cn（只有域名、无路径无 hash）
 *   C `quark://open?url=`    + 编码后的 https://www.baidu.com
 * 再测参数名变体（u / target / 带斜杠）、scheme 变体（quarkbrowser:// / quark://browser / quark://home），
 * 最后放一条目标 URL（已编码）作为「已知失败」对照。
 *
 * 判定：
 *   - 控制组也空白/没进 App → `control-failed`：该 App 不允许从外部深链打开任意网页，直达不可行；
 *   - 控制组正常、目标空白   → `target-failed`：被登录/来源校验挡住，可继续收敛参数；
 *   - 命中目标               → `ok`（只有这种才写模板）。
 *
 * 不创建分享（无 `/s/`、无 share API）。
 */

export type ControlGroup = "control" | "variant" | "target";

export interface ControlCandidate {
  caseId: number;
  id: string;
  group: ControlGroup;
  outer: string;
  outerLabel: string;
  /** 内层 URL（控制组是固定页面；变体/目标是模板）。 */
  innerTemplate: string;
  encoded: boolean;
  /** 实际发出的完整串。 */
  url: string;
  /** 确认可用后写入的模板（控制组为空，不写）。 */
  template: string;
  label: string;
}

export function encodeInner(inner: string): string {
  return encodeURIComponent(inner).replace(/%7Bfid%7D/gi, "{fid}").replace(/%7BfileFid%7D/gi, "{fileFid}");
}

function fill(text: string, fid: string, fileFid: string): string {
  return text.replace(/\{fid\}/g, encodeURIComponent(fid)).replace(/\{fileFid\}/g, encodeURIComponent(fileFid));
}

const TARGET_TEMPLATE = "https://pan.quark.cn/list#/list/all/{fid}";

export function buildControlCandidates(info: { fid: string; fileFid: string }): ControlCandidate[] {
  const fid = String(info?.fid ?? "").trim();
  if (!fid) return [];
  const fileFid = String(info?.fileFid ?? "").trim();
  const targetEncoded = encodeInner(TARGET_TEMPLATE);
  const targetInner = fill(TARGET_TEMPLATE, fid, fileFid);
  const targetEncodedActual = encodeURIComponent(targetInner);
  const baiduEncoded = encodeURIComponent("https://www.baidu.com");
  const panEncoded = encodeURIComponent("https://pan.quark.cn");

  const rows: Array<Omit<ControlCandidate, "caseId" | "id">> = [
    {
      group: "control",
      outer: "quark-webview",
      outerLabel: "quark://webview?url=",
      innerTemplate: "https://www.baidu.com",
      encoded: true,
      url: `quark://webview?url=${baiduEncoded}`,
      template: "",
      label: "控制组 A：最简单合法页面（baidu，整体编码）",
    },
    {
      group: "control",
      outer: "quark-webview",
      outerLabel: "quark://webview?url=",
      innerTemplate: "https://pan.quark.cn",
      encoded: true,
      url: `quark://webview?url=${panEncoded}`,
      template: "",
      label: "控制组 B：只有域名/无路径（pan.quark.cn，整体编码）",
    },
    {
      group: "control",
      outer: "quark-open",
      outerLabel: "quark://open?url=",
      innerTemplate: "https://www.baidu.com",
      encoded: true,
      url: `quark://open?url=${baiduEncoded}`,
      template: "",
      label: "控制组 C：open + baidu（整体编码）",
    },
    {
      group: "variant",
      outer: "quark-webview",
      outerLabel: "quark://webview?url=",
      innerTemplate: "https://pan.quark.cn",
      encoded: false,
      url: "quark://webview?url=https://pan.quark.cn",
      template: "",
      label: "变体 D：不编码、无 #（pan.quark.cn）",
    },
    {
      group: "variant",
      outer: "quark-webview",
      outerLabel: "quark://webview?u=",
      innerTemplate: TARGET_TEMPLATE,
      encoded: true,
      url: `quark://webview?u=${targetEncodedActual}`,
      template: `quark://webview?u=${targetEncoded}`,
      label: "变体 E1：参数名 u= + 目标（整体编码）",
    },
    {
      group: "variant",
      outer: "quark-webview",
      outerLabel: "quark://webview?target=",
      innerTemplate: TARGET_TEMPLATE,
      encoded: true,
      url: `quark://webview?target=${targetEncodedActual}`,
      template: `quark://webview?target=${targetEncoded}`,
      label: "变体 E2：参数名 target= + 目标（整体编码）",
    },
    {
      group: "variant",
      outer: "quark-webview",
      outerLabel: "quark://webview/?url=",
      innerTemplate: TARGET_TEMPLATE,
      encoded: true,
      url: `quark://webview/?url=${targetEncodedActual}`,
      template: `quark://webview/?url=${targetEncoded}`,
      label: "变体 E3：带斜杠 /?url= + 目标（整体编码）",
    },
    {
      group: "variant",
      outer: "quarkbrowser",
      outerLabel: "quarkbrowser://webview?url=",
      innerTemplate: TARGET_TEMPLATE,
      encoded: true,
      url: `quarkbrowser://webview?url=${targetEncodedActual}`,
      template: `quarkbrowser://webview?url=${targetEncoded}`,
      label: "变体 F1：scheme quarkbrowser:// + 目标（整体编码）",
    },
    {
      group: "variant",
      outer: "quark-browser",
      outerLabel: "quark://browser?url=",
      innerTemplate: TARGET_TEMPLATE,
      encoded: true,
      url: `quark://browser?url=${targetEncodedActual}`,
      template: `quark://browser?url=${targetEncoded}`,
      label: "变体 F2：quark://browser?url= + 目标（整体编码）",
    },
    {
      group: "variant",
      outer: "quark-home",
      outerLabel: "quark://home",
      innerTemplate: "",
      encoded: false,
      url: "quark://home",
      template: "",
      label: "变体 F3：quark://home（仅验证 scheme 是否有效）",
    },
    {
      group: "target",
      outer: "quark-webview",
      outerLabel: "quark://webview?url=",
      innerTemplate: TARGET_TEMPLATE,
      encoded: true,
      url: `quark://webview?url=${targetEncodedActual}`,
      template: `quark://webview?url=${targetEncoded}`,
      label: "目标 G：0.2.34 已知失败那条（webview + 目标，整体编码）",
    },
    {
      group: "target",
      outer: "quark-open",
      outerLabel: "quark://open?url=",
      innerTemplate: TARGET_TEMPLATE,
      encoded: true,
      url: `quark://open?url=${targetEncodedActual}`,
      template: `quark://open?url=${targetEncoded}`,
      label: "目标 G2：open + 目标（整体编码，对照）",
    },
  ];

  return rows.map((row, index) => ({ ...row, caseId: index + 1, id: `case-${index + 1}` }));
}

/** 确认可用后写入的模板；控制组没有模板（返回 `""`，主流程不会写）。 */
export function candidateTemplate3(candidate: ControlCandidate): string {
  return candidate.template ?? "";
}

export type DeeplinkVerdict = "ok" | "control-failed" | "target-failed";

/**
 * 三态判定：
 *   - 控制组非 ok → `control-failed`（App 不允许外部网页深链，直达不可行）；
 *   - 目标/变体 ok → `ok`；
 *   - 目标/变体非 ok 且控制组也失败 → `control-failed`；否则 `target-failed`。
 */
export function classifyDeeplinkTestResult(input: {
  group: ControlGroup;
  result: "ok" | "wrong-place" | "blank" | "no-app";
  controlFailed?: boolean;
}): DeeplinkVerdict {
  if (input.result === "ok") return "ok";
  if (input.group === "control") return "control-failed";
  return input.controlFailed ? "control-failed" : "target-failed";
}

export interface DeeplinkTestLogInput3 {
  caseId: number;
  group: ControlGroup;
  outer: string;
  inner: string;
  encoded: boolean;
  result?: "ok" | "wrong-place" | "blank" | "no-app";
}

export interface DeeplinkTestLogFields3 {
  caseId: number;
  group: ControlGroup;
  outer: string;
  inner: string;
  innerLen: number;
  encoded: boolean;
  result?: "ok" | "wrong-place" | "blank" | "no-app";
}

export function formatDeeplinkTestLog3(input: DeeplinkTestLogInput3): DeeplinkTestLogFields3 {
  return {
    caseId: input.caseId,
    group: input.group,
    outer: input.outer,
    inner: input.inner,
    innerLen: input.inner.length,
    encoded: input.encoded,
    ...(input.result ? { result: input.result } : {}),
  };
}
