import { afterEach, describe, it, expect } from "vite-plus/test";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NotePane } from "./NotePane";
import { stubNoteSession } from "../../../test/noteSession";
import type { NoteSession } from "../../hooks/useNoteSession";
import { setViewportWidth, PHONE_WIDTH } from "../../../test/viewport";
import type { SelectionDraft } from "../../hooks/useStoreSelection";
import type { SelectionHighlight } from "../../../shared/schemas/selection";
import { getDefaultStore } from "jotai";
import { quickNoteInputAtom } from "../../atoms/noteAtom";

const PENDING_SELECTION: SelectionDraft = {
  requestId: "7e0055d7-5bc3-40af-bab4-4db62a9f8ef9",
  selectedText: "選んだ箇所",
  pageNumber: 42,
  positionData: { rects: [] },
};

const STORED_SELECTION: SelectionHighlight = {
  id: "selection-42",
  selectedText: PENDING_SELECTION.selectedText,
  pageNumber: PENDING_SELECTION.pageNumber,
  positionData: { rects: [] },
  color: "#FFEB3B",
  createdAt: "2026-08-24T00:00:00.000Z",
};

function renderPane(
  session: Partial<NoteSession> = {},
  props: Partial<React.ComponentProps<typeof NotePane>> = {},
) {
  const edits: string[] = [];
  const saved: true[] = [];
  const full = stubNoteSession({
    edit: (body) => edits.push(body),
    save: () => saved.push(true),
    ...session,
  });
  render(<NotePane session={full} {...props} />);
  return { edits, saved };
}

const editor = () => screen.getByRole("textbox", { name: "読書メモ" });

