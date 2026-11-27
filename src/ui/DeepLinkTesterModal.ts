/**
 * 0.2.33：深链测试器 UI（仅调试用途）。
 *
 * 两个弹窗：
 *   1. 候选清单：每行一个「打开」按钮（case 编号 + 来源说明）；
 *   2. 回答：进到 App / 进了浏览器 / 没反应（对应 result=app|browser|nothing）。
 *
 * 逻辑都在 `adapter/DeepLinkTester`，这里只做展示与回调。
 */

import { App, Modal, Setting } from "obsidian";

import type { DeeplinkCandidate } from "../adapter/DeepLinkTester";

export interface DeepLinkTesterModalHost {
  onPick(candidate: DeeplinkCandidate): void;
}

export class DeepLinkTesterModal extends Modal {
  constructor(
    app: App,
    private readonly candidates: DeeplinkCandidate[],
    private readonly host: DeepLinkTesterModalHost
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.innerHTML = "";
    contentEl.createEl("p", {
      text: "逐条点击，观察手机是否进入「夸克-AI旗舰应用」。每次只打开一种格式；点完会问你是否进了 App。",
    });
    contentEl.createEl("p", {
      text: "注意：这些链接不会创建/修改分享，只是打开；确认可用的那条会自动写成深链模板。",
      cls: "quark-deeplink-test-hint",
    });
    for (const candidate of this.candidates) {
      const setting = new Setting(contentEl).setName(`#${candidate.caseId} ${candidate.label}`);
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
  onAnswer(result: "app" | "browser" | "nothing"): void;
}

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
    contentEl.createEl("p", { text: `${this.caseLabel}：进到 App 了吗？` });
    const setting = new Setting(contentEl);
    setting.addButton((button) =>
      button.setButtonText("是，进了 App").setCta().onClick(() => {
        this.settle("app");
      })
    );
    setting.addButton((button) =>
      button.setButtonText("否，进了浏览器").onClick(() => {
        this.settle("browser");
      })
    );
    setting.addButton((button) =>
      button.setButtonText("否，没反应").onClick(() => {
        this.settle("nothing");
      })
    );
  }

  onClose(): void {
    this.contentEl.innerHTML = "";
    // 点 × / Esc 关闭 → 视为「没反应」，保证结果一定被记录
    if (!this.settled) {
      this.settled = true;
      this.host.onAnswer("nothing");
    }
  }

  private settle(result: "app" | "browser" | "nothing"): void {
    if (this.settled) return;
    this.settled = true;
    this.close();
    this.host.onAnswer(result);
  }
}
