/**
 * 0.2.20 N9：退出只读后必须解绑 `file-open`。
 *
 * 现状：`mountQuark` 注册的 file-open 处理器在 `quarkExitReadOnly` / `onunload`
 * 里都不解绑 → 退出后打开本地附件仍走 quarkAdapter 联网。
 *
 * 用例：绑定 → open 附件触发下载；`stop()` 后（以及未挂载时）再 open → transport 0 调用。
 */

import { describe, expect, test } from "bun:test";

import {
  QuarkFileOpenBinding,
  QuarkReadOnlyAdapter,
  createAttachmentWarmup,
} from "../src/adapter/QuarkReadOnlyAdapter";
import type { IndexEntry } from "../src/store/IndexStore";

const ENTRIES: IndexEntry[] = [
  { path: "img/a.jpeg", type: "file", fid: "fid-img", parentFid: "", size: 6, mtime: 1 },
];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(condition: () => boolean, timeoutMs = 500): Promise<void> {
  const startedAt = Date.now();
  while (!condition()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error("waitFor timeout");
    await delay(5);
  }
}

function makeHarness() {
  const downloads: string[] = [];
  const adapter = new QuarkReadOnlyAdapter({
    index: { entries: ENTRIES },
    cache: {
      has: () => false,
      get: () => null,
      getResourceUrl: () => "",
      put: () => ({ cached: true }),
      enqueuePrefetch: () => undefined,
    },
    client: {
      downloadFile: async (fid: string) => {
        downloads.push(fid);
        return new TextEncoder().encode("binary").buffer as ArrayBuffer;
      },
    },
    baseAdapter: {} as never,
    allowPrefetch: () => false,
  });

  const handlers = new Set<() => void>();
  let mounted = true;
  const workspace = {
    on(_name: string, callback: () => void) {
      handlers.add(callback);
      return { ref: callback };
    },
    offref(ref: { ref?: unknown }) {
      const callback = ref.ref as (() => void) | undefined;
      if (callback) handlers.delete(callback);
    },
  };
  const fire = () => {
    for (const handler of [...handlers]) handler();
  };
  const warm = createAttachmentWarmup({
    readBinary: (path) => adapter.readBinary(path),
    redraw: () => undefined,
  });
  const binding = new QuarkFileOpenBinding({
    onFileOpen: (callback) => workspace.on("file-open", callback),
    offFileOpen: (ref) => workspace.offref(ref),
    isActive: () => mounted,
    onOpen: () => {
      void warm("img/a.jpeg");
    },
  });
  return {
    binding,
    fire,
    downloads,
    setMounted: (value: boolean) => {
      mounted = value;
    },
    handlerCount: () => handlers.size,
  };
}

describe("0.2.20 N9 file-open 解绑", () => {
  test("绑定后 open 附件触发下载；stop() 后再 open 不触发", async () => {
    const harness = makeHarness();
    harness.binding.start();
    expect(harness.handlerCount()).toBe(1);

    harness.fire();
    await waitFor(() => harness.downloads.length === 1);

    harness.binding.stop();
    expect(harness.handlerCount()).toBe(0);
    harness.fire();
    await delay(30);
    expect(harness.downloads.length).toBe(1);
  });

  test("未挂载（isActive=false）时即使还绑着也不下载", async () => {
    const harness = makeHarness();
    harness.binding.start();
    harness.setMounted(false);

    harness.fire();
    await delay(30);

    expect(harness.downloads).toEqual([]);
    harness.binding.stop();
  });

  test("重复 start 不会重复注册", () => {
    const harness = makeHarness();
    harness.binding.start();
    harness.binding.start();
    expect(harness.handlerCount()).toBe(1);
    harness.binding.stop();
    expect(harness.handlerCount()).toBe(0);
  });
});
