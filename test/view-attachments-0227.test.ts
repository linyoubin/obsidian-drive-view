/**
 * 0.2.27：图片 / PDF 打不开的修复与自证。
 *
 * 六个排查点对应的用例：
 *   ① readBinary 返回真实字节；
 *   ② blob URL 的 MIME 必须正确（application/pdf、image/jpeg）——改前 ContentCache 建 Blob 不带 type；
 *   ③ 占位阶段返回 data: 且不触发下载（不改行为，锁住）；
 *   ④ 点开后下载完成 → 视图重载 1 次（PDF 也走 setViewState 分支）；
 *   ⑤ read() 对二进制扩展名给明确错误（不再把字节按 UTF-8 解码后返回乱码）；
 *   ⑥ stage=view 埋点：kind / getResourcePath / bytes / mime；失败时 state=failed；
 *   ⑦ 大文件超时随大小放宽（50MB PDF 不被固定 20s 误杀）。
 */

import { describe, expect, test } from "bun:test";

import { ContentCache } from "../src/store/ContentCache";
import {
  QuarkReadOnlyAdapter,
  createAttachmentWarmup,
  quarkDownloadTimeoutMsForSize,
} from "../src/adapter/QuarkReadOnlyAdapter";
import type { RefreshableLeafLike } from "../src/adapter/QuarkReadOnlyAdapter";
import { QuarkDownloadTimeoutError } from "../src/client/QuarkClient";
import type { IndexEntry } from "../src/store/IndexStore";

interface DiagEntry {
  level?: string;
  stage?: string;
  path?: string;
  message?: string;
  cause?: string;
  fields?: Record<string, unknown>;
}

interface ClientCall {
  fid: string;
  priority?: string;
  timeoutMs?: number;
}

const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]); // %PDF
const jpgBytes = new Uint8Array([0xff, 0xd8, 0xff]);

function makeEntries(): IndexEntry[] {
  return [
    { path: "files/a.pdf", type: "file", fid: "fid-pdf", parentFid: "", size: pdfBytes.byteLength, mtime: 1 },
    { path: "files/a.jpg", type: "file", fid: "fid-jpg", parentFid: "", size: jpgBytes.byteLength, mtime: 1 },
    {
      path: "files/big.pdf",
      type: "file",
      fid: "fid-big",
      parentFid: "",
      size: 50 * 1024 * 1024,
      mtime: 1,
    },
  ];
}

function makeAdapter(
  options: {
    cache?: ContentCache;
    diag?: (entry: DiagEntry) => void;
    client?: { downloadFile: (fid: string, opts?: { path?: string; priority?: string; timeoutMs?: number }) => Promise<ArrayBuffer> };
  } = {}
) {
  const calls: ClientCall[] = [];
  const cache =
    options.cache ??
    new ContentCache({
      createObjectUrl: (_data: ArrayBuffer, path: string) => `blob:${path}`,
    });
  const client = options.client ?? {
    downloadFile: async (fid: string, opts?: { path?: string; priority?: string; timeoutMs?: number }) => {
      calls.push({ fid, priority: opts?.priority, timeoutMs: opts?.timeoutMs });
      return fid === "fid-jpg" ? jpgBytes.buffer : pdfBytes.buffer;
    },
  };
  const adapter = new QuarkReadOnlyAdapter({
    index: { entries: makeEntries() },
    cache,
    client: client as never,
    baseAdapter: {} as never,
    allowPrefetch: () => false,
    diag: options.diag as never,
  });
  return { adapter, cache, calls };
}

describe("线 1-① readBinary 返回真实字节", () => {
  test("readBinary('files/a.pdf') 返回真实 PDF 字节（%PDF），不是占位/空 buffer", async () => {
    const { adapter } = makeAdapter();
    const bytes = await adapter.readBinary("files/a.pdf");
    expect(bytes.byteLength).toBe(pdfBytes.byteLength);
    expect(new Uint8Array(bytes)).toEqual(pdfBytes);
  });

  test("readBinary('files/a.jpg') 返回真实 JPEG 字节（FF D8 FF）", async () => {
    const { adapter } = makeAdapter();
    const bytes = await adapter.readBinary("files/a.jpg");
    expect(new Uint8Array(bytes)).toEqual(jpgBytes);
  });
});

describe("线 1-② blob URL 的 MIME 正确", () => {
  test("ContentCache：pdf → application/pdf，jpg → image/jpeg，且路径传给 createObjectUrl", () => {
    const paths: string[] = [];
    const cache = new ContentCache({
      createObjectUrl: (_data: ArrayBuffer, path: string) => {
        paths.push(path);
        return `blob:${path}`;
      },
    });
    cache.put("files/a.pdf", pdfBytes.buffer as ArrayBuffer);
    cache.put("files/a.jpg", jpgBytes.buffer as ArrayBuffer);

    const pdf = cache.peek("files/a.pdf");
    const jpg = cache.peek("files/a.jpg");
    expect(pdf?.mime).toBe("application/pdf");
    expect(jpg?.mime).toBe("image/jpeg");
    expect(pdf?.url).toBe("blob:files/a.pdf");
    expect(paths).toEqual(["files/a.pdf", "files/a.jpg"]);
  });

  test("适配器：readBinary 之后 getResourcePath 给出 blob: URL（MIME=application/pdf）", async () => {
    const { adapter, cache } = makeAdapter();
    await adapter.readBinary("files/a.pdf");
    const url = adapter.getResourcePath("files/a.pdf");
    expect(url.startsWith("blob:")).toBe(true);
    expect(cache.peek("files/a.pdf")?.mime).toBe("application/pdf");
  });
});

