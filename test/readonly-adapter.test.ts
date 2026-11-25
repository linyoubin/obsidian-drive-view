/**
 * QuarkReadOnlyAdapter 单测：假索引 / 假缓存 / 假下载器 / 假原生 adapter。
 *
 * 覆盖契约 T-08：A2（19 方法分类）、A3（读路径只查索引、list 非递归且零网络）、
 * A4（getResourcePath 同步两分支）、A5（.obsidian 读写转发）、A6（12 写方法同一 ReadOnlyError）。
 */

import { describe, expect, test } from "bun:test";
import type { DataAdapter, DataWriteOptions, ListedFiles, Stat } from "obsidian";

import {
  QUARK_ADAPTER_NAME,
  QuarkEntryNotFoundError,
  QuarkReadOnlyAdapter,
  type QuarkCacheLike,
  type QuarkDownloadClient,
  type QuarkIndexReader,
} from "../src/adapter/QuarkReadOnlyAdapter";
import { ReadOnlyError, isReadOnlyError } from "../src/adapter/readonlyError";
import type { IndexEntry } from "../src/store/IndexStore";

// ------------------------------------------------------------------ 工具

function entry(path: string, patch: Partial<IndexEntry> = {}): IndexEntry {
  return {
    path,
    type: patch.type ?? "file",
    fid: patch.fid ?? `fid:${path}`,
    parentFid: patch.parentFid ?? "",
    size: patch.size ?? 5,
    mtime: patch.mtime ?? 100,
  };
}

/** 库结构：
 *  ""(根) ├─ a.md
 *         ├─ folder/ ─ b.md
 *         └─ Folder2/ ─ c.md
 */
function indexEntries(): IndexEntry[] {
  return [
    entry("a.md", { fid: "fa", size: 11, mtime: 100 }),
    entry("folder", { type: "folder", fid: "fdir", size: 0, mtime: 150 }),
    entry("folder/b.md", { fid: "fb", size: 22, mtime: 200 }),
    entry("Folder2", { type: "folder", fid: "fdir2", size: 0, mtime: 160 }),
    entry("Folder2/c.md", { fid: "fc", size: 33, mtime: 170 }),
  ];
}

function makeIndex(entries: IndexEntry[] = indexEntries()): QuarkIndexReader & { entries: IndexEntry[] } {
  return { entries };
}

interface PrefetchCall {
  path: string;
  size?: number;
}

interface CacheHarness {
  cache: QuarkCacheLike;
  prefetch: PrefetchCall[];
  puts: Array<{ path: string; bytes: number }>;
  resources: Map<string, string>;
}

function makeCache(seed: Record<string, ArrayBuffer> = {}): CacheHarness {
  const store = new Map<string, ArrayBuffer>(Object.entries(seed));
  const prefetch: PrefetchCall[] = [];
  const puts: Array<{ path: string; bytes: number }> = [];
  const resources = new Map<string, string>();
  for (const path of store.keys()) resources.set(path, `blob:quark-${path}`);

  const cache: QuarkCacheLike = {
    has: (path: string) => store.has(path),
    get: (path: string) => store.get(path) ?? null,
    getResourceUrl: (path: string) => resources.get(path) ?? "",
    put: (path: string, data: ArrayBuffer | Uint8Array) => {
      const buffer = data instanceof Uint8Array ? (data.slice().buffer as ArrayBuffer) : data;
      store.set(path, buffer);
      resources.set(path, `blob:quark-${path}`);
      puts.push({ path, bytes: buffer.byteLength });
      return { cached: true };
    },
    enqueuePrefetch: (items: PrefetchCall[]) => {
      prefetch.push(...items);
      return { queued: items.length, skipped: 0 };
    },
  };
  return { cache, prefetch, puts, resources };
}

interface ClientHarness {
  client: QuarkDownloadClient;
  calls: string[];
}

