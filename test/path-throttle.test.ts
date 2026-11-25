/**
 * 预取后重绘的节流闸（0.2.9）：同一 path 1 秒内最多放行一次。
 */

import { describe, expect, test } from "bun:test";

import { createPathThrottle } from "../src/utils/pathUtils";

describe("createPathThrottle：预取后刷新节流（0.2.9）", () => {
  test("同一 path 1s 内只放行一次；不同 path 互不影响", () => {
    let now = 0;
    const allow = createPathThrottle(1000, () => now);
    expect(allow("a.md")).toBe(true);
    expect(allow("a.md")).toBe(false);
    now = 500;
    expect(allow("a.md")).toBe(false);
    expect(allow("b.md")).toBe(true); // 其它文件不受影响
    now = 1000; // 满 1s
    expect(allow("a.md")).toBe(true);
  });

  test("一次预取 20 个附件：同一文件只重绘 1 次", () => {
    const allow = createPathThrottle(1000, () => 1234);
    let rerenders = 0;
    for (let i = 0; i < 20; i += 1) {
      if (allow("notes/a.md")) rerenders += 1;
    }
    expect(rerenders).toBe(1);
  });
});
