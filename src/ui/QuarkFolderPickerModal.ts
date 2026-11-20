/**
 * QuarkFolderPickerModal —— 从夸克网盘根（fid `"0"`）逐层浏览，选一个**目录**作为 Obsidian 库根。
 *
 * 语义（T-10）：
 *   - 选定目录后，索引里的 path **相对该目录**，Obsidian 的 `/` 就是它；
 *   - 只能选文件夹（列表里只展示目录，文件不出现）；
 *   - 选择器本身只读，不写任何东西。
 *
 * 纯函数 `normalizeQuarkPath` / `joinQuarkPath` / `describeQuarkPath` 导出以便单测。
 */

import * as obsidianRuntime from "obsidian";
import type { App } from "obsidian";

/** 只需要列目录能力（`QuarkClient` 结构上满足）。 */
export interface QuarkFolderLister {
  listDir(
    fid: string,
    options?: { all?: boolean }
  ): Promise<{ items: Array<{ fid: string; name: string; isFolder: boolean }> }>;
}

/** 网盘根 fid。 */
export const QUARK_ROOT_FID = "0";

/** 归一化网盘路径：始终以 `/` 开头、无尾斜杠，根为 `/`。 */
export function normalizeQuarkPath(path: string | null | undefined): string {
  const raw = String(path ?? "").replace(/\\/g, "/").trim();
  const parts = raw.split("/").filter((part) => part.length > 0);
  return parts.length === 0 ? "/" : `/${parts.join("/")}`;
}

/** 拼接子目录路径（父为 `/` 时得到 `/子`）。 */
export function joinQuarkPath(parentPath: string, name: string): string {
  const parent = normalizeQuarkPath(parentPath);
  const child = String(name ?? "").trim();
  if (!child) return parent;
  return parent === "/" ? `/${child}` : `${parent}/${child}`;
}

/** 展示用：`/` → `根目录`，`/知识库_云端` → `/知识库_云端`。 */
export function describeQuarkPath(path: string | null | undefined): string {
  const normalized = normalizeQuarkPath(path);
  return normalized === "/" ? "根目录（整个网盘）" : normalized;
}

export interface QuarkFolderPickerOptions {
  app: App;
  client: QuarkFolderLister;
  /** 初始定位（默认网盘根）。 */
  initialFid?: string;
  initialPath?: string;
  /** 选定回调（fid + 展示路径）。 */
  onChoose: (fid: string, path: string) => void | Promise<void>;
  /** 取消/直接关窗回调（没选定就关）。 */
  onCancel?: () => void;
}

interface ModalLike {
  app: App;
  contentEl: HTMLElement;
  open(): void;
  close(): void;
  onOpen(): void;
  onClose(): void;
}
type ModalCtor = new (app: App) => ModalLike;

function modalBase(): ModalCtor {
  const runtime = obsidianRuntime as unknown as { Modal?: ModalCtor };
  if (runtime.Modal) return runtime.Modal;
  class StubModal implements ModalLike {
    app: App;
    contentEl: HTMLElement;
    constructor(app: App) {
      this.app = app;
      this.contentEl = {} as HTMLElement;
    }
    open(): void {}
    close(): void {}
    onOpen(): void {}
    onClose(): void {}
  }
  return StubModal;
}

interface FolderCrumb {
  fid: string;
  path: string;
}

export class QuarkFolderPickerModal extends modalBase() {
  private readonly options: QuarkFolderPickerOptions;
  private crumbs: FolderCrumb[] = [];
  private current: FolderCrumb;
  private listEl: HTMLElement | null = null;
  private pathEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private closed = false;
  private chosen = false;

  constructor(options: QuarkFolderPickerOptions) {
    super(options.app);
    this.options = options;
    this.current = {
      fid: options.initialFid && options.initialFid !== "" ? options.initialFid : QUARK_ROOT_FID,
      path: normalizeQuarkPath(options.initialPath ?? "/"),
    };
  }

  onOpen(): void {
    const content = this.contentEl;
    content.empty();
    content.createEl("h3", { text: "选择库根目录" });
    this.pathEl = content.createEl("div", { text: `当前：${describeQuarkPath(this.current.path)}` });
    this.statusEl = content.createEl("div", { text: "加载中…" });

    const actions = content.createEl("div");
    const up = actions.createEl("button", { text: "上一级" });
    up.addEventListener("click", () => void this.goUp());
    const pick = actions.createEl("button", { text: "选这个目录" });
    pick.addEventListener("click", () => void this.choose());
    const cancel = actions.createEl("button", { text: "取消" });
    cancel.addEventListener("click", () => this.close());

    this.listEl = content.createEl("div");
    void this.load(this.current);
  }

  onClose(): void {
    this.closed = true;
    this.contentEl.empty();
    if (!this.chosen) this.options.onCancel?.();
  }

  /** 进入子目录。 */
  private async enter(folder: { fid: string; name: string }): Promise<void> {
    this.crumbs.push(this.current);
    await this.load({ fid: folder.fid, path: joinQuarkPath(this.current.path, folder.name) });
  }

  /** 返回上一级（到根时什么都不做）。 */
  private async goUp(): Promise<void> {
    const previous = this.crumbs.pop();
    if (!previous) return;
    await this.load(previous);
  }

  private async load(folder: FolderCrumb): Promise<void> {
    this.current = folder;
    if (this.pathEl) this.pathEl.setText(`当前：${describeQuarkPath(folder.path)}`);
    if (this.statusEl) this.statusEl.setText("加载中…");
    if (this.listEl) this.listEl.empty();

    try {
      const result = await this.options.client.listDir(folder.fid, { all: true });
      if (this.closed) return;
      const folders = result.items.filter((item) => item.isFolder);
      if (this.statusEl) {
        this.statusEl.setText(
          folders.length === 0 ? "这个目录下没有子目录，可以直接选它" : `共 ${folders.length} 个子目录`
        );
      }
      if (!this.listEl) return;
      for (const child of folders) {
        const row = this.listEl.createEl("button", { text: `📁 ${child.name}` });
        row.addEventListener("click", () => void this.enter(child));
      }
    } catch (error) {
      if (this.statusEl) {
        this.statusEl.setText(`列目录失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private async choose(): Promise<void> {
    const chosen = this.current;
    this.chosen = true;
    this.close();
    await this.options.onChoose(chosen.fid, normalizeQuarkPath(chosen.path));
  }
}