function makeClient(buffers: Record<string, ArrayBuffer> = {}): ClientHarness {
  const calls: string[] = [];
  const client: QuarkDownloadClient = {
    downloadFile: async (fid: string, options?: { priority?: string; path?: string }) => {
      calls.push(options?.priority ? `${fid}:${options.priority}` : fid);
      const buffer = buffers[fid];
      if (!buffer) throw new Error(`no fixture bytes for fid=${fid}`);
      return buffer;
    },
  };
  return { client, calls };
}

function textBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer as ArrayBuffer;
}

interface BaseHarness {
  baseAdapter: DataAdapter;
  calls: Array<{ name: string; args: unknown[] }>;
}

function makeBaseAdapter(): BaseHarness {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const record = (name: string, ...args: unknown[]): void => {
    calls.push({ name, args });
  };
  const base = {
    getName: () => "FileSystemAdapter",
    exists: async (path: string, _sensitive?: boolean) => {
      record("exists", path);
      return path.startsWith(".obsidian");
    },
    stat: async (path: string): Promise<Stat | null> => {
      record("stat", path);
      return { type: "file", ctime: 1, mtime: 2, size: 3 };
    },
    list: async (path: string): Promise<ListedFiles> => {
      record("list", path);
      return { files: [".obsidian/app.json"], folders: [] };
    },
    read: async (path: string) => {
      record("read", path);
      return '{"base":true}';
    },
    readBinary: async (path: string) => {
      record("readBinary", path);
      return new Uint8Array([9, 9]).buffer;
    },
    write: async (path: string, data: string, _options?: DataWriteOptions) => {
      record("write", path, data);
    },
    writeBinary: async (path: string, data: ArrayBuffer, _options?: DataWriteOptions) => {
      record("writeBinary", path, data);
    },
    append: async (path: string, data: string, _options?: DataWriteOptions) => {
      record("append", path, data);
    },
    appendBinary: async (path: string, data: ArrayBuffer, _options?: DataWriteOptions) => {
      record("appendBinary", path, data);
    },
    process: async (path: string, fn: (data: string) => string, _options?: DataWriteOptions) => {
      record("process", path);
      return fn("base");
    },
    getResourcePath: (path: string) => {
      record("getResourcePath", path);
      return `app://base/${path}`;
    },
    mkdir: async (path: string) => {
      record("mkdir", path);
    },
    trashSystem: async (path: string) => {
      record("trashSystem", path);
      return true;
    },
    trashLocal: async (path: string) => {
      record("trashLocal", path);
    },
    rmdir: async (path: string, recursive: boolean) => {
      record("rmdir", path, recursive);
    },
    remove: async (path: string) => {
      record("remove", path);
    },
    rename: async (path: string, newPath: string) => {
      record("rename", path, newPath);
    },
    copy: async (path: string, newPath: string) => {
      record("copy", path, newPath);
    },
  };
  return { baseAdapter: base as unknown as DataAdapter, calls };
}

interface Harness {
  adapter: QuarkReadOnlyAdapter;
  index: QuarkIndexReader;
  cache: CacheHarness;
  client: ClientHarness;
  base: BaseHarness;
}

function makeAdapter(options: {
  entries?: IndexEntry[];
  cacheSeed?: Record<string, ArrayBuffer>;
  clientBuffers?: Record<string, ArrayBuffer>;
  allowPrefetch?: () => boolean;
  prefetchPerNote?: () => number;
  mdStore?: import("../src/store/MdContentStore").MdContentStore;
} = {}): Harness {
  const index = makeIndex(options.entries ?? indexEntries());
  const cache = makeCache(options.cacheSeed ?? {});
  const client = makeClient(options.clientBuffers ?? { fa: textBuffer("hello-a"), fb: textBuffer("hello-b") });
  const base = makeBaseAdapter();
  const adapter = new QuarkReadOnlyAdapter({
    index,
    cache: cache.cache,
    client: client.client,
    baseAdapter: base.baseAdapter,
    allowPrefetch: options.allowPrefetch ?? (() => true),
    prefetchPerNote: options.prefetchPerNote ?? (() => 0),
    mdStore: options.mdStore ?? null,
  });
  return { adapter, index, cache, client, base };
}