describe("线 1-③ 占位阶段不触发下载", () => {
  test("未命中 + 预取关闭 → 返回 data: 占位且 client 没被调用", () => {
    const { adapter, calls } = makeAdapter();
    const url = adapter.getResourcePath("files/a.pdf");
    expect(url.startsWith("data:image/png;base64,")).toBe(true);
    expect(calls).toEqual([]);
  });
});

describe("线 1-④ 下载完成 → 视图重载 1 次（PDF）", () => {
  test("warmup('files/a.pdf')：readBinary 1 次、setViewState 1 次；节流内第二次不发下载", async () => {
    let now = 1_000;
    const leaf: RefreshableLeafLike & { setViewStateCalls: number } = {
      view: { file: { path: "files/a.pdf" } },
      setViewStateCalls: 0,
      getViewState: () => ({ type: "pdf", state: { file: "files/a.pdf" } }),
      setViewState: async () => {
        leaf.setViewStateCalls += 1;
      },
    };
    let reads = 0;
    const warmup = createAttachmentWarmup(
      {
        readBinary: async () => {
          reads += 1;
        },
        activeLeaf: () => leaf,
        openLeaves: () => [leaf],
        now: () => now,
      },
      1_000
    );

    await expect(warmup("files/a.pdf")).resolves.toBe(true);
    expect(reads).toBe(1);
    expect(leaf.setViewStateCalls).toBe(1);

    now += 500; // 节流窗口内
    await expect(warmup("files/a.pdf")).resolves.toBe(false);
    expect(reads).toBe(1);
  });
});

describe("线 1-⑤ read() 对二进制给明确错误", () => {
  test("read('files/a.pdf') 抛明确错误（不再返回 UTF-8 乱码）", async () => {
    const { adapter, calls } = makeAdapter();
    await expect(adapter.read("files/a.pdf")).rejects.toThrow(/二进制|readBinary/);
    // 明确失败：不下载字节当文本用
    expect(calls).toEqual([]);
  });
});

describe("线 1-⑥ stage=view 埋点", () => {
  test("readBinaryForUser('files/a.pdf') 记 stage=view：kind/mime/bytes/getResourcePath", async () => {
    const diag: DiagEntry[] = [];
    const { adapter } = makeAdapter({ diag: (entry) => diag.push(entry) });

    await adapter.readBinaryForUser("files/a.pdf");

    const view = diag.find((entry) => entry.stage === "view");
    expect(view).toBeDefined();
    expect(view!.path).toBe("files/a.pdf");
    expect(view!.fields).toMatchObject({
      kind: "pdf",
      mime: "application/pdf",
      bytes: pdfBytes.byteLength,
      getResourcePath: "url",
    });
  });

  test("下载失败 → warmup 记 state=failed，onError 拿到原始错误", async () => {
    const logs: Array<{ path: string; state: string; reason?: string }> = [];
    const errors: unknown[] = [];
    const timeout = new QuarkDownloadTimeoutError("下载超时（>20000ms）", false);
    const warmup = createAttachmentWarmup({
      readBinary: async () => {
        throw timeout;
      },
      activeLeaf: () => null,
      log: (entry) => logs.push(entry),
      onError: (_path, error) => errors.push(error),
    });

    await expect(warmup("files/a.pdf")).resolves.toBe(false);
    expect(logs).toEqual([{ path: "files/a.pdf", state: "failed" }]);
    expect(errors[0]).toBe(timeout);
  });
});

describe("线 1-⑦ 大文件超时随大小放宽", () => {
  test("超时下限 20s、上限 120s、按 512KB/s 估算（50MB → 100s）", () => {
    expect(quarkDownloadTimeoutMsForSize(0)).toBe(20_000);
    expect(quarkDownloadTimeoutMsForSize(1024 * 1024)).toBe(20_000); // 2s → 抬到下限
    expect(quarkDownloadTimeoutMsForSize(50 * 1024 * 1024)).toBe(100_000);
    expect(quarkDownloadTimeoutMsForSize(500 * 1024 * 1024)).toBe(120_000); // 封顶
  });

  test("适配器把 size 换算出的 timeoutMs 传给下载器（50MB PDF ≥ 100s）", async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.readBinary("files/big.pdf");
    expect(calls).toHaveLength(1);
    expect(calls[0].timeoutMs).toBe(100_000);
  });
});
