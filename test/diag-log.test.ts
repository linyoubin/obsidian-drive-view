/**
 * 诊断日志单测（0.2.3 A5/A6）：行格式、脱敏、200 字符截断、200 KB 环形截断、导出取尾行。
 *
 * 本文件不需要 mock `obsidian`：diagLog 只依赖注入的 adapter 接口。
 */

import { describe, expect, test } from "bun:test";

import {
  DIAG_LOG_MAX_BYTES,
  DIAG_LOG_PATH,
  DIAG_MSG_MAX,
  DiagLogger,
  formatDiagLine,
  redactDiagMessage,
  tailDiagLines,
  truncateDiagLog,
} from "../src/utils/diagLog";

const fixedNow = new Date("2026-11-20T08:00:00.000Z");

describe("diagLog：行格式与脱敏（A5）", () => {
  test("行格式：ISO 时间 + level/stage/path/fid/msg 字段齐全", () => {
    const line = formatDiagLine(
      { stage: "read", path: "/技术/笔记.md", fid: "fid123", message: "boom" },
      fixedNow
    );
    expect(line).toBe("[2026-11-20T08:00:00.000Z] level=error stage=read path=/技术/笔记.md fid=fid123 msg=boom");
  });

  test("根路径显示 `/`、缺 fid 显示 `-`", () => {
    const line = formatDiagLine({ stage: "getResourcePath", path: "", message: "x" }, fixedNow);
    expect(line).toContain("path=/ fid=- ");
  });

  test("六个 stage 都能格式化（read/readBinary/getResourcePath/download/list/sort）", () => {
    const stages = ["read", "readBinary", "getResourcePath", "download", "list", "sort"] as const;
    for (const stage of stages) {
      expect(formatDiagLine({ stage, path: "/a.md", fid: "f", message: "x" }, fixedNow)).toContain(
        `stage=${stage}`
      );
    }
  });

  test("msg 截断到 200 字符，且换行被压成空格", () => {
    const line = formatDiagLine(
      { stage: "download", path: "/a.md", fid: "1", message: `${"长".repeat(500)}\n第二行` },
      fixedNow
    );
    const msg = line.split("msg=")[1];
    expect(msg.length).toBe(DIAG_MSG_MAX);
    expect(line).not.toContain("\n");
  });

  test("脱敏：cookie / token 的 value 不出现在日志里", () => {
    expect(redactDiagMessage("__pus=SECRET123; __kps=abc; cookie=C=1; token=TOK")).toBe(
      "__pus=***; __kps=***; cookie=***; token=***"
    );
    const line = formatDiagLine(
      { stage: "read", path: "/a.md", fid: "1", message: "401 __pus=SECRET123" },
      fixedNow
    );
    expect(line).not.toContain("SECRET123");
    expect(line).toContain("__pus=***");
  });
});

describe("diagLog：环形截断与导出（A6/A7）", () => {
  test("超过 200 KB 只保留尾部，且从整行边界开始、UTF-8 字节数不超上限", () => {
    const line = `[2026-11-20T08:00:00.000Z] level=error stage=read path=/长路径.md fid=x msg=${"错".repeat(80)}\n`;
    const text = line.repeat(4000); // 远超 200 KB
    const kept = truncateDiagLog(text);

    const bytes = new TextEncoder().encode(kept).length;
    expect(bytes).toBeLessThanOrEqual(DIAG_LOG_MAX_BYTES);
    expect(kept.length).toBeGreaterThan(0);
    // 首行是完整行（不以半行开头）
    expect(kept.startsWith("[2026-11-20T08:00:00.000Z] level=error ")).toBe(true);
    // 尾行保留
    expect(kept.endsWith("\n")).toBe(true);
    // 未超限时原样返回
    expect(truncateDiagLog("abc\n")).toBe("abc\n");
  });

  test("自定义上限（小 maxBytes）同样生效", () => {
    const kept = truncateDiagLog("1111\n2222\n3333\n", 12);
    expect(new TextEncoder().encode(kept).length).toBeLessThanOrEqual(12);
    expect(kept).toContain("3333");
  });

  test("tailDiagLines：只取最近 200 行，空尾行不计", () => {
    const text = Array.from({ length: 500 }, (_, i) => `line${i}`).join("\n") + "\n";
    const tail = tailDiagLines(text).split("\n");
    expect(tail.length).toBe(200);
    expect(tail[0]).toBe("line300");
    expect(tail[199]).toBe("line499");
    expect(tailDiagLines("", 10)).toBe("");
  });

  test("日志路径固定在插件目录（可被「导出诊断」读到）", () => {
    expect(DIAG_LOG_PATH).toBe(".obsidian/plugins/drive-view/quark-debug.log");
  });
});

