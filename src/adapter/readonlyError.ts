/**
 * ReadOnlyError —— 只读库的写操作拒绝错误（一期：夸克网盘只读）。
 *
 * 设计要点（v3 §3 / §7.3）：
 *   - 12 个写方法一律抛**同一个** `ReadOnlyError`，不返回 false、不静默成功；
 *   - `trashSystem` 必须抛错而不是 `return false`——否则上层会误判「删除成功」；
 *   - 消息里带「只读」，UI 直接展示给用户即可。
 *
 * 不 import `fs`/`path`/`child_process`/`electron`/`node:`。
 */

/** 只读拒绝错误。`operation` 是方法名，`path` 是被拒绝的库内路径。 */
export class ReadOnlyError extends Error {
  /** 被拒绝的方法名，如 `write` / `rmdir`。 */
  readonly operation: string;
  /** 被拒绝的路径（`""` 表示根）。 */
  readonly path: string;

  constructor(operation: string, path = "") {
    super(`夸克网盘为只读模式：不支持 ${operation}（${path || "根目录"}）`);
    this.name = "ReadOnlyError";
    this.operation = operation;
    this.path = path;
  }
}

/** 判定是否为 `ReadOnlyError`（跨模块/跨实例都安全，按 name + 形状）。 */
export function isReadOnlyError(value: unknown): value is ReadOnlyError {
  if (value instanceof ReadOnlyError) return true;
  if (!value || typeof value !== "object") return false;
  const candidate = value as { name?: unknown; operation?: unknown; message?: unknown };
  return (
    candidate.name === "ReadOnlyError" &&
    typeof candidate.operation === "string" &&
    typeof candidate.message === "string"
  );
}

/** 统一抛错入口：少写 12 遍 `throw new ReadOnlyError(...)`。 */
export function rejectWrite(operation: string, path = ""): never {
  throw new ReadOnlyError(operation, path);
}
