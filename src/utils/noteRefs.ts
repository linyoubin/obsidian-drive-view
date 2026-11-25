/**
 * noteRefs —— 解析笔记里对附件的引用（0.2.12）。
 *
 * 只做纯文本解析 + 路径归一，不读文件、不碰索引：
 *   - wiki 嵌入：`![[file.jpeg]]`、`![[file.jpeg|300]]`、`![[folder/file.jpeg]]`、`![[file.jpeg#heading]]`
 *   - markdown 嵌入：`![](path)`、`![](<path>)`、`![alt](path "title")`
 *
 * 输出按**出现顺序**；只保留非 `.md/.markdown`（附件）。
 * 路径解析由 `resolveAttachmentRef` 完成：先按笔记所在目录解析，再按库根解析，取索引里存在的那个。
 */

import { getBaseName, getParentPath, normalizeVaultPath } from "./pathUtils";

/** 不预取正文（md 本来就会被 Obsidian 自己读）。 */
export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

/** 去掉引用里可能带的 `#heading`、`|300`（wiki）或 `"title"`（markdown）。 */
function cleanWikiTarget(raw: string): string {
  const withoutHeading = raw.split("#")[0] ?? "";
  const withoutSize = withoutHeading.split("|")[0] ?? "";
  return withoutSize.trim();
}

function cleanMarkdownTarget(raw: string): string {
  const target = raw.trim();
  if (target.startsWith("<")) {
    const end = target.indexOf(">");
    return (end > 0 ? target.slice(1, end) : target.slice(1)).trim();
  }
  // `path "title"` / `path 'title'` / `path (title)` → 取第一段
  const first = target.split(/\s+/)[0] ?? "";
  return first.replace(/^["'(]+/, "").replace(/["')]+$/, "").trim();
}

function pushCandidate(list: string[], value: string): void {
  const cleaned = String(value ?? "").replace(/\\/g, "/").trim();
  if (!cleaned) return;
  list.push(cleaned);
}

/**
 * 提取一篇笔记内容里的附件引用（保持出现顺序、按字符串去重）。
 *
 * 返回的是**原始写法**（相对路径或库内路径），由调用方解析成真实库路径。
 */
export function extractAttachmentRefs(content: string): string[] {
  const text = String(content ?? "");
  if (!text) return [];
  const found: string[] = [];
  const wikiRe = /!\[\[([^\]]+)\]\]/g;
  const mdRe = /!\[[^\]]*\]\(([^)]+)\)/g;

  let match: RegExpExecArray | null = null;
  while ((match = wikiRe.exec(text)) !== null) {
    pushCandidate(found, cleanWikiTarget(match[1] ?? ""));
  }
  while ((match = mdRe.exec(text)) !== null) {
    pushCandidate(found, cleanMarkdownTarget(match[1] ?? ""));
  }

  // 按出现顺序整体排序：两个正则分别扫描，这里以在原文中的位置为准
  const withPositions = found
    .map((raw) => ({ raw, at: text.indexOf(raw) }))
    .filter((item) => item.at >= 0)
    .sort((a, b) => a.at - b.at);

  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of withPositions) {
    if (seen.has(item.raw)) continue;
    seen.add(item.raw);
    result.push(item.raw);
  }
  return result;
}

/** 只保留附件（非 md），并去重；返回候选库路径列表（未解析存在性）。 */
export function attachmentCandidates(refs: string[], notePath: string): string[] {
  const noteDir = getParentPath(normalizeVaultPath(notePath));
  const result: string[] = [];
  const seen = new Set<string>();
  for (const raw of refs) {
    const value = raw.trim();
    if (!value) continue;
    const base = getBaseName(value);
    if (!base || isMarkdownPath(base)) continue; // 只预取附件
    const relative = noteDir ? `${noteDir}/${value.replace(/^\.\//, "")}` : value.replace(/^\.\//, "");
    const fromRoot = value.replace(/^\.\//, "").replace(/^\//, "");
    for (const candidate of [normalizeVaultPath(relative), normalizeVaultPath(fromRoot)]) {
      if (!candidate || seen.has(candidate)) continue;
      seen.add(candidate);
      result.push(candidate);
    }
  }
  return result;
}
