import { describe, it, expect } from "vite-plus/test";
import { hasConflictMarkers, mergeNoteBodies, toLines, fromLines } from "./noteMerge";

describe("toLines / fromLines", () => {
  it.each([
    ["空の本文", ""],
    ["末尾改行なし", "一行目\n二行目"],
    ["末尾改行あり", "一行目\n二行目\n"],
    ["連続する空行", "見出し\n\n\n本文\n"],
    ["改行だけ", "\n"],
  ])("puts %s back together unchanged", (_name, body) => {
    // The merge works line by line, so every note has to survive the trip out
    // and back — otherwise a save that merged nothing would still rewrite the
    // reader's blank lines.
    expect(fromLines(toLines(body))).toBe(body);
  });
});

describe("mergeNoteBodies", () => {
  const BASE = "# Raft\n\n選挙の話\n\n## ログ複製\n\nまだ読んでいない\n";

  it("folds two edits that never met into one note", () => {
    const mine = BASE.replace("選挙の話", "選挙の話（過半数が要る）");
    const theirs = BASE.replace("まだ読んでいない", "3 章で読んだ");

    const merged = mergeNoteBodies(mine, BASE, theirs);

    expect(merged.conflicted).toBe(false);
    expect(merged.body).toBe("# Raft\n\n選挙の話（過半数が要る）\n\n## ログ複製\n\n3 章で読んだ\n");
  });

  it("marks up the one line both sides rewrote, and leaves the rest folded in", () => {
    const mine = BASE.replace("選挙の話", "こちらの書き直し").replace(
      "まだ読んでいない",
      "こちらだけが足した行",
    );
    const theirs = BASE.replace("選挙の話", "あちらの書き直し");

    const merged = mergeNoteBodies(mine, BASE, theirs);

    expect(merged.conflicted).toBe(true);
    // The note is Markdown source in a textarea, so the markers themselves are
    // the merge screen — the reader edits them out in place.
    expect(merged.body).toBe(
      [
        "# Raft",
        "",
        "<<<<<<< 自分",
        "こちらの書き直し",
        "=======",
        "あちらの書き直し",
        ">>>>>>> サーバ",
        "",
        "## ログ複製",
        "",
        "こちらだけが足した行",
        "",
      ].join("\n"),
    );
  });

  it("names the two sides in the reader's words, not in git's", () => {
    const merged = mergeNoteBodies("こちら", "もと", "あちら");

    expect(merged.body).toContain("<<<<<<< 自分");
    expect(merged.body).toContain(">>>>>>> サーバ");
    expect(merged.body).not.toContain("|||||||");
  });

  it("takes a change both sides made as agreement rather than as a clash", () => {
    // Two devices typing the same correction is not a disagreement, and asking
    // the reader to resolve it would be asking them to choose between a line
    // and itself.
    const merged = mergeNoteBodies("直した行\n", "もとの行\n", "直した行\n");

    expect(merged).toStrictEqual({ body: "直した行\n", conflicted: false });
  });

  it("keeps what one side wrote when the other side did not move", () => {
    const merged = mergeNoteBodies("書いた\n", "", "");

    expect(merged).toStrictEqual({ body: "書いた\n", conflicted: false });
  });

  it("takes the server's note when this side never edited it", () => {
    const merged = mergeNoteBodies("", "", "あちらが書いた\n");

    expect(merged).toStrictEqual({ body: "あちらが書いた\n", conflicted: false });
  });
});

describe("hasConflictMarkers", () => {
  it("sees the markers a merge left behind", () => {
    expect(hasConflictMarkers("a\n<<<<<<< 自分\nb\n=======\nc\n>>>>>>> サーバ\n")).toBe(true);
  });

  it("says nothing is left once the reader has resolved them", () => {
    expect(hasConflictMarkers("a\nb\n")).toBe(false);
  });

  it("does not take a line that merely starts with angle brackets for a marker", () => {
    // A quoted diff in a note is ordinary prose; only a marker at the start of
    // its own line, in the shape a merge writes, stops the saving.
    expect(hasConflictMarkers("> <<<<<<< 自分 と書いた\n")).toBe(false);
  });
});
