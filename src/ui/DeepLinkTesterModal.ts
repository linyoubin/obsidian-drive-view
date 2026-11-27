/**
 * 0.2.34：深链测试器 UI（第二阶段）。
 *
 * 每行显示：编号 + 优先级 + 外层 scheme + **完整实际发出的串**（可滚动/可选中，便于报错对照）。
 * 结果四选一：对了 / 进 App 但位置不对 / 空白页或报错 / 没进 App。
 */

import { App, Modal, Setting } from "obsidian";

import type { DeeplinkAnswerResult, DeeplinkCandidate2 } from "../adapter/DeepLinkTester2";

export interface DeepLinkTesterModalHost {
  onPick(candidate: DeeplinkCandidate2): void;
}

export class DeepLinkTesterModal extends Modal {
  constructor(
    app: App,
    private readonly candidates: DeeplinkCandidate2[],
    private readonly host: DeepLinkTesterModalHost
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.innerHTML = "";
    contentEl.createEl("p", {
      text: "第二阶段：外层 scheme 已确认可用，这次逐条测「内层 URL 编码」。每条会显示实际发出的完整串。",
    });
    contentEl.createEl("p", {
      text: "建议按编号顺序试：#1 ~ #4 最可能；点完回答四选一。不会创建任何分享。",
      cls: "quark-deeplink-test-hint",
    });
    for (const candidate of this.candidates) {
      const setting = new Setting(contentEl).setName(
        `#${candidate.caseId} ${
          candidate.priority === "most-likely" ? "【最可能】" : candidate.priority === "control" ? "【对照】" : ""
        }${candidate.outerLabel}`
      );
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