const WRITE_CALLS: Array<[string, (adapter: QuarkReadOnlyAdapter) => Promise<unknown>]> = [
  ["write", (adapter) => adapter.write("note.md", "x")],
  ["writeBinary", (adapter) => adapter.writeBinary("note.md", new ArrayBuffer(1))],
  ["append", (adapter) => adapter.append("note.md", "x")],
  ["appendBinary", (adapter) => adapter.appendBinary("note.md", new ArrayBuffer(1))],
  ["process", (adapter) => adapter.process("note.md", (data) => data)],
  ["mkdir", (adapter) => adapter.mkdir("newdir")],
  ["trashSystem", (adapter) => adapter.trashSystem("a.md")],
  ["trashLocal", (adapter) => adapter.trashLocal("a.md")],
  ["rmdir", (adapter) => adapter.rmdir("folder", true)],
  ["remove", (adapter) => adapter.remove("a.md")],
  ["rename", (adapter) => adapter.rename("a.md", "b.md")],
  ["copy", (adapter) => adapter.copy("a.md", "b.md")],
];

// ------------------------------------------------------------------ A2：19 个方法

describe("QuarkReadOnlyAdapter：19 个方法（A2）", () => {
  test("getName 返回 quark-readonly，且 19 个方法全部存在", () => {
    const { adapter } = makeAdapter();
    expect(adapter.getName()).toBe(QUARK_ADAPTER_NAME);
    expect(adapter.getName()).toBe("quark-readonly");

    const expected = [
      "getName",
      "exists",
      "stat",
      "list",
      "read",
      "readBinary",
      "write",
      "writeBinary",
      "append",
      "appendBinary",
      "process",
      "getResourcePath",
      "mkdir",
      "trashSystem",
      "trashLocal",
      "rmdir",
      "remove",
      "rename",
      "copy",
    ];
    const proto = QuarkReadOnlyAdapter.prototype as unknown as Record<string, unknown>;
    for (const name of expected) {
      expect(typeof proto[name]).toBe("function");
    }
    // 同步方法：返回值不是 Promise
    expect(typeof adapter.getResourcePath("a.md")).toBe("string");
    expect(typeof adapter.getName()).toBe("string");
  });
});

// ------------------------------------------------------------------ A3：读路径

