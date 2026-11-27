/**
 * 0.2.33：深链测试器（调试用）。
 *
 * 背景：用户的「夸克-AI旗舰应用」= com.quark.browser，不在 pan.quark.cn 的 AASA 里；
 * 目前没有任何**已证实**可直达到它的链接。与其猜，不如给用户在手机上逐个实测的入口：
 * 每条候选都只打开一种格式，用户回答「进到 App 了吗」，确认可用的那条自动写成深链模板。
 *
 * 硬约束：**不创建分享**（不调 share API、不生成 `/s/` 链接）；候选全部是「打开」类链接。
 */

import { describe, expect, test } from "bun:test";

import {
  DEEPLINK_APP_IDS,
  buildDeeplinkCandidates,
  candidateTemplate,
  canRunDeeplinkTest,
  formatDeeplinkTestLog,
} from "../src/adapter/DeepLinkTester";

const INFO = { fid: "dir-fid-123", fileFid: "file-fid-456", rootFid: "root-fid" };

describe("0.2.33 深链候选生成器", () => {
  test("给定 fid/fileFid/rootFid → ≥8 条候选，每条只有一种格式", () => {
    const candidates = buildDeeplinkCandidates(INFO);
    expect(candidates.length).toBeGreaterThanOrEqual(8);
    const ids = candidates.map((candidate) => candidate.id);
    expect(new Set(ids).size).toBe(ids.length); // id 唯一

    for (const candidate of candidates) {
      expect(candidate.url.length).toBeGreaterThan(10);
      expect(candidate.template).toContain(candidate.kind === "folder" ? "{fid}" : "");
      // 不允许出现分享链接（/s/），也不允许 share 相关路径
      expect(candidate.url).not.toMatch(/\/s(\/|$)/);
      expect(candidate.url.toLowerCase()).not.toContain("share");
    }
    // 必含的格式族
    const urls = candidates.map((candidate) => candidate.url).join("\n");
    expect(urls).toContain("https://pan.quark.cn/quarkcloud/dir-fid-123");
    expect(urls).toContain("https://pan.quark.cn/quarkcloud/file-fid-456");
    expect(urls).toContain("https://pan.quark.cn/list#/list/all/dir-fid-123");
    expect(urls).toContain("https://pan.quark.cn/list?fid=dir-fid-123");
    expect(urls).toContain("quark://webview?url=");
    expect(urls).toContain("quarkcloud://webview?url=");
    expect(urls).toContain("quark://open?url=");
    // AASA 里三个 appID 的 https 前缀各列一条
    for (const appId of DEEPLINK_APP_IDS) {
      expect(candidates.some((candidate) => candidate.label.includes(appId))).toBe(true);
    }
  });

  test("无 fid / 未挂载 → 不可运行，候选为空数组（不崩）", () => {
    expect(canRunDeeplinkTest({ fid: "", fileFid: "", rootFid: "" })).toBe(false);
    expect(buildDeeplinkCandidates({ fid: "", fileFid: "", rootFid: "" })).toEqual([]);
    expect(canRunDeeplinkTest(INFO)).toBe(true);
  });

  test("确认可用 → candidateTemplate 返回含 {fid}/{fileFid} 的模板", () => {
    const candidates = buildDeeplinkCandidates(INFO);
    const folder = candidates.find((candidate) => candidate.url.includes("/quarkcloud/dir-fid-123"))!;
    expect(candidateTemplate(folder)).toBe("https://pan.quark.cn/quarkcloud/{fid}");

    const file = candidates.find((candidate) => candidate.url.includes("/quarkcloud/file-fid-456"))!;
    expect(candidateTemplate(file)).toBe("https://pan.quark.cn/quarkcloud/{fileFid}");

    const scheme = candidates.find((candidate) => candidate.url.startsWith("quark://webview"))!;
    expect(candidateTemplate(scheme)).toContain("{fid}");
  });
});

describe("0.2.33 日志字段", () => {
  test("点击与回答都记 case/url/opened/result（完整字段）", () => {
    const click = formatDeeplinkTestLog({ caseId: 3, template: "https://pan.quark.cn/list#/list/all/{fid}", opened: true, note: "click" });
    expect(click).toMatchObject({ caseId: 3, opened: true, note: "click" });
    expect(click.url).toBe("https://pan.quark.cn/list#/list/all/{fid}");

    const answer = formatDeeplinkTestLog({
      caseId: 3,
      template: "https://pan.quark.cn/list#/list/all/{fid}",
      opened: true,
      note: "answer",
      result: "app",
    });
    expect(answer.result).toBe("app");
  });
});
