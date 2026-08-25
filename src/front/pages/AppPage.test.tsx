import { describe, it, expect, afterEach, vi } from "vite-plus/test";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation, useNavigate } from "react-router";
import { SWRConfig } from "swr";
import { AppPage } from "./AppPage";
import { bookKey } from "../hooks/useBook";
import { SwrTestCache } from "../../test/swrTestCache";
import type { BookDetail, LocatedPage } from "../../shared/schemas/book";
import type { SelectionHighlight } from "../../shared/schemas/selection";
import { PHONE_WIDTH, setViewportWidth } from "../../test/viewport";
import { errAsync, ok, okAsync, ResultAsync } from "neverthrow";
import type { MeasureSelection, SelectionPopoverState } from "../components/PdfViewer/PdfViewer";
import type { SaveSelection } from "../hooks/useStoreSelection";
import type { CreatedSelection } from "../../shared/schemas/selection";
import { ApiError } from "../lib/fetcher";

const A_PASSAGE = "エッジはサーバーレス実行基盤で、実行単位をまたいでメモリを共有できません。";
const A_SECOND_PASSAGE = "Workers は V8 isolate の上で動きます。";
const B_PASSAGE = "Durable Objects は単一のインスタンスに処理を集約します。";
const NOTE_PASSAGE = "選んだ箇所";
const OTHER_NOTE_PASSAGE = "あとから選んだ別の箇所";

const MEASURED_SELECTION: SelectionPopoverState = {
  position: { x: 10, y: 20, width: 120 },
  selectedText: NOTE_PASSAGE,
  selectionPosition: {
    startIndex: 0,
    endIndex: NOTE_PASSAGE.length,
    pageNumber: 1,
    rects: [{ x: 10, y: 20, width: 120, height: 18 }],
    pageWidth: 600,
  },
};

const OTHER_MEASURED_SELECTION: SelectionPopoverState = {
  ...MEASURED_SELECTION,
  selectedText: OTHER_NOTE_PASSAGE,
  selectionPosition: {
    ...MEASURED_SELECTION.selectionPosition,
    endIndex: OTHER_NOTE_PASSAGE.length,
  },
};

const CREATED_SELECTION: CreatedSelection = {
  id: "stored-note-selection",
  selectedText: NOTE_PASSAGE,
  pageNumber: 1,
  positionData: { rects: [{ x: 10, y: 20, width: 120, height: 18 }], pageWidth: 600 },
  createdAt: "2026-08-24T00:00:00.000Z",
};

/**
 * What the viewer says in place of a page. jsdom has no pdf.js, and the stub
 * above refuses the binary, so this is the whole of the PDF side on screen.
 */
const PANE_WITHOUT_A_PAGE =
  "PDFを表示できません: request to /api/pdf/bookA/file failed with status 404";

function highlight(id: string, selectedText: string, pageNumber = 1): SelectionHighlight {
  return {
    id,
    selectedText,
    pageNumber,
    positionData: { rects: [] },
    color: "#FFEB3B",
    createdAt: "2026-08-01T10:00:00.000Z",
  };
}

const BOOK_A: BookDetail = {
  id: "bookA",
  fileName: "Cloudflare Workers.pdf",
  pageCount: 209,
  hasThumbnail: true,
  hasOutline: true,
  // The second one is pages away, so what a highlight does to the page the
  // reader is on can be told apart from doing nothing at all
  selections: [highlight("a1", A_PASSAGE), highlight("a2", A_SECOND_PASSAGE, 30)],
  readingState: null,
};

const BOOK_B: BookDetail = {
  id: "bookB",
  fileName: "Durable Objects.pdf",
  pageCount: 120,
  hasThumbnail: true,
  hasOutline: true,
  selections: [highlight("b1", B_PASSAGE)],
  readingState: null,
};

/** The book's own endpoint, as opposed to the binary or a chat under it. */
const isBookRequest = (url: string) => /^\/api\/pdf\/[^/]+$/.test(url);

/**
 * Answers the requests the reader makes on its own: the PDF binary (which jsdom
 * cannot render anyway) and the chat history of a highlight that is opened.
 *
 * `holdTheBook` leaves the request for the book itself hanging forever. That is
 * how a test shows the reader opened the book without waiting for the server:
 * anything on screen got there from the cache, because nothing else can arrive.
 */
