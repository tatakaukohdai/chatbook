import { describe, it, expect } from "vite-plus/test";
import { applyMarkdownCommand } from "./markdownCommands";

/**
 * Writes the result the way a reader sees it, with `|` for the caret and the
 * selection between two of them — an assertion on three separate numbers says
 * nothing about where the cursor actually ended up.
 */
function shown(result: { text: string; selStart: number; selEnd: number }): string {
  const { text, selStart, selEnd } = result;
  return selStart === selEnd
    ? `${text.slice(0, selStart)}|${text.slice(selStart)}`
    : `${text.slice(0, selStart)}|${text.slice(selStart, selEnd)}|${text.slice(selEnd)}`;
}

describe("applyMarkdownCommand", () => {
  describe("bold", () => {
    it("wraps what the reader picked, and keeps it picked", () => {
      const result = applyMarkdownCommand("Raft は過半数で決める", 0, 4, "bold");

      expect(shown(result)).toBe("**|Raft|** は過半数で決める");
    });

    it("takes the marks back off a passage that already has them", () => {
      const result = applyMarkdownCommand("**Raft** は過半数で決める", 2, 6, "bold");

      expect(shown(result)).toBe("|Raft| は過半数で決める");
    });

    it("leaves the caret between the marks when nothing is picked", () => {
      // Otherwise the reader has to walk back over two asterisks before typing
      const result = applyMarkdownCommand("メモ: ", 4, 4, "bold");

      expect(shown(result)).toBe("メモ: **|**");
    });
  });

  describe("heading", () => {
    it("marks the line the caret is on, wherever in it the caret sits", () => {
      const result = applyMarkdownCommand("ログ複製\n次の行", 2, 2, "heading");

      expect(shown(result)).toBe("## ログ|複製\n次の行");
    });

    it("takes the marking off a line that already has it", () => {
      const result = applyMarkdownCommand("## ログ複製\n次の行", 5, 5, "heading");

      expect(shown(result)).toBe("ログ|複製\n次の行");
    });

    it("marks every line the selection runs through", () => {
      const result = applyMarkdownCommand("一つ目\n二つ目\n三つ目", 1, 8, "heading");

      expect(shown(result)).toBe("|## 一つ目\n## 二つ目\n## 三つ目|");
    });
  });

  describe("bullet-list", () => {
    it("turns the lines the reader picked into items", () => {
      const result = applyMarkdownCommand("一つ目\n二つ目", 0, 7, "bullet-list");

      expect(shown(result)).toBe("|- 一つ目\n- 二つ目|");
    });

    it("turns items back into plain lines", () => {
      const result = applyMarkdownCommand("- 一つ目\n- 二つ目", 0, 9, "bullet-list");

      expect(shown(result)).toBe("|一つ目\n二つ目|");
    });

    it("marks a run in which only some lines are items, rather than undoing the ones that are", () => {
      // Undoing here would leave the reader with neither a list nor the plain
      // lines they started from, off one press.
      const result = applyMarkdownCommand("- 一つ目\n二つ目", 0, 8, "bullet-list");

      expect(shown(result)).toBe("|- - 一つ目\n- 二つ目|");
    });

    it("leaves an empty note with one empty item to type into", () => {
      const result = applyMarkdownCommand("", 0, 0, "bullet-list");

      expect(shown(result)).toBe("- |");
    });
  });
});