describe("QuarkReadOnlyAdapter：读路径只查索引（A3）", () => {
  test("exists：根、精确命中、未命中、sensitive=false 走大小写不敏感", async () => {
    const { adapter, client } = makeAdapter();
    await expect(adapter.exists("")).resolves.toBe(true);
    await expect(adapter.exists("a.md")).resolves.toBe(true);
    await expect(adapter.exists("folder/b.md")).resolves.toBe(true);
    await expect(adapter.exists("nope.md")).resolves.toBe(false);
    await expect(adapter.exists("A.MD")).resolves.toBe(false);
    await expect(adapter.exists("A.MD", false)).resolves.toBe(true);
    expect(client.calls).toEqual([]);
  });

  test("stat：文件/目录/根/缺失四种", async () => {
    const { adapter, client } = makeAdapter();
    const file = await adapter.stat("folder/b.md");
    expect(file).toEqual({ type: "file", ctime: 200_000, mtime: 200_000, size: 22 });
    const folder = await adapter.stat("folder");
    expect(folder!.type).toBe("folder");
    expect(folder!.size).toBe(0);
    const root = await adapter.stat("");
    expect(root!.type).toBe("folder");
    expect(root!.mtime).toBe(200_000); // 全库最新 updated_at（秒级已归一为毫秒，0.2.9）
    await expect(adapter.stat("nope.md")).resolves.toBeNull();
    expect(client.calls).toEqual([]);
  });

  test("list 非递归、按 path 排序，且一次 client 都不调用", async () => {
    const { adapter, client, cache } = makeAdapter();
    const root = await adapter.list("");
    expect(root.files).toEqual(["a.md"]);
    // 顺序取决于运行环境的 Collation（CI Linux 与 Windows 可能不同），这里只断言内容
    expect([...root.folders].sort()).toEqual(["Folder2", "folder"]);

    const folder = await adapter.list("folder");
    expect(folder.files).toEqual(["folder/b.md"]);
    expect(folder.folders).toEqual([]);

    // 前导斜杠/反斜杠都归一
    expect((await adapter.list("/folder/")).files).toEqual(["folder/b.md"]);

    expect(client.calls).toEqual([]);
    expect(cache.prefetch).toEqual([]);
  });

  test("read：缓存命中不发请求；未命中下载并写回缓存", async () => {
    const { adapter, client, cache } = makeAdapter();
    const first = await adapter.read("a.md");
    expect(first).toBe("hello-a");
    expect(client.calls).toEqual(["fa:interactive"]);
    expect(cache.puts).toEqual([{ path: "a.md", bytes: 7 }]);

    const second = await adapter.read("a.md");
    expect(second).toBe("hello-a");
    expect(client.calls).toEqual(["fa:interactive"]); // 第二次命中缓存
  });

  test("readBinary：返回 ArrayBuffer；索引里没有的路径抛 QuarkEntryNotFoundError", async () => {
    const { adapter, client } = makeAdapter({ clientBuffers: { fb: new Uint8Array([1, 2, 3]).buffer } });
    const buffer = await adapter.readBinary("folder/b.md");
    expect(buffer.byteLength).toBe(3);
    expect(new Uint8Array(buffer)).toEqual(new Uint8Array([1, 2, 3]));

    await expect(adapter.read("nope.md")).rejects.toBeInstanceOf(QuarkEntryNotFoundError);
    await expect(adapter.read("folder")).rejects.toBeInstanceOf(QuarkEntryNotFoundError);
    await expect(adapter.read("")).rejects.toBeInstanceOf(QuarkEntryNotFoundError);
    expect(client.calls).toEqual(["fb:interactive"]);
  });
});

// ------------------------------------------------------------------ A4：getResourcePath

describe("QuarkReadOnlyAdapter：getResourcePath 同步两分支（A4）", () => {
  test("命中缓存返回 blob URL（不再入队预取）", async () => {
    const { adapter, cache } = makeAdapter({ cacheSeed: { "a.md": textBuffer("x") } });
    const url = adapter.getResourcePath("a.md");
    expect(url).toBe("blob:quark-a.md");
    expect(cache.prefetch).toEqual([]);
    expect(typeof url).toBe("string");
  });

  test("未命中返回空串并把路径（带 size）入预取队列", () => {
    const { adapter, cache, client } = makeAdapter();
    const result = adapter.getResourcePath("folder/b.md");
    expect(result).toBe("");
    expect(cache.prefetch).toEqual([{ path: "folder/b.md", size: 22 }]);
    expect(client.calls).toEqual([]);
    // 同步语义：不是 Promise
    expect(typeof (result as unknown as Promise<string>).then).toBe("undefined");
  });
});

// ------------------------------------------------------------------ A6：12 个写方法

