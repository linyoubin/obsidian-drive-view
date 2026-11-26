/**
 * 0.2.28：不可预览文件（docx/xlsx/zip/epub…）的「在夸克打开」确认弹窗。
 *
 * 文案固定：`Obsidian 无法预览 .docx 文件。是否在夸克中打开该文件？`
 * 按钮：在夸克打开 / 取消。只由 main 注入，不直接依赖其它模块。
 */

import { App, Modal, Setting } from "obsidian";

export interface OpenInQuarkModalOptions {
  /** 完整库内路径（仅用于日志，弹窗只显示扩展名）。 */
  path: string;
  /** 小写扩展名（docx/xlsx…）。 */
  extension: string;
  /** 用户点「在夸克打开」。 */
  onConfirm(): void;
  /** 用户取消或关闭弹窗。 */
  onCancel(): void;
}

export class OpenInQuarkModal extends Modal {
  private settled = false;

  constructor(
    app: App,
    private readonly options: OpenInQuarkModalOptions
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.innerHTML = "";
    contentEl.createEl("p", {
      text: `Obsidian 无法预览 .${this.options.extension} 文件。是否在夸克中打开该文件？`,
    });
    contentEl.createEl("p", {
      text: "将打开它所在的夸克网盘目录（当前文件位置），在网页里预览/下载。",
      cls: "quark-open-in-quark-hint",
    });
    const setting = new Setting(contentEl);
    setting.addButton((button) =>
      button.setButtonText("在夸克打开").setCta().onClick(() => {
        this.settle(true);
      })
    );
    setting.addButton((button) =>
      button.setButtonText("取消").onClick(() => {
        this.settle(false);
      })
    );
  }

  onClose(): void {
    this.contentEl.innerHTML = "";
    // 点右上角 × / Esc 关闭 → 视为取消
    if (!this.settled) {
      this.settled = true;
      this.options.onCancel();
    }
  }

  private settle(confirmed: boolean): void {
    if (this.settled) return;
    this.settled = true;
    this.close();
    if (confirmed) this.options.onConfirm();
    else this.options.onCancel();
  }
}
