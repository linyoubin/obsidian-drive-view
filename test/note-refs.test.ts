/**
 * 笔记引用解析（0.2.12/0.2.13）：六种写法、只取附件、顺序与去重。
 */

import { describe, expect, test } from "bun:test";

import { attachmentCandidates, extractAttachmentRefs } from "../src/utils/noteRefs";

describe("noteRefs：六种引用写法", () => {
  test("六种写法都能解析，且保持出现顺序", () => {
    const content = [
      "![[a.jpeg]]",
      "![[b.jpeg|300]]",
      "![[dir/c.jpeg]]",
      "![[d.jpeg#heading]]",
      "![](e.png)",
      "![](<f g.png>)",
      '![alt](h.png "title")',
    ].join("\n");
    expect(extractAttachmentRefs(content)).toEqual([
      "a.jpeg",
      "b.jpeg",
      "dir/c.jpeg",
      "d.jpeg",
      "e.png",
      "f g.png",
      "h.png",
    ]);
  });

  test("wiki 同时带 heading 与尺寸：只取文件名", () => {
    expect(extractAttachmentRefs("![[img/x.jpeg#top|200]]")).toEqual(["img/x.jpeg"]);
  });

  test("markdown 带尖括号与 title：剥离括号和 title", () => {
    expect(extractAttachmentRefs('![](<sub/a b.png> "cap")')).toEqual(["sub/a b.png"]);
  });

  test("只保留附件：md 链接被过滤；不存在于内容里的不产生", () => {
    const refs = extractAttachmentRefs("[[note.md]] ![](other.md) ![](pic.png)");
    const candidates = attachmentCandidates(refs, "notes/a.md");
    expect(candidates).toContain("notes/pic.png");
    expect(candidates.some((path) => /\.md$/i.test(path))).toBe(false);
  });

  test("去重：同一引用出现两次只保留一次", () => {
    expect(extractAttachmentRefs("![[a.png]] ![[a.png]] ![](a.png)")).toEqual(["a.png"]);
  });
});