describe("QuarkReadOnlyAdapter：12 个写方法抛 ReadOnlyError（A6，0.2.8 写失败由 main 回滚）", () => {
  test("逐个遍历 12 个写方法：instanceof ReadOnlyError + 消息含「只读」+ operation 正确", async () => {
    expect(WRITE_CALLS.length).toBe(12);
    for (const [operation, call] of WRITE_CALLS) {
      const { adapter } = makeAdapter();
      let caught: unknown = null;
      try {
        await call(adapter);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(ReadOnlyError);
      expect(isReadOnlyError(caught)).toBe(true);
      expect((caught as ReadOnlyError).operation).toBe(operation);
      expect((caught as ReadOnlyError).message).toContain("只读");
    }
  });

  test("trashSystem 抛错而不是返回 false", async () => {
    const { adapter } = makeAdapter();
    let returned: unknown = "not-called";
    await expect(
      (async () => {
        returned = await adapter.trashSystem("a.md");
      })()
    ).rejects.toBeInstanceOf(ReadOnlyError);
    expect(returned).toBe("not-called"); // 没有返回 false
  });

  test("写方法被拒时不碰缓存、不碰下载器、不碰原生 adapter", async () => {
    const { adapter, client, cache, base } = makeAdapter();
    await expect(adapter.write("a.md", "x")).rejects.toBeInstanceOf(ReadOnlyError);
    expect(client.calls).toEqual([]);
    expect(cache.puts).toEqual([]);
    expect(base.calls).toEqual([]);
  });
});

// ------------------------------------------------------------------ A5：.obsidian 转发

describe("QuarkReadOnlyAdapter：.obsidian 与插件目录转发（A5）", () => {
  test("读：exists/stat/list/read/readBinary/getResourcePath 全部走 baseAdapter", async () => {
    const { adapter, base, client } = makeAdapter();
    await adapter.exists(".obsidian/app.json");
    await adapter.stat(".obsidian/app.json");
    await adapter.list(".obsidian");
    const text = await adapter.read(".obsidian/app.json");
    const binary = await adapter.readBinary(".obsidian/plugins/quark-vault/main.js");
    const resource = adapter.getResourcePath(".obsidian/themes/x.css");

    expect(text).toBe('{"base":true}');
    expect(binary.byteLength).toBe(2);
    expect(resource).toBe("app://base/.obsidian/themes/x.css");
    expect(base.calls.map((call) => call.name)).toEqual([
      "exists",
      "stat",
      "list",
      "read",
      "readBinary",
      "getResourcePath",
    ]);
    expect(client.calls).toEqual([]);
  });

  test("写：配置目录与插件目录都转发给 baseAdapter，不抛 ReadOnlyError", async () => {
    const { adapter, base } = makeAdapter();
    await adapter.write(".obsidian/app.json", "{}");
    await adapter.writeBinary(".obsidian/plugins/quark-vault/main.js", new ArrayBuffer(4));
    await adapter.mkdir(".obsidian/plugins/quark-vault");
    await adapter.rmdir(".obsidian/themes", true);
    await adapter.trashSystem(".obsidian/x.json");
    await adapter.trashLocal(".obsidian/y.json");
    await adapter.rename(".obsidian/a", ".obsidian/b");
    await adapter.copy(".obsidian/a", ".obsidian/c");
    await adapter.append(".obsidian/log.txt", "x");
    await adapter.appendBinary(".obsidian/log.bin", new ArrayBuffer(1));
    const processed = await adapter.process(".obsidian/p.txt", (data) => data.toUpperCase());

    expect(processed).toBe("BASE");
    expect(base.calls.map((call) => call.name)).toEqual([
      "write",
      "writeBinary",
      "mkdir",
      "rmdir",
      "trashSystem",
      "trashLocal",
      "rename",
      "copy",
      "append",
      "appendBinary",
      "process",
    ]);
  });

  test("非配置路径不转发：baseAdapter 一次都不被调用", async () => {
    const { adapter, base } = makeAdapter();
    await adapter.exists("a.md");
    await adapter.stat("a.md");
    await adapter.list("");
    adapter.getResourcePath("a.md");
    await expect(adapter.rmdir("folder", false)).rejects.toBeInstanceOf(ReadOnlyError);
    expect(base.calls).toEqual([]);
  });
});

describe("QuarkReadOnlyAdapter：预取默认关 + 优先级分类（0.2.11）", () => {
  test("allowPrefetch=false：getResourcePath 不入队；开了才入队且 src=render", () => {
    const off = makeAdapter({ allowPrefetch: () => false });
    off.adapter.getResourcePath("folder/b.md");
    expect(off.cache.prefetch).toEqual([]);

    const on = makeAdapter({ allowPrefetch: () => true });
    const logs: Array<{ stage: string; fields?: Record<string, unknown> }> = [];
    const withDiag = new QuarkReadOnlyAdapter({
      index: makeIndex(indexEntries()),
      cache: on.cache.cache,
      client: on.client.client,
      baseAdapter: on.base.baseAdapter,
      allowPrefetch: () => true,
      diag: (entry) => logs.push(entry),
    });
    withDiag.getResourcePath("folder/b.md");
    expect(on.cache.prefetch).toEqual([{ path: "folder/b.md", size: 22 }]);
    const enqueueLog = logs.find((entry) => entry.stage === "prefetch");
    expect(enqueueLog?.fields).toMatchObject({ state: "enqueue", src: "render" });
  });

  test("md 正文走 interactive；jpeg/附件走 background", async () => {
    const { adapter, client } = makeAdapter({
      clientBuffers: {
        fa: textBuffer("hello-a"),
        fb: textBuffer("hello-b"),
        fimg: textBuffer("img"),
      },
      entries: [
        { path: "notes/a.md", type: "file", fid: "fa", parentFid: "0", size: 7, mtime: 1000 },
        { path: "notes/b.md", type: "file", fid: "fb", parentFid: "0", size: 7, mtime: 2000 },
        { path: "90-assets/x.jpeg", type: "file", fid: "fimg", parentFid: "0", size: 3, mtime: 3000 },
      ],
    });
    await adapter.read("notes/a.md");
    await adapter.readBinary("90-assets/x.jpeg");
    expect(client.calls).toEqual(["fa:interactive", "fimg:background"]);
  });
});

describe("QuarkReadOnlyAdapter：按笔记精准预取（0.2.12/0.2.13）", () => {
  const noteContent = "![[one.jpeg]] ![[two.jpeg|300]] ![](three.png) ![[missing.jpeg]] ![[text.md]]";
  function noteAdapter(prefetchPerNote?: number) {
    return makeAdapter({
      entries: [
        { path: "notes/a.md", type: "file", fid: "fa", parentFid: "0", size: noteContent.length, mtime: 1000 },
        { path: "notes/one.jpeg", type: "file", fid: "f1", parentFid: "0", size: 3, mtime: 1000 },
        { path: "notes/two.jpeg", type: "file", fid: "f2", parentFid: "0", size: 3, mtime: 1000 },
        { path: "notes/three.png", type: "file", fid: "f3", parentFid: "0", size: 3, mtime: 1000 },
      ],
      clientBuffers: {
        fa: textBuffer(noteContent),
        f1: textBuffer("111"),
        f2: textBuffer("222"),
        f3: textBuffer("333"),
      },
      prefetchPerNote: () => (prefetchPerNote === undefined ? 0 : prefetchPerNote),
    });
  }

  test("上限 0（不限）：所有被引用的附件都入队，md 与不存在项被跳过", async () => {
    const { adapter, cache } = noteAdapter(0);
    const result = await adapter.prefetchNote("notes/a.md");
    expect(cache.prefetch.map((item) => item.path)).toEqual([
      "notes/one.jpeg",
      "notes/two.jpeg",
      "notes/three.png",
    ]);
    expect(result.enqueued).toBe(3);
    expect(result.skipped).toBeGreaterThanOrEqual(2); // missing.jpeg + text.md
    expect(result.dropped).toBe(0);
  });

  test("手动上限 2：超出的丢弃且 dropped 计数正确", async () => {
    const { adapter, cache } = noteAdapter(2);
    const result = await adapter.prefetchNote("notes/a.md");
    expect(cache.prefetch).toHaveLength(2);
    expect(result.enqueued).toBe(2);
    expect(result.dropped).toBe(1);
  });
});

describe("QuarkReadOnlyAdapter：预取跳过与 summary（0.2.13）", () => {
  test("已缓存 / 在途被跳过；summary 记录 enqueued/skipped/dropped", async () => {
    const content = "![[one.jpeg]] ![[two.jpeg]]";
    const { adapter, cache } = makeAdapter({
      entries: [
        { path: "notes/a.md", type: "file", fid: "fa", parentFid: "0", size: content.length, mtime: 1 },
        { path: "notes/one.jpeg", type: "file", fid: "f1", parentFid: "0", size: 3, mtime: 1 },
        { path: "notes/two.jpeg", type: "file", fid: "f2", parentFid: "0", size: 3, mtime: 1 },
      ],
      cacheSeed: { "notes/one.jpeg": textBuffer("aaa") },
      clientBuffers: { fa: textBuffer(content), f1: textBuffer("aaa"), f2: textBuffer("bbb") },
      prefetchPerNote: () => 0,
    });
    const logs: Array<{ stage: string; fields?: Record<string, unknown> }> = [];
    const withDiag = new QuarkReadOnlyAdapter({
      index: makeIndex([
        { path: "notes/a.md", type: "file", fid: "fa", parentFid: "0", size: content.length, mtime: 1 },
        { path: "notes/one.jpeg", type: "file", fid: "f1", parentFid: "0", size: 3, mtime: 1 },
        { path: "notes/two.jpeg", type: "file", fid: "f2", parentFid: "0", size: 3, mtime: 1 },
      ]),
      cache: cache.cache,
      client: { downloadFile: async (fid: string) => (fid === "fa" ? textBuffer(content) : textBuffer("x")) },
      baseAdapter: {} as never,
      allowPrefetch: () => true,
      prefetchPerNote: () => 0,
      diag: (entry) => logs.push(entry),
    });
    await withDiag.prefetchNote("notes/a.md");
    const summary = logs.find((entry) => entry.fields?.state === "summary");
    expect(summary).toBeTruthy();
    expect(Number(summary!.fields!.enqueued)).toBe(1);
    expect(Number(summary!.fields!.skipped)).toBeGreaterThanOrEqual(1);
    expect(logs.some((entry) => entry.fields?.reason === "cached")).toBe(true);
  });
});

describe("QuarkReadOnlyAdapter：md 磁盘缓存读取顺序（0.2.13）", () => {
  test("IDB 命中优先于网络，并把内容提升进内存 LRU", async () => {
    const { MdContentStore, MemoryMdContentBackend } = await import("../src/store/MdContentStore");
    const store = new MdContentStore({ backend: new MemoryMdContentBackend(), now: () => 1 });
    await store.put("notes/a.md", textBuffer("cached-md"), { fid: "fa", size: 9, mtime: 1 });
    const { adapter, client, cache } = makeAdapter({
      mdStore: store,
      entries: [{ path: "notes/a.md", type: "file", fid: "fa", parentFid: "0", size: 9, mtime: 1 }],
    });
    const text = await adapter.read("notes/a.md");
    expect(text).toBe("cached-md");
    expect(client.calls).toEqual([]); // 不发起网络
    expect(cache.cache.has("notes/a.md")).toBe(true); // 已提升进内存
  });

  test("附件（非 md）永不写 IDB", async () => {
    const { MdContentStore, MemoryMdContentBackend } = await import("../src/store/MdContentStore");
    const store = new MdContentStore({ backend: new MemoryMdContentBackend(), now: () => 1 });
    const { adapter } = makeAdapter({
      mdStore: store,
      entries: [
        { path: "90-assets/x.jpeg", type: "file", fid: "fimg", parentFid: "0", size: 3, mtime: 1 },
        { path: "notes/a.md", type: "file", fid: "fa", parentFid: "0", size: 9, mtime: 1 },
      ],
      clientBuffers: { fimg: textBuffer("img"), fa: textBuffer("hello-a") },
    });
    await adapter.readBinary("90-assets/x.jpeg");
    await adapter.read("notes/a.md");
    const stats = await store.stats();
    expect(stats.count).toBe(1); // 只有 md
    expect(await store.get("90-assets/x.jpeg")).toBeNull();
  });
});

describe("P0 安全阀：图片默认点了才下（0.2.15）", () => {
  test("未命中返回占位 data URL、不入队、零网络", () => {
    const logs: Array<{ stage: string; fields?: Record<string, unknown> }> = [];
    const { adapter, cache, client } = makeAdapter({ allowPrefetch: () => false });
    const withDiag = new QuarkReadOnlyAdapter({
      index: makeIndex(indexEntries()),
      cache: cache.cache,
      client: client.client,
      baseAdapter: {} as never,
      allowPrefetch: () => false,
      currentNotePath: () => "20-notes/a.md",
      diag: (entry) => logs.push(entry),
    });
    const url = withDiag.getResourcePath("folder/b.md");
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    expect(cache.prefetch).toEqual([]);
    expect(client.calls).toEqual([]);
    expect(logs.some((entry) => entry.fields?.reason === "on-demand")).toBe(true);
  });

  test("零图片引用的普通笔记：prefetchNote 零入队、零网络", async () => {
    const content = "普通笔记，没有图片引用";
    const { adapter, cache, client } = makeAdapter({
      entries: [{ path: "20-notes/a.md", type: "file", fid: "fa", parentFid: "0", size: content.length, mtime: 1 }],
      clientBuffers: { fa: textBuffer(content) },
      allowPrefetch: () => true,
      prefetchPerNote: () => 0,
    });
    const result = await adapter.prefetchNote("20-notes/a.md");
    expect(result.enqueued).toBe(0);
    expect(cache.prefetch).toEqual([]);
    // 只下载笔记正文 1 次；附件 0 次（0.2.15）
    expect(client.calls).toEqual(["fa:interactive"]);
  });

  test("笔记只引用 1 张图：只入队 1 张（同名目录不扩展）", async () => {
    const content = "正文 ![](90-assets/A/one.jpeg)";
    const { adapter, cache } = makeAdapter({
      entries: [
        { path: "20-notes/a.md", type: "file", fid: "fa", parentFid: "0", size: content.length, mtime: 1 },
        { path: "90-assets/A/one.jpeg", type: "file", fid: "f1", parentFid: "0", size: 3, mtime: 1 },
        { path: "90-assets/A/two.jpeg", type: "file", fid: "f2", parentFid: "0", size: 3, mtime: 1 },
        { path: "90-assets/A/three.jpeg", type: "file", fid: "f3", parentFid: "0", size: 3, mtime: 1 },
      ],
      clientBuffers: { fa: textBuffer(content), f1: textBuffer("1"), f2: textBuffer("2"), f3: textBuffer("3") },
      prefetchPerNote: () => 0,
    });
    const result = await adapter.prefetchNote("20-notes/a.md");
    expect(result.enqueued).toBe(1);
    expect(cache.prefetch.map((item) => item.path)).toEqual(["90-assets/A/one.jpeg"]);
  });
});

describe("P0：打开图片文件（readBinary）才下载（0.2.15）", () => {
  test("用户点开图片 → readBinary 下载 1 次，走 background", async () => {
    const { adapter, client } = makeAdapter({
      entries: [
        { path: "90-assets/x.jpeg", type: "file", fid: "fimg", parentFid: "0", size: 3, mtime: 1 },
      ],
      clientBuffers: { fimg: textBuffer("img") },
    });
    const buffer = await adapter.readBinary("90-assets/x.jpeg");
    expect(new TextDecoder().decode(buffer)).toBe("img");
    expect(client.calls).toEqual(["fimg:background"]);
  });
});