describe("NotePane", () => {
  afterEach(() => {
    act(() => getDefaultStore().set(quickNoteInputAtom, ""));
  });

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

  it("keeps a failed quick append out of generic save and offers its own retry after a resize", async () => {
    setViewportWidth(PHONE_WIDTH);
    const retried: true[] = [];
    const retry = async () => {
      retried.push(true);
      return true;
    };
    const session = stubNoteSession();
    const { rerender } = render(<NotePane session={session} onQuickRetry={retry} />);
    await userEvent.type(screen.getByRole("textbox", { name: "クイックメモ" }), "失敗した一言");
    rerender(
      <NotePane
        session={{ ...session, status: "failed", quickAppendError: "回線が切れました" }}
        onQuickRetry={retry}
      />,
    );

    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
    expect(screen.getAllByRole("button", { name: "再試行" })).toHaveLength(1);

    act(() => setViewportWidth(1280));
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
    expect(screen.queryByRole("button", { name: "再試行" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "クイックメモを再試行" }));

    expect(retried).toStrictEqual([true]);
    act(() => setViewportWidth(PHONE_WIDTH));
    expect(screen.getByRole("textbox", { name: "クイックメモ" })).toHaveValue("");
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

    it("offers only a one-line controlled quick-note input", () => {
      setViewportWidth(PHONE_WIDTH);

      renderPane();

      const quick = screen.getByRole("textbox", { name: "クイックメモ" });
      expect(quick.tagName).toBe("INPUT");
      expect(quick).toHaveClass("h-11");
      expect(screen.getByRole("button", { name: "メモを追加" })).toHaveClass("h-11");
      expect(screen.queryByRole("textbox", { name: "読書メモ" })).toBeNull();
      expect(screen.queryByRole("button", { name: "太字" })).toBeNull();
    });

    it("submits by Enter or button and clears the controlled input only after success", async () => {
      setViewportWidth(PHONE_WIDTH);
      const submitted: string[] = [];
      let succeeds = false;
      renderPane(
        {},
        {
          onQuickSubmit: async (text) => {
            submitted.push(text);
            return succeeds;
          },
        },
      );
      const quick = screen.getByRole("textbox", { name: "クイックメモ" });

      await userEvent.type(quick, "残す入力{Enter}");
      expect(submitted).toStrictEqual(["残す入力"]);
      expect(quick).toHaveValue("残す入力");

      succeeds = true;
      await userEvent.click(screen.getByRole("button", { name: "メモを追加" }));
      expect(submitted).toStrictEqual(["残す入力", "残す入力"]);
      expect(quick).toHaveValue("");
    });

    it("keeps a failed stable intent read-only and retries it without accepting different text", async () => {
      setViewportWidth(PHONE_WIDTH);
      const retried: true[] = [];
      const retry = async () => {
        retried.push(true);
        return true;
      };
      const session = stubNoteSession();
      const { rerender } = render(<NotePane session={session} onQuickRetry={retry} />);
      const quick = screen.getByRole("textbox", { name: "クイックメモ" });
      await userEvent.type(quick, "変えない入力");
      rerender(
        <NotePane
          session={{ ...session, quickAppendError: "回線が切れました" }}
          onQuickRetry={retry}
        />,
      );

      expect(quick).toHaveAttribute("readonly");
      expect(quick).toHaveValue("変えない入力");
      expect(screen.getByRole("alert")).toHaveTextContent(
        "クイックメモを保存できませんでした: 回線が切れました",
      );
      await userEvent.click(screen.getByRole("button", { name: "再試行" }));
      expect(retried).toStrictEqual([true]);
      expect(quick).toHaveValue("");
    });

    it("keeps the selected passage visible while its quick note is pending", () => {
      setViewportWidth(PHONE_WIDTH);

      renderPane({}, { pendingSelection: PENDING_SELECTION });

      expect(screen.getByText("選んだ箇所")).toBeInTheDocument();
      expect(screen.getByText("p.42")).toBeInTheDocument();
    });

    it("says why a selection could not be stored without discarding the pending quote", () => {
      setViewportWidth(PHONE_WIDTH);

      renderPane({}, { pendingSelection: PENDING_SELECTION, selectionSaveError: "PDF not found" });

      expect(screen.getByRole("alert")).toHaveTextContent(
        "ハイライトを保存できませんでした: PDF not found",
      );
      expect(screen.getByText("選んだ箇所")).toBeInTheDocument();
    });
  });

  it("reports textarea ranges and keeps the toolbar's returned range as the next insertion point", async () => {
    const ranges: { start: number; end: number }[] = [];
    renderPane(
      { body: "Raft は過半数で決める" },
      { onEditorRangeChange: (range) => ranges.push(range) },
    );
    const box = editor() as HTMLTextAreaElement;
    box.setSelectionRange(0, 4);
    fireEvent.select(box);

    await userEvent.click(screen.getByRole("button", { name: "太字" }));

    expect(ranges.at(-1)).toStrictEqual({ start: 2, end: 6 });
  });

  it("restores the insertion range after the controlled body changes", () => {
    const session = stubNoteSession({ body: "本文" });
    const { rerender } = render(<NotePane session={session} />);

    rerender(
      <NotePane
        session={{ ...session, body: "本引用文末尾" }}
        editorRange={{ start: 2, end: 2 }}
      />,
    );

    expect(editor()).toHaveProperty("selectionStart", 2);
    expect(editor()).toHaveProperty("selectionEnd", 2);
  });

  it("guards every app-like link while only a valid current-book p.N link navigates", async () => {
    const opened: string[] = [];
    renderPane(
      {
        body: [
          "[戻る](?page=42&selection=selection-42)",
          "[削除済み](?page=42&selection=deleted)",
          "[ページ不一致](?page=7&selection=selection-42)",
          "[余分](?page=42&selection=selection-42&extra=1)",
          "[外部](https://example.com)",
        ].join(" "),
      },
      {
        selections: [STORED_SELECTION],
        onSelectionClick: (selection) => opened.push(selection.id),
      },
    );

    await userEvent.click(screen.getByRole("link", { name: "戻る" }));
    for (const name of ["削除済み", "ページ不一致", "余分"]) {
      const link = screen.getByRole("link", { name });
      expect(link).not.toHaveAttribute("target");
      expect(fireEvent.click(link)).toBe(false);
    }

    expect(opened).toStrictEqual(["selection-42"]);
    expect(screen.getByRole("link", { name: "外部" })).toHaveAttribute("target", "_blank");
  });

  it("says the note is empty rather than showing nothing at all", () => {
    renderPane({ body: "" });

    expect(screen.getByText("まだ何も書かれていません")).toBeInTheDocument();
  });
});