function readerFetchStub({
  holdTheBook = false,
  /** Id of the one highlight whose conversation the server refuses to hand over. */
  refuseChatHistoryFor,
  /** The answer the lookup of a linked passage gets, or a refusal of it. */
  locate = { found: false, miss: "not-in-book" } as const,
  refuseLocate = false,
  refuseReadingStateSave = false,
  noteBody = "",
  noteSaveFailures = 0,
  holdNote = false,
  holdNoteSave = false,
}: {
  holdTheBook?: boolean;
  refuseChatHistoryFor?: string;
  locate?: LocatedPage;
  refuseLocate?: boolean;
  refuseReadingStateSave?: boolean;
  noteBody?: string;
  noteSaveFailures?: number;
  holdNote?: boolean;
  holdNoteSave?: boolean;
} = {}) {
  const urls: string[] = [];
  const noteSaveBodies: { body: string; version: number }[] = [];
  let noteVersion = 0;
  let remainingNoteSaveFailures = noteSaveFailures;
  let releaseNoteSave: (() => void) | undefined;
  // Every caller here reaches the network through `fetcher`, which is only
  // ever handed a url string.
  const fetchFn = (url: string, init?: RequestInit) => {
    urls.push(url);
    if (url.endsWith("/note")) {
      if (init?.method === "PUT") {
        if (typeof init.body !== "string") throw new Error("note request body must be JSON");
        const request = JSON.parse(init.body) as { body: string; version: number };
        noteSaveBodies.push(request);
        if (holdNoteSave) {
          return new Promise<Response>((resolve) => {
            releaseNoteSave = () => {
              noteVersion += 1;
              resolve(
                new Response(JSON.stringify({ version: noteVersion }), {
                  headers: { "Content-Type": "application/json" },
                }),
              );
            };
          });
        }
        if (remainingNoteSaveFailures > 0) {
          remainingNoteSaveFailures -= 1;
          return Promise.resolve(
            new Response(
              JSON.stringify({
                error: { code: "INTERNAL_ERROR", message: "note save failed" },
              }),
              { status: 500, headers: { "Content-Type": "application/json" } },
            ),
          );
        }
        noteVersion += 1;
        return Promise.resolve(
          new Response(JSON.stringify({ version: noteVersion }), {
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      if (holdNote) return new Promise<Response>(() => {});
      return Promise.resolve(
        new Response(JSON.stringify({ body: noteBody, version: noteVersion }), {
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (url.endsWith("/reading-state")) {
      const body = refuseReadingStateSave
        ? { error: { code: "INTERNAL_ERROR", message: "Unexpected server error" } }
        : { saved: true };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status: refuseReadingStateSave ? 500 : 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (url.includes("/locate?")) {
      if (refuseLocate) {
        return Promise.resolve(
          new Response(
            JSON.stringify({ error: { code: "PDF_NOT_FOUND", message: "PDF not found" } }),
            { status: 404, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(new Response(JSON.stringify(locate), { status: 200 }));
    }
    if (url.endsWith("/chats")) {
      const selectionId = url.split("/selections/")[1].split("/")[0];
      const refused = selectionId === refuseChatHistoryFor;
      // The whole envelope, not just `messages`: the reader checks it against
      // chatHistorySchema and reports anything else as an unreadable response.
      const body = refused
        ? { error: { code: "SELECTION_NOT_FOUND", message: "Selection not found" } }
        : { selectionId, messages: [] };
      return Promise.resolve(new Response(JSON.stringify(body), { status: refused ? 404 : 200 }));
    }
    if (holdTheBook && isBookRequest(url)) {
      return new Promise<Response>(() => {});
    }
    return Promise.resolve(new Response(null, { status: 404 }));
  };
  return { urls, fetchFn, noteSaveBodies, finishNoteSave: () => releaseNoteSave?.() };
}

/**
 * The query string, on screen, so a test can read what the reader put there.
 *
 * jsdom has no pdf.js, so the viewer never draws a page and its toolbar — where
 * the page being read is otherwise shown — is not on screen at all.
 */
function ShowSearch() {
  // Named and sorted, since where a parameter lands in the query depends on the
  // order the link happened to spell them in
  const named: string[] = [];
  new URLSearchParams(useLocation().search).forEach((value, key) => named.push(`${key}=${value}`));
  return <p>{`URL: ${named.sort().join(" ")}`}</p>;
}

/** Lets a test leave the book it is on, the way the shelf link would. */
function OpenOtherBook({ pdfId }: { pdfId: string }) {
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate(`/books/${pdfId}`)}>
      別の本を開く
    </button>
  );
}

/**
 * Opens the book through a `#:~:text=` link naming 「存在しない」. The fragment is
 * read off the navigation entry, since the browser strips it from location.hash
 * before scripts can see it.
 */
function linkTo(pdfId: string) {
  vi.spyOn(performance, "getEntriesByType").mockReturnValue([
    {
      name: `http://localhost/books/${pdfId}#:~:text=%E5%AD%98%E5%9C%A8%E3%81%97%E3%81%AA%E3%81%84`,
    },
  ] as PerformanceEntry[]);
}

function renderReader(
  pdfId: string,
  seed: Record<string, unknown>,
  options: {
    holdTheBook?: boolean;
    refuseChatHistoryFor?: string;
    locate?: LocatedPage;
    refuseLocate?: boolean;
    refuseReadingStateSave?: boolean;
    search?: string;
    noteBody?: string;
    noteSaveFailures?: number;
    holdNote?: boolean;
    holdNoteSave?: boolean;
    measureSelection?: MeasureSelection;
    saveSelection?: SaveSelection;
  } = {},
) {
  const { urls, fetchFn, noteSaveBodies, finishNoteSave } = readerFetchStub(options);
  vi.stubGlobal("fetch", fetchFn);

  render(
    <SwrTestCache seed={seed}>
      {/* Seeded entries are revalidated on mount here, as they are in the app.
          What the reader shows before that lands is what these tests are about. */}
      <SWRConfig value={{ revalidateIfStale: true }}>
        <MemoryRouter initialEntries={[`/books/${pdfId}${options.search ?? ""}`]}>
          <OpenOtherBook pdfId={BOOK_B.id} />
          <ShowSearch />
          <Routes>
            <Route
              path="/books/:pdfId"
              element={
                <AppPage
                  measureSelection={options.measureSelection}
                  saveSelection={options.saveSelection}
                />
              }
            />
          </Routes>
        </MemoryRouter>
      </SWRConfig>
    </SwrTestCache>,
  );
  return { urls, noteSaveBodies, finishNoteSave };
}

/** Announces a settled PDF selection through the same seam the viewer tests use. */
function announceSelection(pointerType?: "touch") {
  if (pointerType) {
    window.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType }));
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType }));
  }
  document.dispatchEvent(new Event("selectionchange"));
}

const FORMATTED_NOTE_SELECTION =
  "> 選んだ箇所\n\n<sup>[p.1](?page=1&selection=stored-note-selection)</sup>";

const occurrences = (body: string, value: string) => body.split(value).length - 1;

describe("AppPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("opens a book already in the cache without waiting for the server", async () => {
    // Nothing will answer for the book, so anything on screen came from the
    // entry the upload filed under this key
    renderReader(BOOK_A.id, { [bookKey(BOOK_A.id)]: BOOK_A }, { holdTheBook: true });

    expect(screen.getByText(BOOK_A.fileName)).toBeInTheDocument();
    expect(screen.getByText(A_PASSAGE)).toBeInTheDocument();
  });

  it("leaves the chat of the book being read behind when another book is opened", async () => {
    renderReader(BOOK_A.id, {
      [bookKey(BOOK_A.id)]: BOOK_A,
      [bookKey(BOOK_B.id)]: BOOK_B,
    });

    // Opening a highlight puts its passage on screen, above the conversation
    await userEvent.click(await screen.findByText(A_PASSAGE));
    expect(screen.getByRole("button", { name: "一覧に戻る" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "別の本を開く" }));

    expect(await screen.findByText(BOOK_B.fileName)).toBeInTheDocument();
    expect(screen.getByText(B_PASSAGE)).toBeInTheDocument();
    expect(screen.queryByText(A_PASSAGE)).not.toBeInTheDocument();
  });

  it("says the reader's place could not be saved rather than dropping it in silence", async () => {
    // Losing this quietly means the next device opens the book somewhere the
    // reader never was, with nothing on screen to explain it.
    renderReader(BOOK_A.id, { [bookKey(BOOK_A.id)]: BOOK_A }, { refuseReadingStateSave: true });

    // Opening a highlight moves the reader's place, which is what gets saved
    await userEvent.click(await screen.findByText(A_PASSAGE));

    expect(
      await screen.findByText("読書位置を保存できませんでした: Unexpected server error"),
    ).toBeInTheDocument();
  });

  it("says the conversation could not be read instead of showing it as empty", async () => {
    // An empty conversation and one that failed to load looked identical: the
    // catch put an empty list on screen either way.
    renderReader(BOOK_A.id, { [bookKey(BOOK_A.id)]: BOOK_A }, { refuseChatHistoryFor: "a1" });

    await userEvent.click(await screen.findByText(A_PASSAGE));

    // The viewer reports the missing binary of the same book at the same time,
    // so this looks for the chat panel's own words rather than any alert.
    expect(
      await screen.findByText("チャット履歴を読み込めませんでした: Selection not found"),
    ).toBeInTheDocument();
  });

  it("drops the failed conversation's message when another highlight is opened", async () => {
    // Left behind, it would sit over a conversation it says nothing about.
    renderReader(BOOK_A.id, { [bookKey(BOOK_A.id)]: BOOK_A }, { refuseChatHistoryFor: "a1" });

    await userEvent.click(await screen.findByText(A_PASSAGE));
    expect(
      await screen.findByText("チャット履歴を読み込めませんでした: Selection not found"),
    ).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "一覧に戻る" }));
    await userEvent.click(screen.getByText(A_SECOND_PASSAGE));

    // The second conversation is open, and the first one's failure is not on it
    expect(await screen.findByPlaceholderText("質問を入力...")).toBeInTheDocument();
    expect(
      screen.queryByText("チャット履歴を読み込めませんでした: Selection not found"),
    ).toBeNull();
  });

  it("says a linked passage is not in the book rather than only that it was not found", async () => {
    linkTo(BOOK_A.id);
    renderReader(BOOK_A.id, { [bookKey(BOOK_A.id)]: BOOK_A });

    expect(
      await screen.findByText("リンクされた箇所が本文に見つかりませんでした: 存在しない"),
    ).toBeInTheDocument();
  });

  it("says a book of one page has nowhere to jump to rather than blaming the passage", async () => {
    linkTo(BOOK_A.id);
    renderReader(
      BOOK_A.id,
      { [bookKey(BOOK_A.id)]: BOOK_A },
      { locate: { found: false, miss: "single-page-book" } },
    );

    expect(
      await screen.findByText("この本は1ページなので移動先がありません: 存在しない"),
    ).toBeInTheDocument();
  });

  it("says the lookup itself did not answer rather than that the book lacks the passage", async () => {
    linkTo(BOOK_A.id);
    renderReader(BOOK_A.id, { [bookKey(BOOK_A.id)]: BOOK_A }, { refuseLocate: true });

    expect(
      await screen.findByText("リンクされた箇所を探せませんでした: 存在しない"),
    ).toBeInTheDocument();
  });

  it("reopens the chat its URL names, on the page that URL was left at", async () => {
    // The highlight sits on page 1, so a reader who had scrolled on to page 5
    // and reloaded would be dragged back to it if the restore moved the page.
    const { urls } = renderReader(
      BOOK_A.id,
      { [bookKey(BOOK_A.id)]: BOOK_A },
      { search: "?page=5&selection=a1" },
    );

    expect(await screen.findByRole("button", { name: "一覧に戻る" })).toBeInTheDocument();
    expect(urls).toContain(`/api/pdf/${BOOK_A.id}/selections/a1/chats`);
    // Still page 5: reopening the chat is not the reader picking it off the list
    expect(screen.getByText("URL: page=5 selection=a1")).toBeInTheDocument();
  });

  it("goes to the passage of a highlight picked off the list", async () => {
    // The other half of the restore above: choosing a highlight is the reader
    // asking to be taken to it, so here the page does move.
    renderReader(BOOK_A.id, { [bookKey(BOOK_A.id)]: BOOK_A });

    await userEvent.click(await screen.findByText(A_SECOND_PASSAGE));

    expect(screen.getByText("URL: page=30 selection=a2")).toBeInTheDocument();
  });

  it("shows the highlight list when the URL names a chat the book no longer has", async () => {
    const { urls } = renderReader(
      BOOK_A.id,
      { [bookKey(BOOK_A.id)]: BOOK_A },
      { search: "?selection=deleted" },
    );

    expect(await screen.findByText(A_PASSAGE)).toBeInTheDocument();
    expect(urls.some((url) => url.endsWith("/chats"))).toBe(false);
    // And the URL stops naming it, rather than restoring nothing every reload
    expect(screen.getByText("URL: page=1")).toBeInTheDocument();
  });

  it("opens with the panel folded away when that is how the book was left", async () => {
    const foldedAway: BookDetail = {
      ...BOOK_A,
      readingState: { page: 1, selectionId: null, outlineOpen: null, chatPanelOpen: false },
    };
    renderReader(BOOK_A.id, { [bookKey(BOOK_A.id)]: foldedAway });

    expect(await screen.findByRole("button", { name: "チャットを表示" })).toBeInTheDocument();
    expect(screen.queryByText(A_PASSAGE)).toBeNull();
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("folds the panel away and brings it back on the toggle, leaving the URL on the page", async () => {
    // Which panel is folded is the book's, not the address bar's: writing it
    // here would make folding one a place in the history to go back to.
    renderReader(BOOK_A.id, { [bookKey(BOOK_A.id)]: BOOK_A });

    expect(await screen.findByText(A_PASSAGE)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "チャットを隠す" }));
    expect(screen.queryByText(A_PASSAGE)).toBeNull();
    expect(screen.getByText("URL: page=1")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "チャットを表示" }));
    expect(screen.getByText(A_PASSAGE)).toBeInTheDocument();
    expect(screen.getByText("URL: page=1")).toBeInTheDocument();
  });

  it("keeps both panel toggles together in the header", async () => {
    // The outline used to fold from a button under the page, which is a
    // different place from the one that folds the chat even though the two do
    // the same kind of thing — and it went out of reach as soon as the page
    // was scrolled.
    renderReader(BOOK_A.id, { [bookKey(BOOK_A.id)]: BOOK_A });

    const header = await screen.findByRole("banner");
    const outline = within(header).getByRole("button", { name: "目次を隠す" });
    expect(within(header).getByRole("button", { name: "チャットを隠す" })).toBeInTheDocument();

    await userEvent.click(outline);

    expect(within(header).getByRole("button", { name: "目次を表示" })).toBeInTheDocument();
  });

  it("puts the page out of sight on the maximize toggle, and has it back on the way out", async () => {
    // Reading an answer through is what the toggle is for, so the page goes out
    // of sight — but not out of the tree: taking the viewer down would take the
    // keyboard down with it, since that is where the shortcuts are subscribed.
    renderReader(BOOK_A.id, { [bookKey(BOOK_A.id)]: BOOK_A });

    expect(await screen.findByText(PANE_WITHOUT_A_PAGE)).toBeVisible();
    const header = screen.getByRole("banner");
    await userEvent.click(within(header).getByRole("button", { name: "チャットを最大化" }));

    expect(screen.getByText(PANE_WITHOUT_A_PAGE)).not.toBeVisible();
    // Hidden takes it out of the accessibility tree as well, so nothing behind
    // the chat can be reached with a Tab
    expect(screen.queryByRole("separator")).toBeNull();
    expect(screen.getByText(A_PASSAGE)).toBeVisible();

    await userEvent.click(within(header).getByRole("button", { name: "最大化を解除" }));

    expect(screen.getByText(PANE_WITHOUT_A_PAGE)).toBeVisible();
    expect(screen.getByRole("separator")).toBeInTheDocument();
    expect(screen.getByText(A_PASSAGE)).toBeVisible();
  });

  it("takes the maximize toggle away with the chat, and brings the chat back in two panes", async () => {
    // Folding the chat away is the reader asking for the page, which is the
    // opposite of what they asked for by maximizing: left standing, the state
    // would come back on 「チャットを表示」 and hide the page they just asked for.
    renderReader(BOOK_A.id, { [bookKey(BOOK_A.id)]: BOOK_A });

    expect(await screen.findByText(PANE_WITHOUT_A_PAGE)).toBeVisible();
    const header = screen.getByRole("banner");
    await userEvent.click(within(header).getByRole("button", { name: "チャットを最大化" }));
    await userEvent.click(within(header).getByRole("button", { name: "チャットを隠す" }));

    // Either label: folding the chat also clears the state, so naming only
    // 「最大化を解除」 would pass on a toggle that is still standing there.
    expect(within(header).queryByRole("button", { name: /最大化/ })).toBeNull();
    expect(screen.getByText(PANE_WITHOUT_A_PAGE)).toBeVisible();

    await userEvent.click(within(header).getByRole("button", { name: "チャットを表示" }));

    expect(within(header).getByRole("button", { name: "チャットを最大化" })).toBeInTheDocument();
    expect(screen.getByText(PANE_WITHOUT_A_PAGE)).toBeVisible();
    expect(screen.getByText(A_PASSAGE)).toBeVisible();
  });

  it("opens the next book on its page, however the last one was left", async () => {
    // Maximizing is a way of reading one answer through, not how this reader
    // keeps their books: the state lives in the store `AppPage` rebuilds per
    // book, and nothing carries it across.
    renderReader(BOOK_A.id, {
      [bookKey(BOOK_A.id)]: BOOK_A,
      [bookKey(BOOK_B.id)]: BOOK_B,
    });

    expect(await screen.findByText(PANE_WITHOUT_A_PAGE)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "チャットを最大化" }));
    expect(screen.getByText(PANE_WITHOUT_A_PAGE)).not.toBeVisible();

    await userEvent.click(screen.getByRole("button", { name: "別の本を開く" }));

    expect(await screen.findByText(B_PASSAGE)).toBeVisible();
    expect(screen.getByRole("button", { name: "チャットを最大化" })).toBeInTheDocument();
    expect(screen.getByRole("separator")).toBeInTheDocument();
  });

  it("inserts a stored passage into the unsaved local body at the last editor range", async () => {
    const saved: [string, string][] = [];
    const measureSelection = vi.fn(() => MEASURED_SELECTION);
    renderReader(
      BOOK_A.id,
      { [bookKey(BOOK_A.id)]: BOOK_A },
      {
        noteBody: "ABCD",
        measureSelection,
        saveSelection: (pdfId, draft) => {
          saved.push([pdfId, draft.selectedText]);
          return okAsync(CREATED_SELECTION);
        },
      },
    );
    await userEvent.click(await screen.findByRole("tab", { name: "メモ" }));
    const note = screen.getByRole("textbox", { name: "読書メモ" }) as HTMLTextAreaElement;
    await userEvent.type(note, "未保存");
    note.setSelectionRange(2, 2);
    fireEvent.select(note);

    announceSelection();
    await waitFor(() => expect(measureSelection).toHaveBeenCalled());
    await userEvent.click(await screen.findByRole("button", { name: "メモに追加" }));

    expect(note).toHaveValue(`AB${FORMATTED_NOTE_SELECTION}CD未保存`);
    expect(saved).toStrictEqual([[BOOK_A.id, NOTE_PASSAGE]]);
    expect(screen.getByRole("tab", { name: "メモ" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "チャットを隠す" })).toBeInTheDocument();
  });

  it("uses the latest wide editor range when the caret moves while the highlight is saving", async () => {
    let finishSelection!: () => void;
    renderReader(
      BOOK_A.id,
      { [bookKey(BOOK_A.id)]: BOOK_A },
      {
        noteBody: "ABCD",
        measureSelection: () => MEASURED_SELECTION,
        saveSelection: () =>
          new ResultAsync(
            new Promise((resolve) => {
              finishSelection = () => resolve(ok(CREATED_SELECTION));
            }),
          ),
      },
    );
    await userEvent.click(await screen.findByRole("tab", { name: "メモ" }));
    const note = screen.getByRole("textbox", { name: "読書メモ" }) as HTMLTextAreaElement;
    note.setSelectionRange(1, 1);
    fireEvent.select(note);
    announceSelection();
    await userEvent.click(await screen.findByRole("button", { name: "メモに追加" }));
    expect(screen.getByRole("button", { name: "メモに追加中..." })).toBeDisabled();

    // The save is still in flight when the reader moves the insertion point.
    note.setSelectionRange(3, 3);
    fireEvent.select(note);
    await act(async () => finishSelection());

    await waitFor(() => expect(note).toHaveValue(`ABC${FORMATTED_NOTE_SELECTION}D`), {
      timeout: 500,
    });
  });

  it("raises the note sheet when the layout becomes narrow while the highlight is saving", async () => {
    let finishSelection!: () => void;
    renderReader(
      BOOK_A.id,
      { [bookKey(BOOK_A.id)]: BOOK_A },
      {
        noteBody: "本文",
        measureSelection: () => MEASURED_SELECTION,
        saveSelection: () =>
          new ResultAsync(
            new Promise((resolve) => {
              finishSelection = () => resolve(ok(CREATED_SELECTION));
            }),
          ),
      },
    );
    announceSelection();
    await userEvent.click(await screen.findByRole("button", { name: "メモに追加" }));
    expect(screen.getByRole("button", { name: "メモに追加中..." })).toBeDisabled();

    act(() => setViewportWidth(PHONE_WIDTH));
    expect(screen.queryByRole("region", { name: "チャット" })).toBeNull();
    await act(async () => finishSelection());

    const sheet = await screen.findByRole("region", { name: "チャット" }, { timeout: 500 });
    expect(within(sheet).getByRole("tab", { name: "メモ" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    expect(within(sheet).queryByRole("textbox", { name: "読書メモ" })).toBeNull();
    expect(within(sheet).getByText(NOTE_PASSAGE)).toBeInTheDocument();
  });

  it("appends at the end without a recorded editor range and opens the folded note pane", async () => {
    const foldedAway: BookDetail = {
      ...BOOK_A,
      readingState: { page: 1, selectionId: null, outlineOpen: null, chatPanelOpen: false },
    };
    renderReader(
      BOOK_A.id,
      { [bookKey(BOOK_A.id)]: foldedAway },
      {
        noteBody: "本文",
        measureSelection: () => MEASURED_SELECTION,
        saveSelection: () => okAsync(CREATED_SELECTION),
      },
    );

    announceSelection();
    await userEvent.click(await screen.findByRole("button", { name: "メモに追加" }));

    expect(await screen.findByRole("textbox", { name: "読書メモ" })).toHaveValue(
      `本文\n\n${FORMATTED_NOTE_SELECTION}`,
    );
    expect(screen.getByRole("tab", { name: "メモ" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByRole("button", { name: "チャットを隠す" })).toBeInTheDocument();
  });

  it("leaves the note, tab and folded panel unchanged when selection storage fails", async () => {
    const foldedAway: BookDetail = {
      ...BOOK_A,
      readingState: { page: 1, selectionId: null, outlineOpen: null, chatPanelOpen: false },
    };
    renderReader(
      BOOK_A.id,
      { [bookKey(BOOK_A.id)]: foldedAway },
      {
        noteBody: "元の本文",
        measureSelection: () => MEASURED_SELECTION,
        saveSelection: () => errAsync(new ApiError("selection save failed", "INTERNAL_ERROR", 500)),
      },
    );

    announceSelection();
    await userEvent.click(await screen.findByRole("button", { name: "メモに追加" }));
    expect(await screen.findByText(/ハイライトを保存できませんでした/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "チャットを表示" })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "チャットを表示" }));
    expect(screen.getByRole("tab", { name: "チャット" })).toHaveAttribute("aria-selected", "true");
    await userEvent.click(screen.getByRole("tab", { name: "メモ" }));
    expect(screen.getByRole("textbox", { name: "読書メモ" })).toHaveValue("元の本文");
  });

  it("uses the wide insertion path when a touch selects on a wide screen", async () => {
    renderReader(
      BOOK_A.id,
      { [bookKey(BOOK_A.id)]: BOOK_A },
      {
        noteBody: "",
        measureSelection: () => MEASURED_SELECTION,
        saveSelection: () => okAsync(CREATED_SELECTION),
      },
    );

    announceSelection("touch");
    await userEvent.click(await screen.findByRole("button", { name: "メモに追加" }));

    expect(await screen.findByRole("textbox", { name: "読書メモ" })).toHaveValue(
      FORMATTED_NOTE_SELECTION,
    );
  });

  it("does not offer note insertion while the note session is still loading", async () => {
    renderReader(
      BOOK_A.id,
      { [bookKey(BOOK_A.id)]: BOOK_A },
      { holdNote: true, measureSelection: () => MEASURED_SELECTION },
    );

    announceSelection();
    expect(await screen.findByPlaceholderText("選択した文章について質問する...")).toBeVisible();
    expect(screen.queryByRole("button", { name: "メモに追加" })).toBeNull();
  });

  it("says what went wrong when the book cannot be read", async () => {
    renderReader(BOOK_A.id, {});

    expect(
      await screen.findByText(
        `エラーが発生しました: request to /api/pdf/bookA failed with status 404`,
      ),
    ).toBeInTheDocument();
  });
});

