/**
 * 0.2.20 N8：DataAdapter 契约测试不再「自证」。
 *
 * 期望成员清单**硬编码自 Obsidian 官方 API 文档**（`DataAdapter`，共 21 个成员）：
 *   https://docs.obsidian.md/Reference/TypeScript%20API/DataAdapter
 *
 * 与 `QuarkReadOnlyAdapter.prototype` 双向比对：
 *   - 清单里的每个方法，adapter 必须实现（缺一个 fail 并打方法名）；
 *   - adapter 的契约方法（去掉夸克扩展/私有辅助）不得多出清单之外的成员。
 *
 * 不再读 `src/obsidian.d.ts` 文本：d.ts 是给编译器的契约（`implements DataAdapter` 已由
 * tsc 保证），这里只对「官方成员清单 vs 运行期实现」做独立校验，避免自证。
 *
 * 自检用例：故意从清单删一个 → 必须报 missing；故意塞一个不存在的 → 必须报 extra。
 */

import { describe, expect, test } from "bun:test";

import { QuarkReadOnlyAdapter } from "../src/adapter/QuarkReadOnlyAdapter";

/** Obsidian 官方 DataAdapter 的 21 个成员（来源见文件头注释）。 */
const OFFICIAL_DATA_ADAPTER_MEMBERS = [
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

/**
 * 不属于 DataAdapter 契约的 prototype 成员：
 *   - 夸克扩展：`readForBulk`（bulk 预取） / `prefetchNote`（按笔记预取） /
 *     `readBinaryForUser`（0.2.21 S3：用户点开的附件走 background-user）
 *   - 私有辅助方法（TS private 在运行期也在 prototype 上）
 */
const NON_CONTRACT_MEMBERS = new Set([
  "constructor",
  "readForBulk",
  "prefetchNote",
  "readBinaryForUser",
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

function contractMethodNames(): string[] {
  return Object.getOwnPropertyNames(QuarkReadOnlyAdapter.prototype).filter(
    (name) => !NON_CONTRACT_MEMBERS.has(name)
  );
}

/** 双向比对：`expected` 是权威清单，`contractMethodNames()` 是运行期实现。 */
function compareAdapterMembers(expected: readonly string[]): { missing: string[]; extra: string[] } {
  const actual = new Set(contractMethodNames());
  const wanted = new Set(expected);
  return {
    missing: [...wanted].filter((name) => !actual.has(name)),
    extra: [...actual].filter((name) => !wanted.has(name)),
  };
}

describe("0.2.20 N8 DataAdapter 契约（官方 21 成员）双向比对", () => {
  test("官方 21 个成员全部实现，且没有契约外成员", () => {
    expect(OFFICIAL_DATA_ADAPTER_MEMBERS.length).toBe(21);
    const { missing, extra } = compareAdapterMembers(OFFICIAL_DATA_ADAPTER_MEMBERS);
    expect(missing, `QuarkReadOnlyAdapter 缺少实现：${missing.join(", ")}`).toEqual([]);
    expect(extra, `QuarkReadOnlyAdapter 多出契约外成员：${extra.join(", ")}`).toEqual([]);
  });

  test("自检：从期望清单删掉一个成员，比对必须 fail 并打出方法名", () => {
    const mutated = OFFICIAL_DATA_ADAPTER_MEMBERS.filter((name) => name !== "trashLocal");
    // 清单删了 trashLocal，实现里还在 → 双向比对的 extra 必须报出来（测试因此 fail）
    const { extra } = compareAdapterMembers(mutated);
    expect(extra).toEqual(["trashLocal"]);
    expect(extra.join(", ")).toContain("trashLocal");
  });

  test("自检：清单里塞一个 adapter 没实现的成员，必须报 missing", () => {
    const { missing } = compareAdapterMembers([...OFFICIAL_DATA_ADAPTER_MEMBERS, "getFilePath"]);
    expect(missing).toEqual(["getFilePath"]);
    expect(missing.join(", ")).toContain("getFilePath");
  });

  test("4 个同步成员运行期返回 string（不是 Promise），其余返回 Promise", () => {
    const adapter = new QuarkReadOnlyAdapter({
      index: { entries: [] },
      cache: {
        has: () => false,
        get: () => null,
        getResourceUrl: () => "",
        put: () => ({ cached: true }),
        enqueuePrefetch: () => undefined,
      },
      client: { downloadFile: async () => new ArrayBuffer(0) },
      baseAdapter: {} as never,
      allowPrefetch: () => false,
    });
    for (const name of ["getName", "getBasePath", "getFullPath", "getResourcePath"]) {
      const value = (adapter as unknown as Record<string, (path: string) => unknown>)[name]("notes/a.md");
      expect(typeof value, `${name} 必须同步返回 string`).toBe("string");
    }
    const readPromise = (adapter as unknown as { read: (path: string) => unknown }).read("notes/a.md");
    void (readPromise as Promise<unknown>).catch(() => undefined);
    expect(readPromise).toBeInstanceOf(Promise);
    const writePromise = (adapter as unknown as { write: (path: string, data: string) => unknown }).write(
      "notes/a.md",
      "x"
    );
    void (writePromise as Promise<unknown>).catch(() => undefined);
    expect(writePromise).toBeInstanceOf(Promise);
  });
});
