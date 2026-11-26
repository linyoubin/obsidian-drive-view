/** 0.2.17：DataAdapter 全方法契约——任何方法返回 undefined 即 fail。 */
import { describe, expect, test } from "bun:test";

import { QuarkReadOnlyAdapter } from "../src/adapter/QuarkReadOnlyAdapter";

const entries = [{ path: "notes/a.md", type: "file" as const, fid: "fa", parentFid: "0", size: 9, mtime: 1 }];

function makeAdapter(): QuarkReadOnlyAdapter {
  return new QuarkReadOnlyAdapter({
    index: { entries },
    cache: {
      has: () => false,
      get: () => null,
      getResourceUrl: () => "",
      put: () => ({ cached: true }),
      enqueuePrefetch: () => undefined,
    },
    client: { downloadFile: async () => new TextEncoder().encode("hello-a").buffer as ArrayBuffer },
    baseAdapter: {} as never,
    allowPrefetch: () => false,
  });
}

describe("0.2.17 DataAdapter 全方法契约", () => {
  test("19 个方法都不返回 undefined；读/写返回 Promise；同步方法返回 string", async () => {
    const adapter = makeAdapter();
    const thunks: Array<[string, () => Promise<unknown>]> = [
      ["exists", () => adapter.exists("notes/a.md")],
      ["stat", () => adapter.stat("notes/a.md")],
      ["list", () => adapter.list("")],
      ["read", () => adapter.read("notes/a.md")],
      ["readBinary", () => adapter.readBinary("notes/a.md")],
      ["mkdir", () => adapter.mkdir("x")],
      ["trashSystem", () => adapter.trashSystem("notes/a.md")],
      ["trashLocal", () => adapter.trashLocal("notes/a.md")],
      ["rmdir", () => adapter.rmdir("x", true)],
      ["remove", () => adapter.remove("notes/a.md")],
      ["rename", () => adapter.rename("notes/a.md", "notes/b.md")],
      ["copy", () => adapter.copy("notes/a.md", "notes/b.md")],
      ["write", () => adapter.write("notes/a.md", "x")],
      ["writeBinary", () => adapter.writeBinary("notes/a.md", new ArrayBuffer(1))],
      ["append", () => adapter.append("notes/a.md", "x")],
      ["appendBinary", () => adapter.appendBinary("notes/a.md", new ArrayBuffer(1))],
      ["process", () => adapter.process("notes/a.md", (data) => data)],
    ];
    for (const [name, call] of thunks) {
      const result = call();
      expect(result, name).toBeDefined();
      expect(typeof (result as { then?: unknown }).then, name).toBe("function");
      // 0.2.25：写方法静默 resolve（不再 reject，否则 Obsidian 弹保存失败）；
      // 读方法可能 reject（索引里没有该路径），这里都只保证返回 Promise
      await (result as Promise<unknown>).catch(() => undefined);
    }    expect(typeof adapter.getName()).toBe("string");
    expect(typeof adapter.getResourcePath("notes/a.md")).toBe("string");
    expect(typeof adapter.getBasePath()).toBe("string");
    expect(typeof adapter.getFullPath("notes/a.md")).toBe("string");
  });

  test("getResourcePath 关闭预取时返回占位 data URL（同步 string，不是 undefined）", () => {
    const adapter = makeAdapter();
    const url = adapter.getResourcePath("notes/a.md");
    expect(typeof url).toBe("string");
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
  });
});