describe("AppPage on a screen too narrow for two panes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("opens on the book, with the chat put away", async () => {
    setViewportWidth(PHONE_WIDTH);

    renderReader(BOOK_A.id, { [bookKey(BOOK_A.id)]: BOOK_A });

    expect(await screen.findByText(BOOK_A.fileName)).toBeInTheDocument();
    // The highlight list is what the chat shows first, so its absence is the
    // chat being away rather than the book having no highlights
    expect(screen.queryByText(A_PASSAGE)).toBeNull();
  });

  it("brings the chat up from the toolbar", async () => {
    setViewportWidth(PHONE_WIDTH);
    renderReader(BOOK_A.id, { [bookKey(BOOK_A.id)]: BOOK_A });

    await userEvent.click(await screen.findByRole("button", { name: "チャット" }));

    expect(await screen.findByText(A_PASSAGE)).toBeInTheDocument();
  });

  it("leaves the pages turnable while the chat is up", async () => {
    // The chat sits above the toolbar rather than over it: reading on is the
    // reason to have the book and the answer on screen together.
    setViewportWidth(PHONE_WIDTH);
    renderReader(BOOK_A.id, { [bookKey(BOOK_A.id)]: BOOK_A });

    await userEvent.click(await screen.findByRole("button", { name: "チャット" }));
    expect(await screen.findByText(A_PASSAGE)).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "次のページ" }));

    expect(screen.getByText("URL: page=2")).toBeInTheDocument();
  });

  it("offers no maximize toggle, the sheet being what is drawn up instead", async () => {
    setViewportWidth(PHONE_WIDTH);

    renderReader(BOOK_A.id, { [bookKey(BOOK_A.id)]: BOOK_A });

    expect(await screen.findByText(BOOK_A.fileName)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /最大化/ })).toBeNull();
    // The way to the whole window on one column, in the toolbar under the page
    expect(screen.getByRole("button", { name: "チャット" })).toBeInTheDocument();
  });

  it("offers no splitter, having no second pane to size", async () => {
    setViewportWidth(PHONE_WIDTH);

    renderReader(BOOK_A.id, { [bookKey(BOOK_A.id)]: BOOK_A });

    expect(await screen.findByText(BOOK_A.fileName)).toBeInTheDocument();
    expect(screen.queryByRole("separator")).toBeNull();
  });

  it("brings the chat up on the highlight a link named", async () => {
    // The URL restore and a tap on the page both arrive through `openChat`, so
    // a chat reopened from a link has to raise the sheet as well.
    setViewportWidth(PHONE_WIDTH);

    renderReader(BOOK_A.id, { [bookKey(BOOK_A.id)]: BOOK_A }, { search: "?page=5&selection=a1" });

    // The sheet by name, not just the chat being on screen: the panes show a
    // conversation too, so "一覧に戻る" alone would pass on a desktop window.
    expect(await screen.findByRole("region", { name: "チャット" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "一覧に戻る" })).toBeInTheDocument();
  });

  it("stores a selected passage once, keeps the stable id after note failure, and retries only the note", async () => {
    setViewportWidth(PHONE_WIDTH);
    let selectionPosts = 0;
    let measuredSelection = MEASURED_SELECTION;
    const measureSelection = vi.fn(() => measuredSelection);
    const { noteSaveBodies } = renderReader(
      BOOK_A.id,
      { [bookKey(BOOK_A.id)]: BOOK_A },
      {
        noteSaveFailures: 1,
        measureSelection,
        saveSelection: () => {
          selectionPosts += 1;
          return okAsync(CREATED_SELECTION);
        },
      },
    );

    announceSelection();
    await userEvent.click(await screen.findByRole("button", { name: "メモに追加" }));
    expect(await screen.findByRole("region", { name: "チャット" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "メモ" })).toHaveAttribute("aria-selected", "true");
    const quick = screen.getByRole("textbox", { name: "クイックメモ" });
    await userEvent.type(quick, "補足");
    await userEvent.click(screen.getByRole("button", { name: "メモを追加" }));

    expect(
      await screen.findByText("クイックメモを保存できませんでした: note save failed"),
    ).toBeInTheDocument();
    expect(quick).toHaveValue("補足");
    expect(quick).toHaveAttribute("readonly");
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
    expect(selectionPosts).toBe(1);
    expect(noteSaveBodies).toHaveLength(1);
    expect(noteSaveBodies[0].body).toContain("selection=stored-note-selection");
    expect(occurrences(noteSaveBodies[0].body, "selection=stored-note-selection")).toBe(1);
    expect(document.querySelector("blockquote.mx-3 > p")).toHaveTextContent(NOTE_PASSAGE);

    await userEvent.click(screen.getByRole("button", { name: "チャットを閉じる" }));
    measuredSelection = OTHER_MEASURED_SELECTION;
    announceSelection();
    expect(await screen.findByText(`“${OTHER_NOTE_PASSAGE}”`)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "メモに追加" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "チャット" }));
    expect(screen.getByRole("textbox", { name: "クイックメモ" })).toHaveValue("補足");
    expect(document.querySelector("blockquote.mx-3 > p")).toHaveTextContent(NOTE_PASSAGE);

    await userEvent.click(screen.getByRole("button", { name: "再試行" }));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "クイックメモ" })).toHaveValue(""),
    );
    expect(selectionPosts).toBe(1);
    expect(noteSaveBodies).toHaveLength(2);
    expect(noteSaveBodies[1].body).toContain("selection=stored-note-selection");
    expect(occurrences(noteSaveBodies[1].body, "selection=stored-note-selection")).toBe(1);
    expect(document.querySelector("blockquote.mx-3 > p")).toBeNull();
  });

  it("keeps the draft, pending quote and input when selection storage fails", async () => {
    setViewportWidth(PHONE_WIDTH);
    let selectionPosts = 0;
    let measuredSelection = MEASURED_SELECTION;
    const measureSelection = vi.fn(() => measuredSelection);
    renderReader(
      BOOK_A.id,
      { [bookKey(BOOK_A.id)]: BOOK_A },
      {
        measureSelection,
        saveSelection: () => {
          selectionPosts += 1;
          return selectionPosts === 1
            ? errAsync(new ApiError("selection save failed", "INTERNAL_ERROR", 500))
            : okAsync(CREATED_SELECTION);
        },
      },
    );

    announceSelection();
    await userEvent.click(await screen.findByRole("button", { name: "メモに追加" }));
    const quick = await screen.findByRole("textbox", { name: "クイックメモ" });
    await userEvent.type(quick, "消さない入力");
    await userEvent.click(screen.getByRole("button", { name: "メモを追加" }));

    expect(
      await screen.findByText("ハイライトを保存できませんでした: selection save failed"),
    ).toBeInTheDocument();
    expect(quick).toHaveValue("消さない入力");
    expect(screen.getByText(NOTE_PASSAGE)).toBeInTheDocument();
    expect(selectionPosts).toBe(1);

    await userEvent.click(screen.getByRole("button", { name: "チャットを閉じる" }));
    measuredSelection = OTHER_MEASURED_SELECTION;
    announceSelection();
    expect(await screen.findByText(`“${OTHER_NOTE_PASSAGE}”`)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "メモに追加" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "チャット" }));
    expect(screen.getByRole("textbox", { name: "クイックメモ" })).toHaveValue("消さない入力");
    expect(document.querySelector("blockquote.mx-3 > p")).toHaveTextContent(NOTE_PASSAGE);

    await userEvent.click(screen.getByRole("button", { name: "メモを追加" }));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "クイックメモ" })).toHaveValue(""),
    );
    expect(selectionPosts).toBe(2);
    expect(document.querySelector("blockquote.mx-3 > p")).toBeNull();
  });

  it("keeps a failed selectionless intent exclusive until its dedicated retry succeeds", async () => {
    setViewportWidth(PHONE_WIDTH);
    let selectionPosts = 0;
    const { noteSaveBodies } = renderReader(
      BOOK_A.id,
      { [bookKey(BOOK_A.id)]: BOOK_A },
      {
        noteSaveFailures: 1,
        measureSelection: () => OTHER_MEASURED_SELECTION,
        saveSelection: () => {
          selectionPosts += 1;
          return okAsync(CREATED_SELECTION);
        },
      },
    );

    await userEvent.click(await screen.findByRole("button", { name: "チャット" }));
    await userEvent.click(screen.getByRole("tab", { name: "メモ" }));
    const quick = screen.getByRole("textbox", { name: "クイックメモ" });
    await userEvent.type(quick, "選択なしで失敗");
    await userEvent.click(screen.getByRole("button", { name: "メモを追加" }));

    expect(
      await screen.findByText("クイックメモを保存できませんでした: note save failed"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "保存" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "チャットを閉じる" }));
    announceSelection();
    expect(await screen.findByText(`“${OTHER_NOTE_PASSAGE}”`)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "メモに追加" })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "チャット" }));
    expect(screen.getByRole("textbox", { name: "クイックメモ" })).toHaveValue("選択なしで失敗");
    await userEvent.click(screen.getByRole("button", { name: "再試行" }));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "クイックメモ" })).toHaveValue(""),
    );

    expect(selectionPosts).toBe(0);
    expect(noteSaveBodies).toHaveLength(2);
    expect(
      noteSaveBodies.map((payload) => occurrences(payload.body, "選択なしで失敗")),
    ).toStrictEqual([1, 1]);
  });

  it("does not offer a new selected intent while a selectionless note is in flight", async () => {
    setViewportWidth(PHONE_WIDTH);
    const { finishNoteSave } = renderReader(
      BOOK_A.id,
      { [bookKey(BOOK_A.id)]: BOOK_A },
      {
        holdNoteSave: true,
        measureSelection: () => OTHER_MEASURED_SELECTION,
      },
    );

    await userEvent.click(await screen.findByRole("button", { name: "チャット" }));
    await userEvent.click(screen.getByRole("tab", { name: "メモ" }));
    await userEvent.type(screen.getByRole("textbox", { name: "クイックメモ" }), "保存中の一言");
    await userEvent.click(screen.getByRole("button", { name: "メモを追加" }));
    expect(await screen.findByRole("button", { name: "追加中..." })).toBeDisabled();

    await userEvent.click(screen.getByRole("button", { name: "チャットを閉じる" }));
    announceSelection();
    expect(await screen.findByText(`“${OTHER_NOTE_PASSAGE}”`)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "メモに追加" })).toBeNull();

    await act(async () => finishNoteSave());
  });

  it("appends a selectionless quick note without creating a highlight", async () => {
    setViewportWidth(PHONE_WIDTH);
    let selectionPosts = 0;
    const { noteSaveBodies } = renderReader(
      BOOK_A.id,
      { [bookKey(BOOK_A.id)]: BOOK_A },
      {
        saveSelection: () => {
          selectionPosts += 1;
          return okAsync(CREATED_SELECTION);
        },
      },
    );

    await userEvent.click(await screen.findByRole("button", { name: "チャット" }));
    await userEvent.click(screen.getByRole("tab", { name: "メモ" }));
    const quick = screen.getByRole("textbox", { name: "クイックメモ" });
    await userEvent.type(quick, "選択なしの一言");
    await userEvent.click(screen.getByRole("button", { name: "メモを追加" }));

    await waitFor(() => expect(quick).toHaveValue(""));
    expect(selectionPosts).toBe(0);
    expect(noteSaveBodies.at(-1)?.body).toBe("## メモ\n\n- 選択なしの一言");
  });

  it("guards the selected quick submit synchronously before React can disable the button", async () => {
    setViewportWidth(PHONE_WIDTH);
    let selectionPosts = 0;
    let finishSelection: ((selection: CreatedSelection) => void) | undefined;
    renderReader(
      BOOK_A.id,
      { [bookKey(BOOK_A.id)]: BOOK_A },
      {
        measureSelection: () => MEASURED_SELECTION,
        saveSelection: () => {
          selectionPosts += 1;
          return new ResultAsync(
            new Promise((resolve) => {
              finishSelection = (selection) => resolve(ok(selection));
            }),
          );
        },
      },
    );

    announceSelection();
    await userEvent.click(await screen.findByRole("button", { name: "メモに追加" }));
    await userEvent.type(
      await screen.findByRole("textbox", { name: "クイックメモ" }),
      "二重送信しない",
    );
    const submit = screen.getByRole("button", { name: "メモを追加" });
    fireEvent.click(submit);
    fireEvent.click(submit);

    expect(selectionPosts).toBe(1);
    finishSelection?.(CREATED_SELECTION);
  });
});
