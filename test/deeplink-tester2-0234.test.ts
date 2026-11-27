/**
 * 0.2.34：深链测试器第二阶段 —— 内层 URL 编码变体。
 *
 * 第一阶段实测：`quark://webview?url=https://pan.quark.cn/list#/list/all/{fid}` 能**唤起 App**
 * 但位置不对（大概率落到首页）。首要怀疑：`url=` 里的裸 `#` 被当作外层 fragment 截断。
 *
 * 本阶段把内层 URL 按三种编码方式 × 两个外层 scheme 展开（≥16 条），让用户逐条实测：
 *   - `minimal`：只把 `#` 换成 `%23`（保留其它字符，最可能是对的）
 *   - `full`：整体 `encodeURIComponent`
 *   - `none`：不编码（当前失败那条，作为对照）
 *
 * 三选一结果：`ok`（位置对了）/ `wrong-place`（进了 App 但位置不对）/ `no-app`（没进 App）；
 * 只有 `ok` 才写入模板。**不创建分享**（无 `/s/`、无 share API）。
 */

import { describe, expect, test } from "bun:test";

import {
  buildDeeplinkCandidates2,
  candidateTemplate2,
  encodeInnerUrl,
  formatDeeplinkTestLog2,
  shouldSaveTemplate,
} from "../src/adapter/DeepLinkTester2";

const INFO = { fid: "dir-fid-123", fileFid: "file-fid-456" };

describe("0.2.34 内层 URL 编码器", () => {
  test("含 # 的内层 URL：minimal/full 编码后不含裸 #（有 %23），decodeURIComponent 可还原", () => {
    const inner = "https://pan.quark.cn/list#/list/all/dir-fid-123";
    const minimal = encodeInnerUrl(inner, "minimal");
    expect(minimal).not.toContain("#");
    expect(minimal).toContain("%23");
    expect(decodeURIComponent(minimal)).toBe(inner);

    const full = encodeInnerUrl(inner, "full");
    expect(full).not.toContain("#");
    expect(full).toContain("%23");
    expect(decodeURIComponent(full)).toBe(inner);

    const none = encodeInnerUrl(inner, "none");
    expect(none).toBe(inner);
  });
});

describe("0.2.34 候选生成（第二阶段）", () => {
  test("给定 fid/fileFid → ≥16 条、编号唯一；按优先级排序（最可能在前，对照在后）", () => {
    const candidates = buildDeeplinkCandidates2(INFO);
    expect(candidates.length).toBeGreaterThanOrEqual(16);
    const ids = candidates.map((candidate) => candidate.caseId);
    expect(new Set(ids).size).toBe(ids.length);

    // 优先级：前 4 条 = webview full / webview minimal / open full / open minimal（主线 hash）
    expect(candidates[0]).toMatchObject({
      caseId: 1,
      outer: "quark-webview",
      encoding: "full",
      priority: "most-likely",
      innerTemplate: "https://pan.quark.cn/list#/list/all/{fid}",
    });
    expect(candidates[1]).toMatchObject({ outer: "quark-webview", encoding: "minimal", priority: "most-likely" });
    expect(candidates[2]).toMatchObject({ outer: "quark-open", encoding: "full" });
    expect(candidates[3]).toMatchObject({ outer: "quark-open", encoding: "minimal" });

    // 备用路由（无 hash / 别名）出现在对照之前
    const noHash = candidates.findIndex((candidate) => candidate.innerTemplate.includes("?fid={fid}"));
    const control = candidates.findIndex((candidate) => candidate.encoding === "none" && candidate.outer !== "direct");
    expect(noHash).toBeGreaterThan(3);
    expect(control).toBeGreaterThan(noHash);

    // 覆盖：每条都带 outer/inner/encoded；不含分享路径
    for (const candidate of candidates) {
      if (candidate.outer !== "direct") {
        expect(candidate.url.startsWith(candidate.outerPrefix)).toBe(true);
      }
      expect(candidate.innerTemplate.length).toBeGreaterThan(10);
      expect(candidate.url).not.toMatch(/\/s(\/|$)/);
      expect(candidate.url.toLowerCase()).not.toContain("share");
    }

    // 两个外层都覆盖主线 hash；直挂 scheme 单独一条
    const mainHash = candidates.filter(
      (candidate) => candidate.innerTemplate === "https://pan.quark.cn/list#/list/all/{fid}" && candidate.encoding !== "none"
    );
    expect(mainHash.some((candidate) => candidate.outer === "quark-webview")).toBe(true);
    expect(mainHash.some((candidate) => candidate.outer === "quark-open")).toBe(true);
    expect(candidates.some((candidate) => candidate.outer === "direct")).toBe(true);
  });

  test("无 fid → 空数组（不崩）", () => {
    expect(buildDeeplinkCandidates2({ fid: "", fileFid: "" })).toEqual([]);
  });

  test("确认可用 → 模板是「外层 + 编码后的内层」，且含占位符", () => {
    const candidates = buildDeeplinkCandidates2(INFO);
    const encoded = candidates.find(
      (candidate) =>
        candidate.outer === "quark-webview" &&
        candidate.innerTemplate.includes("/list#/list/all/{fid}") &&
        candidate.encoding === "full"
    )!;
    const template = candidateTemplate2(encoded);
    expect(template.startsWith("quark://webview?url=")).toBe(true);
    expect(template).toContain("{fid}");
    expect(template).not.toContain("#"); // 模板里也不能留裸 #（会再次被截断）
    expect(template).toContain("%23");

    // 对照组（不编码）保留裸 #，用于证明编码差异
    const raw = candidates.find((candidate) => candidate.encoding === "none" && candidate.outer !== "direct")!;
    expect(candidateTemplate2(raw)).toContain("#");
  });
});

describe("0.2.34 四选一与日志", () => {
  test("只有 ok 才写模板（wrong-place / blank / no-app 不写）", () => {
    expect(shouldSaveTemplate("ok")).toBe(true);
    expect(shouldSaveTemplate("wrong-place")).toBe(false);
    expect(shouldSaveTemplate("blank")).toBe(false);
    expect(shouldSaveTemplate("no-app")).toBe(false);
  });

  test("日志字段齐全：case/outer/inner/innerLen/encoded/result", () => {
    const click = formatDeeplinkTestLog2({
      caseId: 3,
      outer: "quark-webview",
      inner: "https://pan.quark.cn/list#/list/all/{fid}",
      encoded: true,
    });
    expect(click).toMatchObject({ caseId: 3, outer: "quark-webview", encoded: true });
    expect(click.inner).toContain("{fid}");
    expect(click.innerLen).toBe("https://pan.quark.cn/list#/list/all/{fid}".length);

    const answer = formatDeeplinkTestLog2({
      caseId: 3,
      outer: "quark-webview",
      inner: "https://pan.quark.cn/list#/list/all/{fid}",
      encoded: true,
      result: "blank",
    });
    expect(answer.result).toBe("blank");
  });
});
