import { describe, expect, it } from "vite-plus/test";
import { appendQuickNote, formatSelectionNote, insertNoteMarkdown } from "./noteInsertion";

describe("formatSelectionNote", () => {
  it("quotes every selected line, keeps a comment, and encodes the selection link", () => {
    expect(
      formatSelectionNote(
        { id: "selection/id? 1", selectedText: "一行目\n二行目", pageNumber: 42 },
        "ここを後で確かめる",
      ),
    ).toBe(
      "> 一行目\n> 二行目\n\nここを後で確かめる\n\n<sup>[p.42](?page=42&selection=selection%2Fid%3F%201)</sup>",
    );
  });

  it("does not leave an empty paragraph when no comment was supplied", () => {
    expect(formatSelectionNote({ id: "01KSELECT", selectedText: "引用", pageNumber: 42 }, "")).toBe(
      "> 引用\n\n<sup>[p.42](?page=42&selection=01KSELECT)</sup>",
    );
  });
});

describe("insertNoteMarkdown", () => {
  it("replaces the supplied range and leaves the caret immediately after the insertion", () => {
    expect(insertNoteMarkdown("前置き置換する後置き", "メモ", { start: 3, end: 7 })).toStrictEqual({
      body: "前置きメモ後置き",
      range: { start: 5, end: 5 },
    });
  });

  it("appends with exactly one blank line when there is no caret range", () => {
    expect(insertNoteMarkdown("本文\n\n\n", "挿入")).toStrictEqual({
      body: "本文\n\n挿入",
      range: { start: 6, end: 6 },
    });
  });

  it("clamps an inverted range that runs beyond both ends of the body", () => {
    expect(insertNoteMarkdown("abcdef", "挿入", { start: 99, end: -2 })).toStrictEqual({
      body: "挿入",
      range: { start: 2, end: 2 },
    });
  });
});

describe("appendQuickNote", () => {
  it("starts an empty note with a memo section and a list item", () => {
    expect(appendQuickNote("", "最初のメモ")).toBe("## メモ\n\n- 最初のメモ");
  });

  it("creates a new memo section after ordinary text", () => {
    expect(appendQuickNote("本文", "追記")).toBe("本文\n\n## メモ\n\n- 追記");
  });

  it("adds to the memo section when it is the document's final H2", () => {
    expect(appendQuickNote("本文\n\n## メモ\n\n- 前のメモ", "次のメモ")).toBe(
      "本文\n\n## メモ\n\n- 前のメモ\n- 次のメモ",
    );
  });

  it("adds before the final AI section only when memo immediately precedes it", () => {
    expect(
      appendQuickNote("本文\n\n## メモ\n\n- 前のメモ\n\n## AI とのやりとり\n\n回答", "次のメモ"),
    ).toBe("本文\n\n## メモ\n\n- 前のメモ\n- 次のメモ\n\n## AI とのやりとり\n\n回答");
  });

  it("keeps intentional terminal blank lines after appending to the final memo section", () => {
    expect(appendQuickNote("本文\n\n## メモ\n\n- 前のメモ\n\n\n", "次のメモ")).toBe(
      "本文\n\n## メモ\n\n- 前のメモ\n- 次のメモ\n\n\n",
    );
  });

  it("keeps intentional blank lines between an appended memo item and the AI heading", () => {
    expect(
      appendQuickNote("本文\n\n## メモ\n\n- 前のメモ\n\n\n## AI とのやりとり\n\n回答", "次のメモ"),
    ).toBe("本文\n\n## メモ\n\n- 前のメモ\n- 次のメモ\n\n\n## AI とのやりとり\n\n回答");
  });

  it("does not reuse a memo heading that appears only earlier in the document", () => {
    expect(appendQuickNote("## メモ\n\n- 古い\n\n## 本文\n\n続き", "新しいメモ")).toBe(
      "## メモ\n\n- 古い\n\n## 本文\n\n続き\n\n## メモ\n\n- 新しいメモ",
    );
  });

  it("creates a new memo section when the final AI section does not follow memo", () => {
    expect(appendQuickNote("## 本文\n\n内容\n\n## AI とのやりとり\n\n回答", "新しいメモ")).toBe(
      "## 本文\n\n内容\n\n## AI とのやりとり\n\n回答\n\n## メモ\n\n- 新しいメモ",
    );
  });

  it("ignores a memo-looking heading inside a code fence", () => {
    expect(appendQuickNote("```md\n## メモ\n```\n\n本文", "新しいメモ")).toBe(
      "```md\n## メモ\n```\n\n本文\n\n## メモ\n\n- 新しいメモ",
    );
  });

  it("keeps CRLF line endings while adding to an existing memo section", () => {
    expect(appendQuickNote("本文\r\n\r\n## メモ\r\n\r\n- 前のメモ", "次のメモ")).toBe(
      "本文\r\n\r\n## メモ\r\n\r\n- 前のメモ\r\n- 次のメモ",
    );
  });

  it("works when the document has no final newline", () => {
    expect(appendQuickNote("本文\n\n## メモ\n\n- 前のメモ", "次のメモ")).toBe(
      "本文\n\n## メモ\n\n- 前のメモ\n- 次のメモ",
    );
  });

  it("normalizes trailing blank lines before a newly-created memo section", () => {
    expect(appendQuickNote("本文\n\n\n\n## 本文\n\n\n", "追記")).toBe(
      "本文\n\n\n\n## 本文\n\n## メモ\n\n- 追記",
    );
  });

  it("keeps a selection entry as one multiline list item", () => {
    expect(appendQuickNote("", "> 引用\n\n補足\n\n<sup>[p.42](?page=42&selection=01K)</sup>")).toBe(
      "## メモ\n\n- > 引用\n\n  補足\n\n  <sup>[p.42](?page=42&selection=01K)</sup>",
    );
  });
});
