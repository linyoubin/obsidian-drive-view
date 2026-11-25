/**
 * 0.2.18 SF5：`src/obsidian.d.ts` 的 DataAdapter 声明与 QuarkReadOnlyAdapter 一致性。
 *
 * 直接读 d.ts 文本做静态断言（不依赖 `obsidian` 运行时）：
 *   1. `QuarkReadOnlyAdapter.prototype` 上的每个方法（除明确列为「夸克扩展/私有辅助」的）都必须在
 *      `interface DataAdapter` 里有声明，缺一个就 fail 并打方法名；
 *   2. DataAdapter 的 22 个契约成员一个不少、反向也必须都有实现；
 *   3. 同步方法写 `string`，异步方法写 `Promise<T>`。
 */

import { describe, expect, test } from "bun:test";

import { QuarkReadOnlyAdapter } from "../src/adapter/QuarkReadOnlyAdapter";

/** v3 §3 / Obsidian DataAdapter 的全部成员（0.2.18 口径）。 */
const DATA_ADAPTER_MEMBERS = [
  "getName",
  "getBasePath",
  "getFullPath",
  "getResourcePath",
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
  "mkdir",
  "rmdir",
  "remove",
  "rename",
  "copy",
  "trashSystem",
  "trashLocal",
] as const;

/** 同步返回 string 的成员；其余契约成员必须返回 `Promise<T>`。 */
const SYNC_MEMBERS = new Set(["getName", "getBasePath", "getFullPath", "getResourcePath"]);

/**
 * 不属于 DataAdapter 契约的 prototype 成员：
 *   - 夸克扩展：`readForBulk`（bulk 预取） / `prefetchNote`（按笔记预取）
 *   - 私有辅助方法（TS private 在运行期也在 prototype 上）
 */
const NON_ADAPTER_MEMBERS = new Set([
  "constructor",
  "readForBulk",
  "prefetchNote",
  "rejectWrite",
  "shouldForward",
  "findEntry",
  "loadBinary",
  "reportInfo",
  "reportDiagnostic",
  "prefetchEnabled",
  "reportDiag",
  "alreadyLogged",
  "reportDiagOnce",
  "downloadPriority",
  "fidOf",
]);

async function readDts(): Promise<string> {
  return await Bun.file(new URL("../src/obsidian.d.ts", import.meta.url)).text();
}

/** 取 `interface DataAdapter { ... }` 的正文（含成员声明行）。 */
function dataAdapterBlock(source: string): string {
  const start = source.indexOf("interface DataAdapter {");
  if (start < 0) return "";
  const rest = source.slice(start);
  const end = rest.indexOf("\n  }");
  return end < 0 ? rest : rest.slice(0, end);
}

/** 取某个成员的完整声明（支持跨行签名，直到 `;`）。 */
function memberSignature(block: string, name: string): string {
  const lines = block.split("\n");
  const head = new RegExp(`^\\s*${name}\\s*\\(`);
  for (let index = 0; index < lines.length; index += 1) {
    if (!head.test(lines[index])) continue;
    let signature = lines[index];
    let cursor = index;
    while (!signature.includes(";") && cursor + 1 < lines.length) {
      cursor += 1;
      signature += lines[cursor];
    }
    return signature;
  }
  return "";
}

describe("0.2.18 SF5 obsidian.d.ts ↔ QuarkReadOnlyAdapter 一致性", () => {
  test("prototype 上每个契约方法都在 DataAdapter 里有声明（缺一个就 fail 并打名字）", async () => {
    const block = dataAdapterBlock(await readDts());
    expect(block.length).toBeGreaterThan(0);

    const prototypeNames = Object.getOwnPropertyNames(QuarkReadOnlyAdapter.prototype).filter(
      (name) => !NON_ADAPTER_MEMBERS.has(name)
    );
    const missing = prototypeNames.filter((name) => memberSignature(block, name) === "");
    expect(missing, `DataAdapter 缺少声明：${missing.join(", ")}`).toEqual([]);
  });

  test("DataAdapter 22 个契约成员全部声明且 adapter 都有实现", async () => {
    const block = dataAdapterBlock(await readDts());
    const missingInDts = DATA_ADAPTER_MEMBERS.filter((name) => memberSignature(block, name) === "");
    expect(missingInDts, `DataAdapter 缺少声明：${missingInDts.join(", ")}`).toEqual([]);

    const missingInAdapter = DATA_ADAPTER_MEMBERS.filter(
      (name) => typeof (QuarkReadOnlyAdapter.prototype as unknown as Record<string, unknown>)[name] !== "function"
    );
    expect(missingInAdapter, `QuarkReadOnlyAdapter 缺少实现：${missingInAdapter.join(", ")}`).toEqual([]);
  });

  test("返回类型写清：同步 4 个为 string，其余为 Promise<T>", async () => {
    const block = dataAdapterBlock(await readDts());
    for (const name of DATA_ADAPTER_MEMBERS) {
      const signature = memberSignature(block, name);
      expect(signature, `DataAdapter 缺少 ${name} 的声明`).not.toBe("");
      if (SYNC_MEMBERS.has(name)) {
        expect(signature, `${name} 必须是同步 string`).toMatch(/\)\s*:\s*string;$/);
      } else {
        expect(signature, `${name} 必须返回 Promise`).toMatch(/\)\s*:\s*Promise</);
      }
    }
  });
});
