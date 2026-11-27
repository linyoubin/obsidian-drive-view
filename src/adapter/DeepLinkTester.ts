/**
 * 0.2.33：深链测试器（纯逻辑，UI 由 main 注入）。
 *
 * 现状（2026-11-27 取证）：
 *   - AASA 只登记「夸克网盘」App（`com.quark.clouddrive` 三个变体），paths `/quarkcloud/*`；
 *   - 用户的「夸克-AI旗舰应用」= `com.quark.browser`，不在名单里 → 没有任何已证实可直达它的链接。
 *
 * 所以提供候选清单让用户在手机上逐个实测；确认可用的那条 → 自动写成深链模板。
 * **不创建分享**：候选全部是「打开」类链接，不含 `/s/`，不调任何分享接口。
 */

/** AASA 中登记的全部 appID（原始 JSON 见回执；三个变体指向同一 paths `/quarkcloud/*`）。 */
export const DEEPLINK_APP_IDS: readonly string[] = [
  "288Z59935G.com.quark.clouddrive.rc7",
  "YBKAWXQ2LS.com.quark.clouddrive.ent",
  "6TFXDT6MK5.com.quark.clouddrive",
];

export interface DeeplinkTestInfo {
  /** 所在目录 fid（parentFid）。 */
  fid: string;
  /** 文件自身 fid。 */
  fileFid: string;
  /** 库根 fid。 */
  rootFid: string;
}

export type DeeplinkCandidateKind = "folder" | "file" | "web" | "scheme";

export interface DeeplinkCandidate {
  /** 稳定编号（日志 `case=<n>` 从 1 开始）。 */
  caseId: number;
  id: string;
  kind: DeeplinkCandidateKind;
  /** 列表里显示的名称（含来源依据）。 */
  label: string;
  /** 含占位符的模板（`{fid}` / `{fileFid}`），确认可用后直接写入设置。 */
  template: string;
  /** 已替换成实际 id 的可点击 URL。 */
  url: string;
}

/** 是否具备运行条件（必须有目录 fid；未挂载时 fid 为空）。 */
export function canRunDeeplinkTest(info: DeeplinkTestInfo): boolean {
  return String(info?.fid ?? "").trim().length > 0;
}

function render(template: string, info: DeeplinkTestInfo): string {
  return template
    .replace(/\{fid\}/g, encodeURIComponent(String(info.fid ?? "").trim()))
    .replace(/\{fileFid\}/g, encodeURIComponent(String(info.fileFid ?? "").trim()));
}

/**
 * 生成候选清单（≥8 条，每条只打开一种格式）。
 *
 * 不含 `/s/` 分享链接；`quark://` / `quarkcloud://` 属于待验证的 scheme 候选（未证实可用）。
 */
export function buildDeeplinkCandidates(info: DeeplinkTestInfo): DeeplinkCandidate[] {
  if (!canRunDeeplinkTest(info)) return [];

  const rows: Array<Omit<DeeplinkCandidate, "caseId" | "id" | "url">> = [
    {
      kind: "folder",
      label: "Universal Link（AASA 前缀 /quarkcloud/）：目录 fid",
      template: "https://pan.quark.cn/quarkcloud/{fid}",
    },
    {
      kind: "file",
      label: "Universal Link（AASA 前缀 /quarkcloud/）：文件 fid",
      template: "https://pan.quark.cn/quarkcloud/{fileFid}",
    },
    {
      kind: "web",
      label: "网页目录（hash 路由）：/list#/list/all/{fid}",
      template: "https://pan.quark.cn/list#/list/all/{fid}",
    },
    {
      kind: "web",
      label: "网页目录（query 形式）：/list?fid={fid}",
      template: "https://pan.quark.cn/list?fid={fid}",
    },
    {
      kind: "scheme",
      label: "quark://webview 包裹网页目录（未证实）",
      template: "quark://webview?url=https://pan.quark.cn/list#/list/all/{fid}",
    },
    {
      kind: "scheme",
      label: "quarkcloud://webview 包裹网页目录（未证实）",
      template: "quarkcloud://webview?url=https://pan.quark.cn/list#/list/all/{fid}",
    },
    {
      kind: "scheme",
      label: "quark://open 包裹网页目录（未证实）",
      template: "quark://open?url=https://pan.quark.cn/list#/list/all/{fid}",
    },
  ];

  // AASA 里每个 appID 的 https 前缀各列一条（路径语义相同，但便于确认是哪个 App 接管）
  for (const appId of DEEPLINK_APP_IDS) {
    rows.push({
      kind: "folder",
      label: `AASA appID ${appId} · /quarkcloud/{fid}`,
      template: "https://pan.quark.cn/quarkcloud/{fid}",
    });
  }

  return rows.map((row, index) => ({
    ...row,
    caseId: index + 1,
    id: `case-${index + 1}`,
    url: render(row.template, { fid: String(info.fid).trim(), fileFid: String(info.fileFid ?? "").trim(), rootFid: String(info.rootFid ?? "").trim() }),
  })).filter((candidate) => !candidate.url.includes("{"));
}

/** 用户确认「进到 App 了」后写入设置的模板（含 `{fid}` / `{fileFid}` 占位符）。 */
export function candidateTemplate(candidate: DeeplinkCandidate): string {
  return candidate.template;
}

export interface DeeplinkTestLogInput {
  caseId: number;
  /** 用模板（不打码，便于对照），日志里写 `url=`。 */
  template: string;
  opened: boolean;
  note: string;
  result?: "app" | "browser" | "nothing";
}

/** 生成日志字段（main 落 `stage=deeplink-test`）。 */
export function formatDeeplinkTestLog(input: DeeplinkTestLogInput): {
  caseId: number;
  url: string;
  opened: boolean;
  note: string;
  result?: "app" | "browser" | "nothing";
} {
  return {
    caseId: input.caseId,
    url: input.template,
    opened: input.opened,
    note: input.note,
    ...(input.result ? { result: input.result } : {}),
  };
}
