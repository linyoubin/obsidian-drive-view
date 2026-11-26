/**
 * 0.2.18 B2：`configDir` 不再硬编码 `.obsidian`。
 *
 *   - adapter 用注入的 configDir 判定转发：`.config/**` 走 base，`.obsidian/**` 不转发；
 *   - 诊断日志路径随 configDir 变化（`diagLogPath(configDir)`）。
 */

import { describe, expect, test } from "bun:test";

import {
  QUARK_ADAPTER_NAME,
  QuarkReadOnlyAdapter,
  DEFAULT_PLUGIN_DIR,
} from "../src/adapter/QuarkReadOnlyAdapter";
import type { IndexEntry } from "../src/store/IndexStore";
import * as diag from "../src/utils/diagLog";

const entries: IndexEntry[] = [
  { path: "notes/a.md", type: "file", fid: "fa", parentFid: "", size: 9, mtime: 1 },
];

interface BaseCalls {
  calls: Array<{ name: string; args: unknown[] }>;
}

function makeBase(): BaseCalls & Record<string, unknown> {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const base = {
    getName: () => "FileSystemAdapter",
    getBasePath: () => "/vault",
    getFullPath: (path: string) => `/vault/${path}`,
    getResourcePath: (path: string) => `app://local/${path}`,
    exists: async (path: string) => {
      calls.push({ name: "exists", args: [path] });
      return true;
    },
    stat: async (path: string) => {
      calls.push({ name: "stat", args: [path] });
      return { type: "file" as const, ctime: 1, mtime: 2, size: 3 };
    },
    list: async (path: string) => {
      calls.push({ name: "list", args: [path] });
      return { files: [], folders: [] };
    },
    read: async (path: string) => {
      calls.push({ name: "read", args: [path] });
      return "base-content";
    },
    readBinary: async (path: string) => {
      calls.push({ name: "readBinary", args: [path] });
      return new ArrayBuffer(1);
    },
    write: async (path: string, data: string) => {
      calls.push({ name: "write", args: [path, data] });
    },
    writeBinary: async (path: string, data: ArrayBuffer) => {
      calls.push({ name: "writeBinary", args: [path, data] });
    },
    append: async (path: string, data: string) => {
      calls.push({ name: "append", args: [path, data] });
    },
    appendBinary: async (path: string, data: ArrayBuffer) => {
      calls.push({ name: "appendBinary", args: [path, data] });
    },
    process: async (path: string, fn: (data: string) => string) => {
      calls.push({ name: "process", args: [path] });
      return fn("x");
    },
    mkdir: async (path: string) => {
      calls.push({ name: "mkdir", args: [path] });
    },
    rmdir: async (path: string, recursive: boolean) => {
      calls.push({ name: "rmdir", args: [path, recursive] });
    },
    remove: async (path: string) => {
      calls.push({ name: "remove", args: [path] });
    },
    rename: async (path: string, next: string) => {
      calls.push({ name: "rename", args: [path, next] });
    },
    copy: async (path: string, next: string) => {
      calls.push({ name: "copy", args: [path, next] });
    },
    trashSystem: async (path: string) => {
      calls.push({ name: "trashSystem", args: [path] });
      return true;
    },
    trashLocal: async (path: string) => {
      calls.push({ name: "trashLocal", args: [path] });
    },
  };
  return { calls, ...base };
}

function makeAdapter(configDir: string) {
  const base = makeBase();
  const adapter = new QuarkReadOnlyAdapter({
    index: { entries },
    cache: {
      has: () => false,
      get: () => null,
      getResourceUrl: () => "",
      put: () => ({ cached: true }),
      enqueuePrefetch: () => undefined,
    },
    client: { downloadFile: async () => new TextEncoder().encode("x").buffer as ArrayBuffer },
    baseAdapter: base as never,
    configDir,
    pluginDir: `${configDir}/plugins/drive-view`,
    allowPrefetch: () => false,
  });
  return { adapter, base };
}

