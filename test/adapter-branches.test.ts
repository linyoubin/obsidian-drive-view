/**
 * 0.2.23 任务一/三：21 个契约方法在**转发分支**与**虚拟库分支**都返回 Promise（同步 4 个返回 string）。
 *
 * 这是 P0（`undefined.then`）的回归网：任何分支漏 return / 少 await 都会在这里红。
 */

import { describe, expect, test } from "bun:test";

import {
  DATA_ADAPTER_METHOD_NAMES,
  QuarkReadOnlyAdapter,
} from "../src/adapter/QuarkReadOnlyAdapter";
import type { IndexEntry } from "../src/store/IndexStore";

const SYNC_METHODS = new Set(["getName", "getBasePath", "getFullPath", "getResourcePath"]);

const ENTRIES: IndexEntry[] = [
  { path: "notes/a.md", type: "file", fid: "fa", parentFid: "", size: 4, mtime: 1 },
];

/** base adapter：FileSystemAdapter 结构等价（所有方法返回 Promise / string）。 */
function makeBase(): Record<string, unknown> {
  return {
    getName: () => "FileSystemAdapter",
    getBasePath: () => "/vault",
    getFullPath: (path: string) => `/vault/${path}`,
    getResourcePath: (path: string) => `app://local/${path}`,
    exists: async () => true,
    stat: async () => ({ type: "file" as const, ctime: 1, mtime: 1, size: 1 }),
    list: async () => ({ files: ["notes/a.md"], folders: [] }),
    read: async () => "base",
    readBinary: async () => new ArrayBuffer(1),
    write: async () => undefined,
    writeBinary: async () => undefined,
    append: async () => undefined,
    appendBinary: async () => undefined,
    process: async (_path: string, fn: (data: string) => string) => fn("x"),
    getBasePathX: () => "",
    mkdir: async () => undefined,
    trashSystem: async () => true,
    trashLocal: async () => undefined,
    rmdir: async () => undefined,
    remove: async () => undefined,
    rename: async () => undefined,
    copy: async () => undefined,
  };
}

function makeAdapter(): QuarkReadOnlyAdapter {
  return new QuarkReadOnlyAdapter({
    index: { entries: ENTRIES },
    cache: {
      has: () => false,
      get: () => null,
      getResourceUrl: () => "",
      put: () => ({ cached: true }),
      enqueuePrefetch: () => undefined,
    },
    client: { downloadFile: async () => new ArrayBuffer(1) },
    baseAdapter: makeBase() as never,
    allowPrefetch: () => false,
  });
}

/** 每个方法的两种入参：config 目录（走转发）与库内路径（走虚拟库）。 */
function argsFor(name: string, forwarded: boolean): unknown[] {
  const path = forwarded ? ".obsidian/config.json" : "notes/a.md";
  switch (name) {
    case "exists":
      return [path, false];
    case "write":
    case "append":
      return [path, "x"];
    case "writeBinary":
    case "appendBinary":
      return [path, new ArrayBuffer(1)];
    case "process":
      return [path, (data: string) => data];
    case "rmdir":
      return [path, true];
    case "rename":
    case "copy":
      return [path, `${path}.bak`];
    default:
      return [path];
  }
}

describe("0.2.23 21 个方法分支返回类型审计", () => {
  test("转发分支与虚拟库分支都不返回 undefined（异步=Promise / 同步=string）", async () => {
    const adapter = makeAdapter();
    const seen: string[] = [];

    for (const name of DATA_ADAPTER_METHOD_NAMES) {
      const method = (adapter as unknown as Record<string, (...args: unknown[]) => unknown>)[name];
      expect(typeof method, `${name} 必须是方法`).toBe("function");

      for (const forwarded of [true, false]) {
        const result = method.apply(adapter, argsFor(name, forwarded));
        expect(result, `${name}（forwarded=${forwarded}）返回了 undefined`).toBeDefined();
        if (SYNC_METHODS.has(name)) {
          expect(typeof result, `${name} 必须是同步 string`).toBe("string");
        } else {
          expect(result, `${name}（forwarded=${forwarded}）必须返回 Promise`).toBeInstanceOf(Promise);
          await (result as Promise<unknown>).catch(() => undefined); // 只读方法会 reject，已预期
        }
        seen.push(`${name}:${forwarded}`);
      }
    }

    expect(seen.length).toBe(DATA_ADAPTER_METHOD_NAMES.length * 2);
  });
});
