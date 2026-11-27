/**
 * 0.2.34：深链测试器 UI（第二阶段）。
 *
 * 每行显示：编号 + 优先级 + 外层 scheme + **完整实际发出的串**（可滚动/可选中，便于报错对照）。
 * 结果四选一：对了 / 进 App 但位置不对 / 空白页或报错 / 没进 App。
 */

import { App, Modal, Setting } from "obsidian";

import type { ControlCandidate } from "../adapter/DeepLinkTester3";
import type { DeeplinkAnswerResult } from "../adapter/DeepLinkTester2";

export interface DeepLinkTesterModalHost {
  onPick(candidate: ControlCandidate): void;
}

export class DeepLinkTesterModal extends Modal {
  constructor(
    app: App,
    private readonly candidates: ControlCandidate[],
    private readonly host: DeepLinkTesterModalHost
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.innerHTML = "";
    contentEl.createEl("p", {
      text: "第三阶段（控制组）：先测 App 能不能打开任意网页，再判断目标链接是否被拒。每条显示实际发出的完整串。",
    });
    contentEl.createEl("p", {
      text: "请先点 #1/#2/#3 控制组：若它们也空白/报错，说明该 App 不支持外部网页深链，继续试后面的变体意义不大。不会创建任何分享。",
      cls: "quark-deeplink-test-hint",
    });
    for (const candidate of this.candidates) {
      const groupTag =
        candidate.group === "control" ? "【控制组】" : candidate.group === "target" ? "【目标·已知失败】" : "【变体】";
      const setting = new Setting(contentEl).setName(`#${candidate.caseId} ${groupTag}${candidate.outerLabel}`);
      const urlEl = contentEl.createDiv({ cls: "quark-deeplink-test-url" });
      urlEl.style.whiteSpace = "pre-wrap";
      urlEl.style.wordBreak = "break-all";
      urlEl.style.fontFamily = "var(--font-monospace)";
      urlEl.style.fontSize = "0.8em";
      urlEl.style.userSelect = "text";
      urlEl.textContent = candidate.url;
      setting.addButton((button) =>
        button.setButtonText("打开").setCta().onClick(() => {
          this.close();
          this.host.onPick(candidate);
        })
      );
    }
  }

  onClose(): void {
    this.contentEl.innerHTML = "";
  }
}

export interface DeepLinkAnswerModalHost {
  onAnswer(result: DeeplinkAnswerResult): void;
}

const ANSWER_BUTTONS: Array<{ result: DeeplinkAnswerResult; text: string }> = [
  { result: "ok", text: "对了（位置正确）" },
  { result: "wrong-place", text: "进 App 了，但位置不对" },
  { result: "blank", text: "空白页或报错" },
  { result: "no-app", text: "没进 App" },
];

export class DeepLinkAnswerModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly caseLabel: string,
    private readonly host: DeepLinkAnswerModalHost
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.innerHTML = "";
    contentEl.createEl("p", { text: `${this.caseLabel}：结果如何？` });
    const setting = new Setting(contentEl);
    for (const option of ANSWER_BUTTONS) {
      setting.addButton((button) =>
        button.setButtonText(option.text).onClick(() => {
          this.settle(option.result);
        })
      );
    }
  }

  onClose(): void {
    this.contentEl.innerHTML = "";
    // 点 × / Esc → 视为「没进 App」，保证结果一定被记录
    if (!this.settled) {
      this.settled = true;
      this.host.onAnswer("no-app");
    }
  }

  private settle(result: DeeplinkAnswerResult): void {
    if (this.settled) return;
    this.settled = true;
    this.close();
    this.host.onAnswer(result);
  }
}