describe("diagLog：追加写入（不崩、不覆盖、串行）", () => {
  function mockAdapter(initial = "") {
    const files = new Map<string, string>([[DIAG_LOG_PATH, initial]]);
    return {
      files,
      async exists(path: string) {
        return files.has(path);
      },
      async read(path: string) {
        const value = files.get(path);
        if (value === undefined) throw new Error("ENOENT");
        return value;
      },
      async write(path: string, data: string) {
        files.set(path, data);
      },
    };
  }

  test("两条错误串行追加，顺序不乱", async () => {
    const adapter = mockAdapter();
    const logger = new DiagLogger({ adapter, now: () => fixedNow });
    logger.log({ stage: "read", path: "/a.md", fid: "1", message: "first" });
    logger.log({ stage: "download", path: "/a.md", fid: "1", message: "second" });
    await logger.flush();

    const text = adapter.files.get(DIAG_LOG_PATH) ?? "";
    const lines = text.trim().split("\n");
    expect(lines.length).toBe(2);
    expect(lines[0]).toContain("stage=read");
    expect(lines[0]).toContain("msg=first");
    expect(lines[1]).toContain("stage=download");
    expect(lines[1]).toContain("msg=second");
  });

  test("读失败当作空日志继续写；写失败只回调 onError 不抛出", async () => {
    const errors: unknown[] = [];
    const readFail = {
      exists: async () => true,
      read: async () => {
        throw new Error("read fail");
      },
      write: async () => undefined,
    };
    const logger = new DiagLogger({ adapter: readFail, now: () => fixedNow });
    logger.log({ stage: "list", path: "/", message: "boom" });
    await logger.flush(); // 不抛

    let wrote = "";
    const writeFail = {
      exists: async () => false,
      read: async () => "",
      write: async (_path: string, data: string) => {
        wrote = data;
        throw new Error("write fail");
      },
    };
    const logger2 = new DiagLogger({ adapter: writeFail, onError: (e) => errors.push(e) });
    logger2.log({ stage: "list", path: "/", message: "boom" });
    await logger2.flush();
    expect(wrote).toContain("stage=list");
    expect(errors.length).toBe(1);
  });
});

// ------------------------------------------------------------------ 结构化字段（0.2.10 埋点）

describe("diagLog：结构化字段（0.2.10）", () => {
  test("fields 按插入顺序写在 fid 后、msg 前，并做脱敏与截断", () => {
    const line = formatDiagLine(
      {
        level: "info",
        stage: "download",
        path: "/技术/a.md",
        fid: "f1",
        message: "",
        fields: { hop: 1, status: 200, code: 0, urlLen: 321, cookie: "should-redact=value" },
      },
      fixedNow
    );
    expect(line).toContain("stage=download path=/技术/a.md fid=f1 hop=1 status=200 code=0 urlLen=321");
    expect(line).toContain("cookie=");
    expect(line).not.toContain("should-redact");
    expect(line.endsWith("msg=")).toBe(true);
  });

  test("字段值去换行并截断 120 字符（0.2.18：不再有 sample 正文字段）", () => {
    const value = "第一行\n第二行" + "x".repeat(200);
    const line = formatDiagLine(
      { level: "info", stage: "decode", path: "/a.md", fid: "f", message: "", fields: { bytes: 10, chars: 90, firstBytes: "e7acac", note: value } },
      fixedNow
    );
    expect(line).not.toContain("\n");
    expect(line).not.toContain(" sample=");
    const field = line.split(" note=")[1];
    expect(field.length).toBeLessThanOrEqual(120 + " msg=".length);
  });
});
