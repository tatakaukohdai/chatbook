import { describe, it, expect } from "vite-plus/test";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NotePane } from "./NotePane";
import { stubNoteSession } from "../../../test/noteSession";
import type { NoteSession } from "../../hooks/useNoteSession";
import { setViewportWidth, PHONE_WIDTH } from "../../../test/viewport";

function renderPane(session: Partial<NoteSession> = {}) {
  const edits: string[] = [];
  const saved: true[] = [];
  const full = stubNoteSession({
    edit: (body) => edits.push(body),
    save: () => saved.push(true),
    ...session,
  });
  render(<NotePane session={full} />);
  return { edits, saved };
}

const editor = () => screen.getByRole("textbox", { name: "読書メモ" });

describe("NotePane", () => {
  it("puts the note in the editor and renders it underneath", () => {
    renderPane({ body: "# Raft\n\n選挙の話\n" });

    expect(editor()).toHaveValue("# Raft\n\n選挙の話\n");
    expect(screen.getByRole("heading", { name: "Raft" })).toBeInTheDocument();
  });

  it("hands every keystroke to the session, which is the only thing that saves", async () => {
    const { edits } = renderPane({ body: "" });

    await userEvent.type(editor(), "メ");

    expect(edits).toStrictEqual(["メ"]);
  });

  it("marks up what the reader picked when a toolbar button is pressed", async () => {
    const { edits } = renderPane({ body: "Raft は過半数で決める" });
    const box = editor() as HTMLTextAreaElement;
    box.setSelectionRange(0, 4);

    await userEvent.click(screen.getByRole("button", { name: "太字" }));

    expect(edits).toStrictEqual(["**Raft** は過半数で決める"]);
  });

  it.each([
    ["saved", "保存済み"],
    ["dirty", "未保存"],
    ["saving", "保存中..."],
    ["failed", "保存できませんでした"],
    ["conflicted", "別の端末の変更と競合しています"],
    ["loading", "読み込み中..."],
  ] as const)("says where the note stands when it is %s", (status, wording) => {
    // Said at all times, unlike the reading position, which speaks up only when
    // it fails: an editor that cannot be asked whether the words are safe is
    // not one anybody trusts with words they would mind losing.
    renderPane({ status });

    expect(screen.getByText(wording)).toBeInTheDocument();
  });

  it("offers to save by hand only where saving on its own has stopped", async () => {
    const { saved } = renderPane({ status: "conflicted", saveError: "重なりました" });

    await userEvent.click(screen.getByRole("button", { name: "保存" }));

    expect(saved).toStrictEqual([true]);
    expect(screen.getByText("重なりました")).toBeInTheDocument();
  });

  it("keeps the save button out of the way while saving looks after itself", () => {
    renderPane({ status: "dirty" });

    expect(screen.queryByRole("button", { name: "保存" })).not.toBeInTheDocument();
  });

  it("offers a draft rather than putting it on screen behind the reader's back", async () => {
    const recovered: true[] = [];
    render(
      <NotePane
        session={stubNoteSession({
          body: "サーバのメモ",
          draftOffer: "この端末に残っていた本文",
          recoverDraft: () => recovered.push(true),
        })}
      />,
    );

    // The server's note is what every other device agrees on; putting this
    // device's leftovers over it is the reader's call, not this one's
    expect(editor()).toHaveValue("サーバのメモ");

    await userEvent.click(screen.getByRole("button", { name: "下書きを復元" }));
    expect(recovered).toStrictEqual([true]);
  });

  it("lets the reader throw the draft away", async () => {
    const discarded: true[] = [];
    render(
      <NotePane
        session={stubNoteSession({
          draftOffer: "要らない本文",
          discardDraft: () => discarded.push(true),
        })}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "破棄" }));

    expect(discarded).toStrictEqual([true]);
  });

  it("says when this device could not keep a copy of the note", () => {
    // Swallowed, the reader goes on writing believing there is a backup
    renderPane({ draftError: "この端末に下書きを保存できませんでした" });

    expect(screen.getByText("この端末に下書きを保存できませんでした")).toBeInTheDocument();
  });

  it("says when the note itself could not be read", () => {
    renderPane({ loadError: "回線が切れました" });

    expect(screen.getByText(/メモを読み込めませんでした/)).toBeInTheDocument();
  });

  describe("on one column", () => {
    it("shows the note but does not offer to edit it", () => {
      // Writing at length is not what happens on a phone, and a textarea that
      // cannot be written in comfortably is also a road to a conflict that
      // cannot be resolved there. That choice is what keeps the conflict
      // handling out of this layout entirely.
      setViewportWidth(PHONE_WIDTH);

      renderPane({ body: "# Raft\n\n選挙の話\n" });

      expect(screen.queryByRole("textbox", { name: "読書メモ" })).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "太字" })).not.toBeInTheDocument();
      expect(screen.getByRole("heading", { name: "Raft" })).toBeInTheDocument();
    });
  });

  it("says the note is empty rather than showing nothing at all", () => {
    renderPane({ body: "" });

    expect(screen.getByText("まだ何も書かれていません")).toBeInTheDocument();
  });
});
