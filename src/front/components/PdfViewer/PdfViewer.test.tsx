import { describe, it, expect, afterEach, vi } from "vite-plus/test";
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Provider, createStore } from "jotai";
import { err, errAsync, ok, okAsync, ResultAsync, type Result } from "neverthrow";
import { PdfViewer, type MeasureSelection } from "./PdfViewer";
import { SwrTestCache } from "../../../test/swrTestCache";
import { activeSelectionAtom, chatSheetAtom } from "../../atoms/chatAtom";
import { bookKey } from "../../hooks/useBook";
import { zoomAtomFor } from "../../atoms/settingsAtom";
import { PHONE_WIDTH, setViewportWidth } from "../../../test/viewport";
import { ApiError } from "../../lib/fetcher";
import type { SaveSelection, SelectionDraft } from "../../hooks/useStoreSelection";
import type { BookDetail } from "../../../shared/schemas/book";
import type { CreatedSelection } from "../../../shared/schemas/selection";

const BOOK: BookDetail = {
  id: "p1",
  fileName: "Cloudflare Workers.pdf",
  pageCount: 209,
  hasThumbnail: true,
  hasOutline: true,
  selections: [],
  readingState: null,
};

/** Answers the request for the book's binary with the given refusal. */
function bucketWithout(body: unknown, status: number): typeof fetch {
  return () =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    );
}

/** Keeps the decorative PDF load pending while allowing a question POST to finish. */
function pendingPdfWithSuccessfulWrites(): typeof fetch {
  return (_input, init) =>
    init?.method === "POST"
      ? Promise.resolve(
          new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        )
      : new Promise<Response>(() => {});
}

const PASSAGE = "エッジはサーバーレス実行基盤です。";

/** A passage the reader has dragged over, as the real measurement reports it. */
const MEASURED: ReturnType<MeasureSelection> = {
  position: { x: 40, y: 120, width: 160 },
  selectedText: PASSAGE,
  selectionPosition: {
    startIndex: 0,
    endIndex: 12,
    pageNumber: 1,
    rects: [{ x: 40, y: 120, width: 160, height: 18 }],
    pageWidth: 600,
  },
};

const NEXT_MEASURED: NonNullable<ReturnType<MeasureSelection>> = {
  position: { x: 80, y: 180, width: 140 },
  selectedText: "別の段落を選び直しました。",
  selectionPosition: {
    startIndex: 20,
    endIndex: 32,
    pageNumber: 1,
    rects: [{ x: 80, y: 180, width: 140, height: 18 }],
    pageWidth: 600,
  },
};

const STORED: CreatedSelection = {
  id: "s1",
  selectedText: PASSAGE,
  pageNumber: 1,
  positionData: MEASURED.selectionPosition,
  createdAt: "2026-08-01T10:00:00.000Z",
};

const NEXT_STORED: CreatedSelection = {
  id: "s2",
  selectedText: NEXT_MEASURED.selectedText,
  pageNumber: NEXT_MEASURED.selectionPosition.pageNumber,
  positionData: NEXT_MEASURED.selectionPosition,
  createdAt: "2026-08-01T10:01:00.000Z",
};

function renderViewer(
  options: {
    measureSelection?: MeasureSelection;
    saveSelection?: SaveSelection;
    store?: ReturnType<typeof createStore>;
    onAddSelectionToNote?: (selection: CreatedSelection) => void;
    onPrepareSelectionQuickNote?: (draft: SelectionDraft) => void;
  } = {},
) {
  return render(
    <SwrTestCache seed={{ [bookKey(BOOK.id)]: BOOK }}>
      <Provider store={options.store ?? createStore()}>
        <PdfViewer
          pdfId={BOOK.id}
          book={BOOK}
          bookError={undefined}
          onSelectionClick={() => {}}
          measureSelection={options.measureSelection}
          saveSelection={options.saveSelection}
          onAddSelectionToNote={options.onAddSelectionToNote}
          onPrepareSelectionQuickNote={options.onPrepareSelectionQuickNote}
        />
      </Provider>
    </SwrTestCache>,
  );
}

/**
 * Settle on a passage, the way a reader does.
 *
 * The viewer hears about it from the browser announcing the selection rather
 * than from a mouse button coming up, and waits for the announcements to stop —
 * so the wait is part of the gesture whatever the passage was chosen with.
 */
async function selectPassage(_container: HTMLElement) {
  document.dispatchEvent(new Event("selectionchange"));
  return screen.findByPlaceholderText("選択した文章について質問する...");
}

