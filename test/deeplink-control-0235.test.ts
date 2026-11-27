/**
 * 0.2.35：控制组测试 —— 判断是「URL 形式问题」还是「App 根本不允许外部 webview」。
 *
 * 0.2.34 的 19 条全部空白/报错 → 用最简单的合法页面做控制组：
 *   A `quark://webview?url=` + 整体编码的 https://www.baidu.com
 *   B `quark://webview?url=` + 整体编码的 https://pan.quark.cn（只有域名）
 *   C `quark://open?url=` + 同 A
 * 判定：
 *   - 控制组也空白 → `control-failed`：该 App 不允许从外部深链打开任意网页，直达不可行；
 *   - 控制组正常、目标空白 → `target-failed`：被登录/来源校验挡住，继续收敛参数；
 *   - 目标命中 → `ok`：立即写模板。
 */

import { describe, expect, test } from "bun:test";

import {
  buildControlCandidates,
  candidateTemplate3,
  classifyDeeplinkTestResult,
  formatDeeplinkTestLog3,
} from "../src/adapter/DeepLinkTester3";

const INFO = { fid: "dir-fid-123", fileFid: "file-fid-456" };

describe("0.2.35 控制组候选生成", () => {
  test("≥10 条、编号唯一，含 baidu / 无路径域名 / 参数名变体 / scheme 变体 / 目标对照", () => {
    const candidates = buildControlCandidates(INFO);
    expect(candidates.length).toBeGreaterThanOrEqual(10);
    const ids = candidates.map((candidate) => candidate.caseId);
    expect(new Set(ids).size).toBe(ids.length);

    const urls = candidates.map((candidate) => candidate.url).join("\n");
    expect(urls).toContain("www.baidu.com");
    expect(urls).toContain("https://pan.quark.cn"); // 无路径控制组
    expect(candidates.filter((candidate) => candidate.group === "control").length).toBeGreaterThanOrEqual(3);
    expect(urls).toContain("quark://webview?u=");
    expect(urls).toContain("quark://webview?target=");
    expect(urls).toContain("quark://webview/?url=");
    expect(urls).toContain("quarkbrowser://webview?url=");
    expect(urls).toContain("quark://browser?url=");
    expect(urls).toContain("quark://home");
    // 目标对照（已知失败）
    expect(candidates.some((candidate) => candidate.group === "target")).toBe(true);
    // 无分享路径
    for (const candidate of candidates) {
      expect(candidate.url).not.toMatch(/\/s(\/|$)/);
      expect(candidate.url.toLowerCase()).not.toContain("share");
    }
  });

  test("无 fid → 空数组（不崩）", () => {
    expect(buildControlCandidates({ fid: "", fileFid: "" })).toEqual([]);
  });

  test("控制组没有文件模板；目标/变体里含 {fid} 的才有模板", () => {
    const candidates = buildControlCandidates(INFO);
    for (const candidate of candidates.filter((item) => item.group === "control")) {
      expect(candidateTemplate3(candidate)).toBe("");
    }
    const target = candidates.find((candidate) => candidate.group === "target" && candidate.template.includes("{fid}"))!;
    expect(candidateTemplate3(target)).toContain("{fid}");
    expect(candidateTemplate3(target)).toContain("%23");
  });
});

describe("0.2.35 三态判定", () => {
  test("控制组空白 → control-failed；目标空白（控制组正常）→ target-failed；目标 ok → ok", () => {
    expect(classifyDeeplinkTestResult({ group: "control", result: "blank" })).toBe("control-failed");
    expect(classifyDeeplinkTestResult({ group: "control", result: "no-app" })).toBe("control-failed");
    expect(classifyDeeplinkTestResult({ group: "target", result: "blank", controlFailed: false })).toBe("target-failed");
    expect(classifyDeeplinkTestResult({ group: "variant", result: "wrong-place", controlFailed: false })).toBe("target-failed");
    expect(classifyDeeplinkTestResult({ group: "target", result: "ok" })).toBe("ok");
    // 控制组 ok 也是 ok（说明 App 能外部打开网页），但不会写模板
    expect(classifyDeeplinkTestResult({ group: "control", result: "ok" })).toBe("ok");
  });

  test("日志字段含 group：case/group/outer/inner/encoded/result", () => {
    const entry = formatDeeplinkTestLog3({
      caseId: 2,
      group: "control",
      outer: "quark-webview",
      inner: "https://www.baidu.com",
      encoded: true,
      result: "blank",
    });
    expect(entry).toMatchObject({ caseId: 2, group: "control", encoded: true, result: "blank" });
    expect(entry.innerLen).toBe("https://www.baidu.com".length);
  });
});
