/**
 * Quark UI 层单测（纯函数化后的逻辑）。
 *
 * 覆盖契约 T-09 v2：二维码内容构造（A3）、ribbon 点击分支（A3/A4）、状态文案三态（A6）、
 * 设置页三项状态判定（A5）、倒计时格式。
 *
 * 不渲染真实 DOM：`obsidian` 的 Modal/Setting/PluginSettingTab 全部用最小 mock 顶替。
 */

import { describe, expect, mock, test } from "bun:test";

mock.module("obsidian", () => {
  class MockModal {
    app: unknown;
    contentEl: unknown;
    constructor(app: unknown) {
      this.app = app;
      this.contentEl = {};
    }
    open(): void {}
    close(): void {}
    onOpen(): void {}
    onClose(): void {}
  }
  class MockPluginSettingTab {
    app: unknown;
    containerEl: unknown;
    constructor(app: unknown) {
      this.app = app;
      this.containerEl = {};
    }
    display(): void {}
    hide(): void {}
  }
  class MockSetting {
    constructor(_container: unknown) {}
    setName(): this {
      return this;
    }
    setDesc(): this {
      return this;
    }
    setHeading(): this {
      return this;
    }
    addButton(): this {
      return this;
    }
    addText(): this {
      return this;
    }
    addToggle(): this {
      return this;
    }
  }
  class MockNotice {
    constructor(_message: string, _timeout?: number) {}
  }
  return {
    Modal: MockModal,
    PluginSettingTab: MockPluginSettingTab,
    Setting: MockSetting,
    Notice: MockNotice,
    Platform: {
      isDesktop: true,
      isMobile: false,
      isDesktopApp: true,
      isMobileApp: false,
      isIosApp: false,
      isAndroidApp: false,
    },
  };
});

const qrModal = await import("../src/ui/QuarkQrModal");
const settingsTab = await import("../src/ui/QuarkSettingsTab");
const vendor = await import("../src/vendor/qr");
const qrAuth = await import("../src/auth/QuarkQrAuth");

type Snapshot = import("../src/ui/QuarkSettingsTab").QuarkUiSnapshot;

function snapshot(patch: Partial<Snapshot> = {}): Snapshot {
  return { ...settingsTab.EMPTY_QUARK_SNAPSHOT, ...patch };
}

// ------------------------------------------------------------------ 二维码

describe("QuarkQrModal：二维码内容与 canvas 渲染前提", () => {
  test("二维码内容 = 完整 5 参数 URL，且能被 vendor 编码器编码", () => {
    const payload = qrAuth.buildQrContent("TOKEN_XYZ");
    expect(payload).toContain("https://su.quark.cn/4_eMHBJ?token=TOKEN_XYZ");
    expect(payload).toContain("&client_id=532");
    expect(payload).toContain("&ssb=weblogin");
    expect(payload).toContain("&uc_param_str=");
    expect(payload).toContain("%7C");
    expect(payload).toContain("%40");
    expect(payload).toContain("%3A");

    const qr = vendor.createQrCode(0, "M");
    qr.addData(payload);
    qr.make();
    const count = qr.getModuleCount();
    expect(count).toBeGreaterThan(20);
    expect(count).toBeLessThanOrEqual(177); // 版本 40 上限
    // 有黑格、也有白格（否则等于没画）
    let dark = 0;
    for (let row = 0; row < count; row += 1) {
      for (let col = 0; col < count; col += 1) {
        if (qr.isDark(row, col)) dark += 1;
      }
    }
    expect(dark).toBeGreaterThan(0);
    expect(dark).toBeLessThan(count * count);
  });

  test("短 URL（只带 token）与完整 URL 的矩阵不同 —— 防止退回 66 字符短链", () => {
    const full = vendor.createQrCode(0, "M");
    full.addData(qrAuth.buildQrContent("T1"));
    full.make();
    const short = vendor.createQrCode(0, "M");
    short.addData("https://su.quark.cn/4_eMHBJ?token=T1");
    short.make();
    expect(full.getModuleCount()).not.toBe(short.getModuleCount());
  });
});