describe("PdfViewer", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    localStorage.clear();
  });

  it("offers to ask about a passage held down on a touch screen", async () => {
    // A finger never sends mouseup: the passage is settled on by the browser
    // and announced through selectionchange, once the handles stop moving.
    setViewportWidth(PHONE_WIDTH);
    vi.stubGlobal("fetch", bucketWithout({ ok: true }, 200));
    renderViewer({ measureSelection: () => MEASURED });

    document.dispatchEvent(new Event("selectionchange"));

    expect(await screen.findByRole("button", { name: "AIに質問" })).toBeInTheDocument();
    expect(screen.getByText(`“${PASSAGE}”`)).toBeInTheDocument();
  });

  it("keeps the passage the reader chose when a later settle finds nothing on the page", async () => {
    // Opening the box moves the selection into its field, and that move is
    // announced like any other — so the viewer settles a second time on a
    // selection that has left the page. A measurement that comes back with
    // nothing must leave the passage the reader chose where it is, rather than
    // replacing it or clearing it.
    vi.stubGlobal("fetch", bucketWithout({ ok: true }, 200));
    let settles = 0;
    const { container } = renderViewer({
      measureSelection: () => (settles++ === 0 ? MEASURED : null),
    });

    const input = await selectPassage(container);
    const marked = screen.getAllByTestId("pending-selection").length;

    document.dispatchEvent(new Event("selectionchange"));
    await waitFor(() => expect(settles).toBe(2));

    expect(input).toBeInTheDocument();
    expect(screen.getAllByTestId("pending-selection")).toHaveLength(marked);
  });

  it("puts the question box up only once the reader asks for it", async () => {
    // The box takes the keyboard with it, so it waits behind the bar rather
    // than covering the page the moment a word is selected.
    setViewportWidth(PHONE_WIDTH);
    vi.stubGlobal("fetch", bucketWithout({ ok: true }, 200));
    renderViewer({ measureSelection: () => MEASURED });
    document.dispatchEvent(new Event("selectionchange"));

    const ask = await screen.findByRole("button", { name: "AIに質問" });
    expect(screen.queryByPlaceholderText("選択した文章について質問する...")).toBeNull();

    await userEvent.click(ask);

    expect(
      await screen.findByPlaceholderText("選択した文章について質問する..."),
    ).toBeInTheDocument();
  });

  it("offers the bar rather than the box to a finger on a wide screen", async () => {
    // A tablet is a finger on a screen with room for both panes. The box is
    // what the wide layout gives a mouse, and it takes the keyboard and the
    // focus with it — on a finger that ends the selection the reader was still
    // adjusting, so there is no way back to widen it.
    vi.stubGlobal("fetch", bucketWithout({ ok: true }, 200));
    renderViewer({ measureSelection: () => MEASURED });

    window.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "touch" }));
    document.dispatchEvent(new Event("selectionchange"));

    expect(await screen.findByRole("button", { name: "AIに質問" })).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("選択した文章について質問する...")).toBeNull();
  });

  it("still puts the box straight onto the passage a mouse chose", async () => {
    // Where the mouse left it, and without a bar in between: nothing about a
    // mouse selection is at risk from the box opening on it.
    vi.stubGlobal("fetch", bucketWithout({ ok: true }, 200));
    renderViewer({ measureSelection: () => MEASURED });

    window.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }));
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "mouse" }));
    document.dispatchEvent(new Event("selectionchange"));

    expect(
      await screen.findByPlaceholderText("選択した文章について質問する..."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "AIに質問" })).toBeNull();
  });

  it("waits for the passage to stop growing before offering to ask about it", async () => {
    // Dragging the platform's selection handles announces a new selection the
    // whole way. Measuring each one would offer to ask about a passage the
    // reader is still in the middle of choosing.
    setViewportWidth(PHONE_WIDTH);
    vi.stubGlobal("fetch", bucketWithout({ ok: true }, 200));
    let measured = 0;
    renderViewer({
      measureSelection: () => {
        measured += 1;
        return MEASURED;
      },
    });

    document.dispatchEvent(new Event("selectionchange"));
    await new Promise((resolve) => setTimeout(resolve, 100));
    document.dispatchEvent(new Event("selectionchange"));

    await screen.findByRole("button", { name: "AIに質問" });
    expect(measured).toBe(1);
  });

  it("keeps the passage selected when the question box is closed again", async () => {
    // Closing the box is changing one's mind about typing, not about the
    // passage — so the offer is still there to be taken again.
    setViewportWidth(PHONE_WIDTH);
    vi.stubGlobal("fetch", bucketWithout({ ok: true }, 200));
    renderViewer({ measureSelection: () => MEASURED });
    document.dispatchEvent(new Event("selectionchange"));
    await userEvent.click(await screen.findByRole("button", { name: "AIに質問" }));
    await screen.findByPlaceholderText("選択した文章について質問する...");

    await userEvent.click(screen.getByRole("button", { name: "キャンセル" }));

    expect(await screen.findByRole("button", { name: "AIに質問" })).toBeInTheDocument();
    expect(screen.getByText(`“${PASSAGE}”`)).toBeInTheDocument();
  });

  it("drops the passage when the reader says they are done with it", async () => {
    setViewportWidth(PHONE_WIDTH);
    vi.stubGlobal("fetch", bucketWithout({ ok: true }, 200));
    renderViewer({ measureSelection: () => MEASURED });
    document.dispatchEvent(new Event("selectionchange"));
    const bar = await screen.findByRole("button", { name: "AIに質問" });

    await userEvent.click(screen.getByRole("button", { name: "選択をやめる" }));

    expect(bar).not.toBeInTheDocument();
  });

  it("stores the passage a touch reader asked about, as it was measured", async () => {
    setViewportWidth(PHONE_WIDTH);
    vi.stubGlobal("fetch", bucketWithout({ ok: true }, 200));
    const saved: unknown[] = [];
    const saveSelection: SaveSelection = (pdfId, draft) => {
      saved.push([pdfId, draft]);
      return okAsync(STORED);
    };
    renderViewer({ measureSelection: () => MEASURED, saveSelection });
    document.dispatchEvent(new Event("selectionchange"));
    await userEvent.click(await screen.findByRole("button", { name: "AIに質問" }));

    const input = await screen.findByPlaceholderText("選択した文章について質問する...");
    await userEvent.type(input, "この段落を一言で要約して");
    await userEvent.click(screen.getByRole("button", { name: "質問する" }));

    expect(saved).toStrictEqual([
      [
        BOOK.id,
        {
          requestId: expect.any(String),
          selectedText: PASSAGE,
          pageNumber: MEASURED.selectionPosition.pageNumber,
          positionData: MEASURED.selectionPosition,
        },
      ],
    ]);
  });

  it("adds a wide-screen passage to notes only after its highlight is stored", async () => {
    vi.stubGlobal("fetch", bucketWithout({ ok: true }, 200));
    let finishSaving!: (stored: Result<CreatedSelection, ApiError>) => void;
    const inFlight = new Promise<Result<CreatedSelection, ApiError>>((resolve) => {
      finishSaving = resolve;
    });
    const addedToNote: CreatedSelection[] = [];
    const { container } = renderViewer({
      measureSelection: () => MEASURED,
      saveSelection: () => new ResultAsync(inFlight),
      onAddSelectionToNote: (selection) => addedToNote.push(selection),
    });
    const input = await selectPassage(container);

    await userEvent.click(screen.getByRole("button", { name: "メモに追加" }));

    expect(screen.getByRole("button", { name: "メモに追加中..." })).toBeDisabled();
    expect(addedToNote).toStrictEqual([]);

    await act(async () => {
      finishSaving(ok(STORED));
    });

    await waitFor(() => expect(addedToNote).toStrictEqual([STORED]));
    expect(input).not.toBeInTheDocument();
  });

  it("keeps a newer selection when an older wide note save completes", async () => {
    vi.stubGlobal("fetch", pendingPdfWithSuccessfulWrites());
    let measured = MEASURED;
    let measureCalls = 0;
    let finishFirstSave!: (stored: Result<CreatedSelection, ApiError>) => void;
    const firstSave = new Promise<Result<CreatedSelection, ApiError>>((resolve) => {
      finishFirstSave = resolve;
    });
    const drafts: SelectionDraft[] = [];
    const addedToNote: CreatedSelection[] = [];
    const { container } = renderViewer({
      measureSelection: () => {
        measureCalls += 1;
        return measured;
      },
      saveSelection: (_pdfId, draft) => {
        drafts.push(draft);
        return drafts.length === 1 ? new ResultAsync(firstSave) : okAsync(NEXT_STORED);
      },
      onAddSelectionToNote: (selection) => addedToNote.push(selection),
    });
    await selectPassage(container);
    await userEvent.click(screen.getByRole("button", { name: "メモに追加" }));
    measured = NEXT_MEASURED;
    const beforeNextSelection = measureCalls;

    document.dispatchEvent(new Event("selectionchange"));
    await waitFor(() => expect(measureCalls).toBeGreaterThan(beforeNextSelection));
    await act(async () => {
      finishFirstSave(ok(STORED));
    });

    await waitFor(() => expect(addedToNote).toStrictEqual([STORED]));
    expect(screen.getAllByRole("button", { name: "ハイライトのチャットを開く" })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "メモに追加" }));

    await waitFor(() => expect(addedToNote).toStrictEqual([STORED, NEXT_STORED]));
    expect(drafts).toHaveLength(2);
    expect(drafts[1].selectedText).toBe(NEXT_MEASURED.selectedText);
    expect(drafts[1].requestId).not.toBe(drafts[0].requestId);
  });

  it("hands a stored passage to the latest note callback after its parent rerenders", async () => {
    // A highlight save can outlive a caret move or a layout change in the
    // parent. The callback that was current when the click began contains the
    // old destination, so completing through it would insert into stale state.
    vi.stubGlobal("fetch", bucketWithout({ ok: true }, 200));
    let finishSaving!: (stored: Result<CreatedSelection, ApiError>) => void;
    const inFlight = new Promise<Result<CreatedSelection, ApiError>>((resolve) => {
      finishSaving = resolve;
    });
    const firstDestination: CreatedSelection[] = [];
    const latestDestination: CreatedSelection[] = [];
    const store = createStore();
    const viewer = (onAddSelectionToNote: (selection: CreatedSelection) => void) => (
      <SwrTestCache seed={{ [bookKey(BOOK.id)]: BOOK }}>
        <Provider store={store}>
          <PdfViewer
            pdfId={BOOK.id}
            book={BOOK}
            bookError={undefined}
            onSelectionClick={() => {}}
            measureSelection={() => MEASURED}
            saveSelection={() => new ResultAsync(inFlight)}
            onAddSelectionToNote={onAddSelectionToNote}
          />
        </Provider>
      </SwrTestCache>
    );
    const rendered = render(
      viewer((selection) => {
        firstDestination.push(selection);
      }),
    );
    await selectPassage(rendered.container);
    await userEvent.click(screen.getByRole("button", { name: "メモに追加" }));

    rendered.rerender(
      viewer((selection) => {
        latestDestination.push(selection);
      }),
    );
    await act(async () => {
      finishSaving(ok(STORED));
    });

    await waitFor(() => expect(latestDestination).toStrictEqual([STORED]), { timeout: 500 });
    expect(firstDestination).toStrictEqual([]);
  });

  it("keeps the wide-screen selection UI and callback untouched when note highlighting fails", async () => {
    vi.stubGlobal("fetch", bucketWithout({ ok: true }, 200));
    const addedToNote: CreatedSelection[] = [];
    const { container } = renderViewer({
      measureSelection: () => MEASURED,
      saveSelection: () => errAsync(new ApiError("PDF not found", "PDF_NOT_FOUND", 404)),
      onAddSelectionToNote: (selection) => addedToNote.push(selection),
    });
    const input = await selectPassage(container);

    await userEvent.click(screen.getByRole("button", { name: "メモに追加" }));

    expect(
      await screen.findByText("ハイライトを保存できませんでした: PDF not found"),
    ).toBeVisible();
    expect(input).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "メモに追加" })).toBeEnabled();
    expect(addedToNote).toStrictEqual([]);
  });

  it("does not attach an older wide note failure to a newer selection", async () => {
    vi.stubGlobal("fetch", pendingPdfWithSuccessfulWrites());
    let measured = MEASURED;
    let measureCalls = 0;
    let finishFirstSave!: (stored: Result<CreatedSelection, ApiError>) => void;
    const firstSave = new Promise<Result<CreatedSelection, ApiError>>((resolve) => {
      finishFirstSave = resolve;
    });
    const drafts: SelectionDraft[] = [];
    const addedToNote: CreatedSelection[] = [];
    const { container } = renderViewer({
      measureSelection: () => {
        measureCalls += 1;
        return measured;
      },
      saveSelection: (_pdfId, draft) => {
        drafts.push(draft);
        return drafts.length === 1 ? new ResultAsync(firstSave) : okAsync(NEXT_STORED);
      },
      onAddSelectionToNote: (selection) => addedToNote.push(selection),
    });
    await selectPassage(container);
    await userEvent.click(screen.getByRole("button", { name: "メモに追加" }));
    measured = NEXT_MEASURED;
    const beforeNextSelection = measureCalls;

    document.dispatchEvent(new Event("selectionchange"));
    await waitFor(() => expect(measureCalls).toBeGreaterThan(beforeNextSelection));
    await act(async () => {
      finishFirstSave(err(new ApiError("first failed", "PDF_NOT_FOUND", 404)));
    });

    await waitFor(() =>
      expect(screen.queryByText("ハイライトを保存できませんでした: first failed")).toBeNull(),
    );
    await userEvent.click(screen.getByRole("button", { name: "メモに追加" }));

    await waitFor(() => expect(addedToNote).toStrictEqual([NEXT_STORED]));
    expect(drafts).toHaveLength(2);
    expect(drafts[1].selectedText).toBe(NEXT_MEASURED.selectedText);
    expect(drafts[1].requestId).not.toBe(drafts[0].requestId);
  });

  it("reuses one selection request id when a lost save response is retried", async () => {
    vi.stubGlobal("fetch", bucketWithout({ ok: true }, 200));
    const drafts: SelectionDraft[] = [];
    let attempt = 0;
    const { container } = renderViewer({
      measureSelection: () => MEASURED,
      saveSelection: (_pdfId, draft) => {
        drafts.push(draft);
        attempt += 1;
        return attempt === 1
          ? errAsync(new ApiError("応答を受け取れませんでした", "NETWORK_ERROR", 0, "network"))
          : okAsync(STORED);
      },
      onAddSelectionToNote: () => {},
    });
    await selectPassage(container);

    await userEvent.click(screen.getByRole("button", { name: "メモに追加" }));
    await screen.findByText("ハイライトを保存できませんでした: 応答を受け取れませんでした");
    await userEvent.click(screen.getByRole("button", { name: "メモに追加" }));

    expect(drafts).toHaveLength(2);
    expect(drafts[0].requestId).toStrictEqual(expect.any(String));
    expect(drafts[1].requestId).toBe(drafts[0].requestId);
  });

  it("stores one highlight when the wide-screen note action is clicked twice in flight", async () => {
    vi.stubGlobal("fetch", bucketWithout({ ok: true }, 200));
    let finishSaving!: (stored: Result<CreatedSelection, ApiError>) => void;
    const inFlight = new Promise<Result<CreatedSelection, ApiError>>((resolve) => {
      finishSaving = resolve;
    });
    const saved: string[] = [];
    const { container } = renderViewer({
      measureSelection: () => MEASURED,
      saveSelection: (pdfId) => {
        saved.push(pdfId);
        return new ResultAsync(inFlight);
      },
      onAddSelectionToNote: () => {},
    });
    await selectPassage(container);

    const add = screen.getByRole("button", { name: "メモに追加" });
    await userEvent.dblClick(add);

    expect(saved).toStrictEqual([BOOK.id]);

    await act(async () => {
      finishSaving(ok(STORED));
    });
  });

  it("starts one save when note then question are triggered in the same event batch", async () => {
    vi.stubGlobal("fetch", bucketWithout({ ok: true }, 200));
    let finishSaving!: (stored: Result<CreatedSelection, ApiError>) => void;
    const inFlight = new Promise<Result<CreatedSelection, ApiError>>((resolve) => {
      finishSaving = resolve;
    });
    const saved: string[] = [];
    const { container } = renderViewer({
      measureSelection: () => MEASURED,
      saveSelection: (pdfId) => {
        saved.push(pdfId);
        return new ResultAsync(inFlight);
      },
      onAddSelectionToNote: () => {},
    });
    const input = await selectPassage(container);
    await userEvent.type(input, "この段落を一言で要約して");
    const add = screen.getByRole("button", { name: "メモに追加" });

    act(() => {
      add.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });

    expect(saved).toStrictEqual([BOOK.id]);
    expect(input).toHaveValue("この段落を一言で要約して");
    expect(screen.getAllByTestId("pending-selection").length).toBeGreaterThan(0);

    await act(async () => {
      finishSaving(ok(STORED));
    });
  });

  it("starts one save when question then note are triggered in the same event batch", async () => {
    vi.stubGlobal("fetch", bucketWithout({ ok: true }, 200));
    let finishSaving!: (stored: Result<CreatedSelection, ApiError>) => void;
    const inFlight = new Promise<Result<CreatedSelection, ApiError>>((resolve) => {
      finishSaving = resolve;
    });
    const saved: string[] = [];
    const { container } = renderViewer({
      measureSelection: () => MEASURED,
      saveSelection: (pdfId) => {
        saved.push(pdfId);
        return new ResultAsync(inFlight);
      },
      onAddSelectionToNote: () => {},
    });
    const input = await selectPassage(container);
    await userEvent.type(input, "この段落を一言で要約して");
    const add = screen.getByRole("button", { name: "メモに追加" });

    act(() => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
      add.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    expect(saved).toStrictEqual([BOOK.id]);
    expect(input).toHaveValue("この段落を一言で要約して");
    expect(screen.getAllByTestId("pending-selection").length).toBeGreaterThan(0);

    await act(async () => {
      finishSaving(ok(STORED));
    });
  });

  it("hands a narrow-screen note action the complete draft without storing it", async () => {
    setViewportWidth(PHONE_WIDTH);
    vi.stubGlobal("fetch", bucketWithout({ ok: true }, 200));
    const saved: string[] = [];
    const prepared: SelectionDraft[] = [];
    renderViewer({
      measureSelection: () => MEASURED,
      saveSelection: (pdfId) => {
        saved.push(pdfId);
        return okAsync(STORED);
      },
      onPrepareSelectionQuickNote: (draft) => prepared.push(draft),
    });
    document.dispatchEvent(new Event("selectionchange"));

    await userEvent.click(await screen.findByRole("button", { name: "メモに追加" }));

    expect(saved).toStrictEqual([]);
    expect(prepared).toStrictEqual([
      {
        requestId: expect.any(String),
        selectedText: PASSAGE,
        pageNumber: MEASURED.selectionPosition.pageNumber,
        positionData: MEASURED.selectionPosition,
      },
    ]);
    expect(screen.queryByRole("button", { name: "メモに追加" })).toBeNull();
  });

  it("stores a touch-wide action before handing the created selection to notes", async () => {
    vi.stubGlobal("fetch", bucketWithout({ ok: true }, 200));
    const saved: string[] = [];
    const addedToNote: CreatedSelection[] = [];
    const prepared: SelectionDraft[] = [];
    renderViewer({
      measureSelection: () => MEASURED,
      saveSelection: (pdfId) => {
        saved.push(pdfId);
        return okAsync(STORED);
      },
      onAddSelectionToNote: (selection) => addedToNote.push(selection),
      onPrepareSelectionQuickNote: (draft) => prepared.push(draft),
    });
    window.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" }));
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerType: "touch" }));
    document.dispatchEvent(new Event("selectionchange"));

    await userEvent.click(await screen.findByRole("button", { name: "メモに追加" }));

    expect(saved).toStrictEqual([BOOK.id]);
    expect(addedToNote).toStrictEqual([STORED]);
    expect(prepared).toStrictEqual([]);
  });

  it("zooms the book in on a pinch, instead of letting the browser zoom the app", async () => {
    // macOS delivers a trackpad pinch as a ctrlKey wheel event, which the
    // browser answers with its own page zoom unless the viewer takes it.
    vi.stubGlobal("fetch", bucketWithout({ ok: true }, 200));
    const store = createStore();
    const { container } = renderViewer({ measureSelection: () => MEASURED, store });
    const input = await selectPassage(container);

    const wentToTheBrowser = fireEvent.wheel(input, { ctrlKey: true, deltaY: -100 });

    expect(store.get(zoomAtomFor(BOOK.id))).toBe(1.5);
    expect(wentToTheBrowser).toBe(false);
  });

  it("leaves a wheel without the pinch modifier to the pane it scrolls", async () => {
    vi.stubGlobal("fetch", bucketWithout({ ok: true }, 200));
    const store = createStore();
    const { container } = renderViewer({ measureSelection: () => MEASURED, store });
    const input = await selectPassage(container);

    const wentToTheBrowser = fireEvent.wheel(input, { deltaY: -100 });

    expect(store.get(zoomAtomFor(BOOK.id))).toBe(1);
    // Refusing this one too would leave the pane unable to scroll
    expect(wentToTheBrowser).toBe(true);
  });

  it("says why the book cannot be shown instead of opening to a blank page", async () => {
    // The book itself loaded, so none of the other messages apply: without this
    // one the reader is left looking at an empty panel under a page counter.
    vi.stubGlobal(
      "fetch",
      bucketWithout(
        { error: { code: "PDF_FILE_MISSING", message: "PDF binary not found in storage" } },
        404,
      ),
    );

    renderViewer();

    expect(await screen.findByRole("alert")).toHaveTextContent(
      /^PDFを表示できません: PDF binary not found in storage$/,
    );
  });

  it("keeps saying the book is loading until pdf.js hands over the document", async () => {
    // A book that was just uploaded is already in the cache, so the reader
    // arrives with `book` in hand and the binary still on its way. Saying
    // nothing there leaves them looking at an empty grey pane for as long as
    // the download and pdf.js take.
    vi.stubGlobal("fetch", (() => new Promise<Response>(() => {})) as unknown as typeof fetch);

    renderViewer();

    expect(await screen.findByText("PDFを読み込み中...")).toBeVisible();
  });

  it("keeps a newer selection when an older question save completes", async () => {
    vi.stubGlobal("fetch", pendingPdfWithSuccessfulWrites());
    let measured = MEASURED;
    let measureCalls = 0;
    let finishFirstSave!: (stored: Result<CreatedSelection, ApiError>) => void;
    const firstSave = new Promise<Result<CreatedSelection, ApiError>>((resolve) => {
      finishFirstSave = resolve;
    });
    const drafts: SelectionDraft[] = [];
    const addedToNote: CreatedSelection[] = [];
    const store = createStore();
    const { container } = renderViewer({
      measureSelection: () => {
        measureCalls += 1;
        return measured;
      },
      saveSelection: (_pdfId, draft) => {
        drafts.push(draft);
        return drafts.length === 1 ? new ResultAsync(firstSave) : okAsync(NEXT_STORED);
      },
      onAddSelectionToNote: (selection) => addedToNote.push(selection),
      store,
    });
    const input = await selectPassage(container);
    await userEvent.type(input, "この段落を一言で要約して");
    await userEvent.click(screen.getByRole("button", { name: "質問する" }));
    measured = NEXT_MEASURED;
    const beforeNextSelection = measureCalls;

    document.dispatchEvent(new Event("selectionchange"));
    await waitFor(() => expect(measureCalls).toBeGreaterThan(beforeNextSelection));
    await act(async () => {
      finishFirstSave(ok(STORED));
    });

    await waitFor(() =>
      expect(store.get(activeSelectionAtom)).toStrictEqual({
        id: STORED.id,
        selectedText: STORED.selectedText,
        pageNumber: STORED.pageNumber,
      }),
    );
    expect(screen.getAllByRole("button", { name: "ハイライトのチャットを開く" })).toHaveLength(1);
    expect(screen.queryByText(/^ハイライトを保存できませんでした/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "メモに追加" }));

    await waitFor(() => expect(addedToNote).toStrictEqual([NEXT_STORED]));
    expect(drafts).toHaveLength(2);
    expect(drafts[1].selectedText).toBe(NEXT_MEASURED.selectedText);
    expect(drafts[1].requestId).not.toBe(drafts[0].requestId);
  });

  it("does not attach an older question failure to a newer selection", async () => {
    vi.stubGlobal("fetch", pendingPdfWithSuccessfulWrites());
    let measured = MEASURED;
    let measureCalls = 0;
    let finishFirstSave!: (stored: Result<CreatedSelection, ApiError>) => void;
    const firstSave = new Promise<Result<CreatedSelection, ApiError>>((resolve) => {
      finishFirstSave = resolve;
    });
    const drafts: SelectionDraft[] = [];
    const addedToNote: CreatedSelection[] = [];
    const { container } = renderViewer({
      measureSelection: () => {
        measureCalls += 1;
        return measured;
      },
      saveSelection: (_pdfId, draft) => {
        drafts.push(draft);
        return drafts.length === 1 ? new ResultAsync(firstSave) : okAsync(NEXT_STORED);
      },
      onAddSelectionToNote: (selection) => addedToNote.push(selection),
    });
    const input = await selectPassage(container);
    await userEvent.type(input, "この段落を一言で要約して");
    await userEvent.click(screen.getByRole("button", { name: "質問する" }));
    measured = NEXT_MEASURED;
    const beforeNextSelection = measureCalls;

    document.dispatchEvent(new Event("selectionchange"));
    await waitFor(() => expect(measureCalls).toBeGreaterThan(beforeNextSelection));
    await act(async () => {
      finishFirstSave(err(new ApiError("first failed", "PDF_NOT_FOUND", 404)));
    });

    await waitFor(() =>
      expect(screen.queryByText("ハイライトを保存できませんでした: first failed")).toBeNull(),
    );
    expect(screen.queryByRole("button", { name: "ハイライトのチャットを開く" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "メモに追加" }));

    await waitFor(() => expect(addedToNote).toStrictEqual([NEXT_STORED]));
    expect(drafts).toHaveLength(2);
    expect(drafts[1].selectedText).toBe(NEXT_MEASURED.selectedText);
    expect(drafts[1].requestId).not.toBe(drafts[0].requestId);
  });

  it("says the highlight could not be saved and keeps the question in reach", async () => {
    // The issue's symptom was the opposite: the popover closed on submit, so a
    // failed save took the typed question with it and said nothing.
    vi.stubGlobal("fetch", bucketWithout({ ok: true }, 200));
    const { container } = renderViewer({
      measureSelection: () => MEASURED,
      saveSelection: () => errAsync(new ApiError("PDF not found", "PDF_NOT_FOUND", 404)),
    });

    const input = await selectPassage(container);
    await userEvent.type(input, "この段落を一言で要約して");
    await userEvent.click(screen.getByRole("button", { name: "質問する" }));

    expect(
      await screen.findByText("ハイライトを保存できませんでした: PDF not found"),
    ).toBeVisible();
    // The question is still there to send again
    expect(screen.getByPlaceholderText("選択した文章について質問する...")).toHaveValue(
      "この段落を一言で要約して",
    );
  });

  it("clears a question save alert when the selection is explicitly dismissed", async () => {
    vi.stubGlobal("fetch", bucketWithout({ ok: true }, 200));
    const { container } = renderViewer({
      measureSelection: () => MEASURED,
      saveSelection: () => errAsync(new ApiError("PDF not found", "PDF_NOT_FOUND", 404)),
    });
    const input = await selectPassage(container);
    await userEvent.type(input, "この段落を一言で要約して");
    await userEvent.click(screen.getByRole("button", { name: "質問する" }));
    await screen.findByText("ハイライトを保存できませんでした: PDF not found");

    await userEvent.click(screen.getByRole("button", { name: "キャンセル" }));

    expect(screen.queryByText("ハイライトを保存できませんでした: PDF not found")).toBeNull();
  });

  it("clears a question save alert when another selection settles", async () => {
    vi.stubGlobal("fetch", bucketWithout({ ok: true }, 200));
    let measured = MEASURED;
    let measureCalls = 0;
    const { container } = renderViewer({
      measureSelection: () => {
        measureCalls += 1;
        return measured;
      },
      saveSelection: () => errAsync(new ApiError("PDF not found", "PDF_NOT_FOUND", 404)),
    });
    const input = await selectPassage(container);
    await userEvent.type(input, "この段落を一言で要約して");
    await userEvent.click(screen.getByRole("button", { name: "質問する" }));
    await screen.findByText("ハイライトを保存できませんでした: PDF not found");
    measured = NEXT_MEASURED;
    const beforeNextSelection = measureCalls;

    document.dispatchEvent(new Event("selectionchange"));

    await waitFor(() => expect(measureCalls).toBeGreaterThan(beforeNextSelection));
    expect(screen.queryByText("ハイライトを保存できませんでした: PDF not found")).toBeNull();
  });

  it("clears an old question alert when the next note save starts", async () => {
    vi.stubGlobal("fetch", bucketWithout({ ok: true }, 200));
    let finishSaving!: (stored: Result<CreatedSelection, ApiError>) => void;
    const inFlight = new Promise<Result<CreatedSelection, ApiError>>((resolve) => {
      finishSaving = resolve;
    });
    let saves = 0;
    const { container } = renderViewer({
      measureSelection: () => MEASURED,
      saveSelection: () => {
        saves += 1;
        return saves === 1
          ? errAsync(new ApiError("PDF not found", "PDF_NOT_FOUND", 404))
          : new ResultAsync(inFlight);
      },
      onAddSelectionToNote: () => {},
    });
    const input = await selectPassage(container);
    await userEvent.type(input, "この段落を一言で要約して");
    await userEvent.click(screen.getByRole("button", { name: "質問する" }));
    await screen.findByText("ハイライトを保存できませんでした: PDF not found");

    await userEvent.click(screen.getByRole("button", { name: "メモに追加" }));

    expect(screen.queryByText("ハイライトを保存できませんでした: PDF not found")).toBeNull();
    expect(screen.getByRole("button", { name: "メモに追加中..." })).toBeDisabled();

    await act(async () => {
      finishSaving(ok(STORED));
    });
  });

  it("closes the popover once the highlight is stored", async () => {
    vi.stubGlobal("fetch", bucketWithout({ ok: true }, 200));
    const { container } = renderViewer({
      measureSelection: () => MEASURED,
      saveSelection: () => okAsync(STORED),
    });

    const input = await selectPassage(container);
    await userEvent.type(input, "この段落を一言で要約して");
    await userEvent.click(screen.getByRole("button", { name: "質問する" }));

    await waitFor(() =>
      expect(screen.queryByPlaceholderText("選択した文章について質問する...")).toBeNull(),
    );
    expect(screen.queryByText(/^ハイライトを保存できませんでした/)).toBeNull();
  });

  it("raises the chat on one column, so the answer is not streamed out of sight", async () => {
    // The sheet a phone reads over starts closed, and nothing in the ask used
    // to open it: the answer arrived behind the page it was asked about.
    setViewportWidth(PHONE_WIDTH);
    vi.stubGlobal("fetch", bucketWithout({ ok: true }, 200));
    const store = createStore();
    renderViewer({
      measureSelection: () => MEASURED,
      saveSelection: () => okAsync(STORED),
      store,
    });
    document.dispatchEvent(new Event("selectionchange"));
    await userEvent.click(await screen.findByRole("button", { name: "AIに質問" }));

    const input = await screen.findByPlaceholderText("選択した文章について質問する...");
    await userEvent.type(input, "この段落を一言で要約して");
    await userEvent.click(screen.getByRole("button", { name: "質問する" }));

    await waitFor(() => expect(store.get(chatSheetAtom)).toBe("half"));
  });

  it("stores one highlight however many times the reader submits while the save is in flight", async () => {
    // The popover now outlives the submit, so only its own gate stops a second
    // ask storing a second highlight and starting an answer that aborts the
    // first one.
    vi.stubGlobal("fetch", bucketWithout({ ok: true }, 200));
    const saves: string[] = [];
    let storeIt!: (stored: Result<CreatedSelection, ApiError>) => void;
    const inFlight = new Promise<Result<CreatedSelection, ApiError>>((resolve) => {
      storeIt = resolve;
    });
    const saveSelection: SaveSelection = (pdfId) => {
      saves.push(pdfId);
      return new ResultAsync(inFlight);
    };
    const { container } = renderViewer({ measureSelection: () => MEASURED, saveSelection });

    const input = await selectPassage(container);
    await userEvent.type(input, "この段落を一言で要約して");
    await userEvent.click(screen.getByRole("button", { name: "質問する" }));

    // While it is saving, neither route in starts a second one
    await userEvent.click(await screen.findByRole("button", { name: "送信中..." }));
    fireEvent.keyDown(input, { key: "Enter" });

    expect(saves).toStrictEqual([BOOK.id]);

    await act(async () => {
      storeIt(ok(STORED));
    });
  });

  it("hands the passage to a copy made while the question box is up", async () => {
    // The box's own focus collapses the browser's selection, so what the reader
    // chose reaches the clipboard only if the viewer passes it along.
    vi.stubGlobal("fetch", bucketWithout({ ok: true }, 200));
    const { container } = renderViewer({ measureSelection: () => MEASURED });
    const input = await selectPassage(container);

    const setData = vi.fn();
    const copy = new Event("copy", { cancelable: true, bubbles: true });
    Object.defineProperty(copy, "clipboardData", { value: { setData } });
    input.dispatchEvent(copy);

    expect(setData.mock.calls).toStrictEqual([["text/plain", PASSAGE]]);
  });
});
