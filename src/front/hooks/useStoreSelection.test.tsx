import { describe, expect, it } from "vite-plus/test";
import { act, renderHook } from "@testing-library/react";
import { errAsync, okAsync } from "neverthrow";
import { ApiError } from "../lib/fetcher";
import type { CreatedSelection } from "../../shared/schemas/selection";
import { useStoreSelection, type SaveSelection, type SelectionDraft } from "./useStoreSelection";

const PDF_ID = "p1";

const DRAFT: SelectionDraft = {
  requestId: "7e0055d7-5bc3-40af-bab4-4db62a9f8ef9",
  selectedText: "エッジはサーバーレス実行基盤です。",
  pageNumber: 42,
  positionData: {
    rects: [{ x: 10, y: 20, width: 100, height: 16 }],
    pageWidth: 600,
  },
};

const STORED: CreatedSelection = {
  id: "s1",
  selectedText: DRAFT.selectedText,
  pageNumber: DRAFT.pageNumber,
  positionData: DRAFT.positionData,
  createdAt: "2026-08-01T10:00:00.000Z",
};

describe("useStoreSelection", () => {
  it("returns the stored selection and adds its highlight exactly once", async () => {
    const added: CreatedSelection[] = [];
    const saved: Array<[string, SelectionDraft]> = [];
    const saveSelection: SaveSelection = (pdfId, draft) => {
      saved.push([pdfId, draft]);
      return okAsync(STORED);
    };
    const { result } = renderHook(() =>
      useStoreSelection((selection) => added.push(selection), saveSelection),
    );

    let stored!: Awaited<ReturnType<typeof result.current.store>>;
    await act(async () => {
      stored = await result.current.store(PDF_ID, DRAFT);
    });

    expect(stored._unsafeUnwrap()).toStrictEqual(STORED);
    expect(saved).toStrictEqual([[PDF_ID, DRAFT]]);
    expect(added).toStrictEqual([STORED]);
  });

  it("returns the save failure without adding a highlight", async () => {
    const failure = new ApiError("PDF not found", "PDF_NOT_FOUND", 404);
    const added: CreatedSelection[] = [];
    const { result } = renderHook(() =>
      useStoreSelection(
        (selection) => added.push(selection),
        () => errAsync(failure),
      ),
    );

    let stored!: Awaited<ReturnType<typeof result.current.store>>;
    await act(async () => {
      stored = await result.current.store(PDF_ID, DRAFT);
    });

    expect(stored._unsafeUnwrapErr()).toBe(failure);
    expect(added).toStrictEqual([]);
  });
});
