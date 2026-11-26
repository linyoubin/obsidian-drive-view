/**
 * 0.2.28：Obsidian 不能预览的文件（docx/xlsx/zip/epub…）点击时「去夸克打开」。
 *
 * URL 实测结论（详见回执）：
 *   - `https://pan.quark.cn/list#/list/all/<folderFid>` 能打开该目录（用真实 rootFid 验证）；
 *   - `#/list/all/<folderFid>/<fileFid>` 与 `#/list/all/<folderFid>?fid=<fileFid>` 均无效
 *     → 因此**退一步打开所在目录**（用户已同意）。
 *
 * 这里只测纯流程（确认、30s 去重、打开/复制降级、设置关闭），UI/主插件各自注入。
 */

import { describe, expect, test } from "bun:test";

import {
  QUARK_UNPREVIEWABLE_EXTENSIONS,
  buildQuarkFolderUrl,
  createUnpreviewableOpenFlow,
  isQuarkUnpreviewable,
  quarkExtensionOf,
} from "../src/adapter/QuarkOpenExternal";

interface LogEntry {
  path: string;
  fid: string;
  domain: string;
  length: number;
  result: string;
}

function makeHost(
  options: {
    enabled?: boolean;
    confirmResult?: boolean;
    openResult?: boolean;
    copyResult?: boolean;
    now?: () => number;
    windowMs?: number;
  } = {}
) {
  const logs: LogEntry[] = [];
  const calls = { confirm: 0, open: 0, copy: 0 };
  let confirmResult = options.confirmResult ?? true;
  let openResult = options.openResult ?? true;
  let copyResult = options.copyResult ?? true;
  const host = {
    isEnabled: () => options.enabled ?? true,
    confirm: async () => {
      calls.confirm += 1;
      return confirmResult;
    },
    openExternal: async () => {
      calls.open += 1;
      return openResult;
    },
    copyLink: async () => {
      calls.copy += 1;
      return copyResult;
    },
    log: (entry: LogEntry) => logs.push(entry),
    now: options.now,
    windowMs: options.windowMs,
  };
  return {
    host,
    calls,
    logs,
    setConfirm: (value: boolean) => {
      confirmResult = value;
    },
    setOpen: (value: boolean) => {
      openResult = value;
    },
    setCopy: (value: boolean) => {
      copyResult = value;
    },
  };
}

describe("0.2.28 不可预览扩展名判定", () => {
  test("docx/xlsx/pptx/zip/rar/7z/epub → true；md/png/pdf → false", () => {
    for (const path of ["a.docx", "a.xlsx", "a.pptx", "a.doc", "a.ppt", "a.csv", "a.zip", "a.rar", "a.7z", "a.epub"]) {
      expect(isQuarkUnpreviewable(path), path).toBe(true);
    }
    for (const path of ["a.md", "a.png", "a.pdf", "a.jpg", "a.canvas", "a.txt"]) {
      expect(isQuarkUnpreviewable(path), path).toBe(false);
    }
    expect(isQuarkUnpreviewable("A.DOCX")).toBe(true);
    expect(quarkExtensionOf("docs/方案.Docx")).toBe("docx");
    expect(QUARK_UNPREVIEWABLE_EXTENSIONS).toContain("docx");
  });

  test("目录级 URL：使用 parentFid；parentFid 空时回落 rootFid/'0'", () => {
    expect(buildQuarkFolderUrl("4e5cda2d01544632b54129bf61c22abb")).toBe(
      "https://pan.quark.cn/list#/list/all/4e5cda2d01544632b54129bf61c22abb"
    );
    expect(buildQuarkFolderUrl("", "root-fid")).toBe(
      "https://pan.quark.cn/list#/list/all/root-fid"
    );
    expect(buildQuarkFolderUrl("")).toBe("https://pan.quark.cn/list#/list/all/0");
  });
});

describe("0.2.28 点击不可预览文件 → 确认 → 跳夸克", () => {
  test("docx：确认 1 次、openExternal 1 次，URL 含 parentFid；日志 result=opened", async () => {
    const { host, calls, logs } = makeHost();
    const flow = createUnpreviewableOpenFlow(host);

    const result = await flow({
      path: "docs/方案.docx",
      fid: "fid-docx",
      parentFid: "4e5cda2d01544632b54129bf61c22abb",
    });

    expect(result).toBe("opened");
    expect(calls.confirm).toBe(1);
    expect(calls.open).toBe(1);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      path: "docs/方案.docx",
      fid: "fid-docx",
      domain: "pan.quark.cn",
      result: "opened",
    });
    expect(logs[0].length).toBeGreaterThan(40);
  });

  test("同一 path 30s 内再点不重复弹确认/不重复打开；30s 后可再弹", async () => {
    let now = 1_000;
    const { host, calls } = makeHost({ now: () => now });
    const flow = createUnpreviewableOpenFlow(host);

    await flow({ path: "docs/方案.docx", fid: "f1", parentFid: "4e5c" });
    await flow({ path: "docs/方案.docx", fid: "f1", parentFid: "4e5c" });
    expect(calls.confirm).toBe(1);
    expect(calls.open).toBe(1);

    now += 30_001;
    await flow({ path: "docs/方案.docx", fid: "f1", parentFid: "4e5c" });
    expect(calls.confirm).toBe(2);
    expect(calls.open).toBe(2);
  });

  test("确认取消 → 不打开，result=cancelled", async () => {
    const { host, calls, logs } = makeHost({ confirmResult: false });
    const flow = createUnpreviewableOpenFlow(host);

    const result = await flow({ path: "docs/a.xlsx", fid: "f2", parentFid: "root" });

    expect(result).toBe("cancelled");
    expect(calls.confirm).toBe(1);
    expect(calls.open).toBe(0);
    expect(logs[0].result).toBe("cancelled");
  });

  test("openExternal 不可用 → 复制链接，result=copied", async () => {
    const { host, calls, logs } = makeHost({ openResult: false, copyResult: true });
    const flow = createUnpreviewableOpenFlow(host);

    const result = await flow({ path: "docs/a.zip", fid: "f3", parentFid: "root" });

    expect(result).toBe("copied");
    expect(calls.open).toBe(1);
    expect(calls.copy).toBe(1);
    expect(logs[0].result).toBe("copied");
  });

  test("打开与复制都失败 → result=failed（不给假成功）", async () => {
    const { host, logs } = makeHost({ openResult: false, copyResult: false });
    const flow = createUnpreviewableOpenFlow(host);

    const result = await flow({ path: "docs/a.rar", fid: "f4", parentFid: "root" });

    expect(result).toBe("failed");
    expect(logs[0].result).toBe("failed");
  });

  test("设置关闭 → 不弹确认、不打开，result=disabled", async () => {
    const { host, calls, logs } = makeHost({ enabled: false });
    const flow = createUnpreviewableOpenFlow(host);

    const result = await flow({ path: "docs/a.docx", fid: "f5", parentFid: "root" });

    expect(result).toBe("disabled");
    expect(calls.confirm).toBe(0);
    expect(calls.open).toBe(0);
    expect(logs[0].result).toBe("disabled");
  });

  test("可预览扩展名（md/pdf/png）→ 不弹、不打开、不记日志", async () => {
    const { host, calls, logs } = makeHost();
    const flow = createUnpreviewableOpenFlow(host);

    for (const path of ["a.md", "a.pdf", "a.png"]) {
      await expect(flow({ path, fid: "f", parentFid: "root" })).resolves.toBe("not-unpreviewable");
    }
    expect(calls.confirm).toBe(0);
    expect(calls.open).toBe(0);
    expect(logs).toEqual([]);
  });
});