// ------------------------------------------------------------------ 倒计时与状态

describe("QuarkQrModal：倒计时与状态文案", () => {
  test("倒计时：满 180 秒 / 即将过期 / 归零三种形态", () => {
    expect(qrModal.formatCountdown(180000)).toBe(
      "剩余 180 秒（客户端上限 180 秒；服务端实测 184 秒）"
    );
    expect(qrModal.formatCountdown(29000)).toContain("剩余 29 秒（即将过期）");
    expect(qrModal.formatCountdown(0)).toBe(
      "剩余 0 秒（即将过期）（客户端上限 180 秒；服务端实测 184 秒）"
    );
  });

  test("状态映射：五个关键状态文案互不相同且含关键词", () => {
    expect(qrModal.describeQrState("waiting")).toContain("等待扫码");
    expect(qrModal.describeQrState("expired")).toContain("已过期");
    expect(qrModal.describeQrState("timeout")).toContain("超时");
    expect(qrModal.describeQrState("failed")).toContain("失败");
    expect(qrModal.describeQrState("canceled")).toContain("取消");
    expect(qrModal.describeQrState("success")).toBe("登录成功");
    expect(qrModal.describeQrState("preparing")).toContain("二维码");
  });

  test("进度文案：只含阶段/计数，不含任何 cookie 值", () => {
    const text = qrModal.describeProgress({
      state: "waiting",
      phase: "poll",
      message: "等待扫码/确认…",
      status: 50004001,
      attempt: 3,
      remainingMs: 120000,
      cookieNames: ["__pus", "__kps"],
    });
    expect(text).toContain("[poll]");
    expect(text).toContain("status=50004001");
    expect(text).toContain("第 3 次");
    expect(text).toContain("收到 2 条 cookie");
    // 不含 name=value 形态
    expect(text).not.toMatch(/__pus=/);
    expect(text).not.toMatch(/__kps=/);
  });

  test("确认框正文：有快照显示条目数与时间，无快照显示「从未建立 / 无」", () => {
    const builtAt = new Date(2026, 10, 20, 15, 40).getTime();
    const withSnapshot = qrModal.describeSyncPrompt(snapshot({ indexCount: 128, builtAt }));
    expect(withSnapshot).toContain("上次同步：2026-11-20 15:40");
    expect(withSnapshot).toContain("128 条");

    const empty = qrModal.describeSyncPrompt(snapshot());
    expect(empty).toContain("从未建立");
    expect(empty).toContain("索引条目 无");
  });
});

// ------------------------------------------------------------------ ribbon 分支

describe("QuarkSettingsTab：ribbon 点击分支（A3/A4）", () => {
  test("未登录 / 已过期 → 先扫码；已登录 → 先确认同步", () => {
    expect(settingsTab.planQuarkRibbonAction(snapshot({ loginState: "none" }))).toBe("login");
    expect(settingsTab.planQuarkRibbonAction(snapshot({ loginState: "expired" }))).toBe("login");
    expect(settingsTab.planQuarkRibbonAction(snapshot({ loginState: "active" }))).toBe("sync");
    // 已登录但未挂载 / 已挂载，都走确认同步
    expect(
      settingsTab.planQuarkRibbonAction(snapshot({ loginState: "active", mounted: false }))
    ).toBe("sync");
    expect(settingsTab.planQuarkRibbonAction(snapshot({ loginState: "active", mounted: true }))).toBe(
      "sync"
    );
  });
});

// ------------------------------------------------------------------ 设置页三项状态