describe("0.2.18 B2 configDir 贯通", () => {
  test("configDir='.config'：`.config/**` 走 base 转发，`.obsidian/**` 不转发", async () => {
    const { adapter, base } = makeAdapter(".config");

    expect(await adapter.exists(".config/app.json")).toBe(true);
    expect(await adapter.exists(".config/plugins/drive-view/data.json")).toBe(true);
    expect(await adapter.read(".config/app.json")).toBe("base-content");
    await adapter.write(".config/app.json", "{}");
    expect(base.calls.some((call) => call.name === "write" && call.args[0] === ".config/app.json")).toBe(true);

    const before = base.calls.length;
    expect(await adapter.exists(".obsidian/app.json")).toBe(false);
    expect(base.calls.length).toBe(before);
    // 0.2.25：`.obsidian/**` 在 configDir='.config' 下不属于配置目录 → 静默 no-op（resolve，不转发）
    await expect(adapter.write(".obsidian/app.json", "{}")).resolves.toBeUndefined();
    expect(base.calls.length).toBe(before);
    expect(adapter.getName()).toBe(QUARK_ADAPTER_NAME);
  });

  test("默认 configDir 仍是 '.obsidian'（未注入时行为不变）", async () => {
    const { adapter, base } = makeAdapter(".obsidian");
    expect(await adapter.exists(".obsidian/app.json")).toBe(true);
    expect(base.calls.some((call) => call.name === "exists" && call.args[0] === ".obsidian/app.json")).toBe(true);
    expect(DEFAULT_PLUGIN_DIR).toBe(".obsidian/plugins/quark-vault");
    expect(adapter.getResourcePath(".obsidian/app.json")).toBe("app://local/.obsidian/app.json");
  });

  test("diagLogPath 随 configDir 改变：'.config' → .config/plugins/drive-view/quark-debug.log", () => {
    const diagLogPath = (diag as unknown as { diagLogPath?: (dir?: string) => string }).diagLogPath;
    expect(typeof diagLogPath, "diagLog 必须导出 diagLogPath").toBe("function");
    expect(diagLogPath!()).toBe(".obsidian/plugins/drive-view/quark-debug.log");
    expect(diagLogPath!(".config")).toBe(".config/plugins/drive-view/quark-debug.log");
    expect(diagLogPath!("/.config/")).toBe(".config/plugins/drive-view/quark-debug.log");
    expect(diag.DIAG_LOG_PATH).toBe(".obsidian/plugins/drive-view/quark-debug.log");
  });

  test("DiagLogger 注入 path 后真的写到新配置目录", async () => {
    const diagLogPath = (diag as unknown as { diagLogPath: (dir?: string) => string }).diagLogPath;
    const target = diagLogPath(".config");
    const files = new Map<string, string>();
    const adapter = {
      exists: async (path: string) => files.has(path),
      read: async (path: string) => {
        const value = files.get(path);
        if (value === undefined) throw new Error("ENOENT");
        return value;
      },
      write: async (path: string, data: string) => {
        files.set(path, data);
      },
    };
    const logger = new diag.DiagLogger({ adapter, path: target });
    logger.log({ stage: "read", path: "/a.md", fid: "f", message: "boom" });
    await logger.flush();
    expect(files.has(target)).toBe(true);
    expect(files.has(diag.DIAG_LOG_PATH)).toBe(false);
  });

  test("main.ts 接线：configDir 取自 app.vault 并同时传给 adapter 与 diagLog", async () => {
    const source = await Bun.file(new URL("../src/main.ts", import.meta.url)).text();
    const found = {
      adapterConfigDir: source.includes("configDir: this.app.vault.configDir"),
      pluginDir: /pluginDir:\s*`\$\{this\.app\.vault\.configDir\}\/plugins\/drive-view`/.test(source),
      diagPath: source.includes("diagLogPath(this.app.vault.configDir)"),
      diagOption: source.includes("path: this.quarkDiagPath"),
    };
    expect(found).toEqual({
      adapterConfigDir: true,
      pluginDir: true,
      diagPath: true,
      diagOption: true,
    });
  });

  test("设置页诊断文案随 configDir（不再写死 .obsidian/plugins/drive-view）", async () => {
    const source = await Bun.file(new URL("../src/ui/QuarkSettingsTab.ts", import.meta.url)).text();
    const found = {
      hardcoded: source.includes(".obsidian/plugins/drive-view/quark-debug.log"),
      usesHelper: source.includes("diagLogPath("),
    };
    expect(found).toEqual({ hardcoded: false, usesHelper: true });
  });
});