describe("QuarkSettingsTab：登录态 / 索引态 / 缓存态文案（A5）", () => {
  test("登录态三态，且只报 cookie 名称个数", () => {
    expect(settingsTab.describeLoginState("none", 0)).toBe("未登录");
    expect(settingsTab.describeLoginState("active", 6)).toBe("已登录（6 个 cookie）");
    expect(settingsTab.describeLoginState("expired", 4)).toContain("登录已过期");
    expect(settingsTab.describeLoginState("expired", 4)).toContain("4 个 cookie");
    // 文案里不出现 name=value
    expect(settingsTab.describeLoginState("active", 6)).not.toContain("=");
  });

  test("索引态：无快照 / 有快照 / 索引中 / 降级", () => {
    expect(settingsTab.describeIndexState(snapshot())).toBe("无快照");
    expect(settingsTab.describeIndexState(snapshot({ degraded: true }))).toBe("无快照（索引未持久化）");

    const builtAt = new Date(2026, 10, 20, 15, 40).getTime();
    const withIndex = settingsTab.describeIndexState(
      snapshot({ indexCount: 245, builtAt, version: 3 })
    );
    expect(withIndex).toContain("245 条");
    expect(withIndex).toContain("v3");
    expect(withIndex).toContain("2026-11-20 15:40");

    const scanning = settingsTab.describeIndexState(
      snapshot({ indexCount: 10, builtAt, indexing: true, scannedFolders: 7, pendingFolders: 12 })
    );
    expect(scanning).toContain("索引中：已扫 7 个目录、待扫 12 个");
  });

  test("缓存态与字节格式化", () => {
    expect(settingsTab.formatBytes(0)).toBe("0 B");
    expect(settingsTab.formatBytes(900)).toBe("900 B");
    expect(settingsTab.formatBytes(1536)).toBe("1.5 KB");
    expect(settingsTab.formatBytes(8 * 1024 * 1024)).toBe("8.0 MB");
    expect(settingsTab.describeCacheState(2 * 1024 * 1024, 8 * 1024 * 1024)).toBe(
      "2.0 MB / 8.0 MB（25%）"
    );
    expect(settingsTab.describeMountedState(true)).toBe("已挂载（只读）");
    expect(settingsTab.describeMountedState(false)).toBe("未挂载");
  });
});

// ------------------------------------------------------------------ 状态栏三态

describe("QuarkSettingsTab：状态栏三态（A6）", () => {
  test("未登录 / 已登录未挂载 / 已挂载（带索引时间）三种文案互不相同", () => {
    const none = settingsTab.describeStatusBar(snapshot({ loginState: "none" }));
    const loggedIn = settingsTab.describeStatusBar(snapshot({ loginState: "active", indexCount: 5 }));
    const builtAt = new Date(2026, 10, 20, 15, 40).getTime();
    const mounted = settingsTab.describeStatusBar(
      snapshot({ loginState: "active", mounted: true, indexCount: 5, builtAt })
    );

    expect(none).toBe("Quark 只读：未登录");
    expect(loggedIn).toBe("Quark 只读：已登录未挂载");
    expect(mounted).toContain("Quark 只读：已挂载");
    expect(mounted).toContain("2026-11-20 15:40");
    expect(new Set([none, loggedIn, mounted]).size).toBe(3);
  });

  test("索引中优先显示进度（状态栏可当进度指示）", () => {
    const scanning = settingsTab.describeStatusBar(
      snapshot({ loginState: "active", indexing: true, scannedFolders: 12, pendingFolders: 182 })
    );
    expect(scanning).toBe("Quark 只读：索引中 12/194 个目录");
  });

  test("时间格式化：0 显示「从未建立」，合法时间戳显示本地时间", () => {
    expect(settingsTab.formatBuiltAt(0)).toBe("从未建立");
    expect(settingsTab.formatBuiltAt(-1)).toBe("从未建立");
    const local = new Date(2026, 10, 20, 9, 5).getTime();
    expect(settingsTab.formatBuiltAt(local)).toBe("2026-11-20 09:05");
  });
});
