import { useCallback } from "react";
import type { ResultAsync } from "neverthrow";
import { resultFetcher, type ApiError } from "../lib/fetcher";
import {
  createdSelectionSchema,
  type CreatedSelection,
  type PositionData,
} from "../../shared/schemas/selection";

/** A highlight the reader has just drawn, before the server has an id for it. */
export interface SelectionDraft {
  /** Stable for retries of this one selection operation. */
  requestId: string;
  selectedText: string;
  pageNumber: number;
  /** Sent whole; the endpoint keeps only `rects` and `pageWidth`. */
  positionData: PositionData;
}

export type SaveSelection = (
  pdfId: string,
  draft: SelectionDraft,
) => ResultAsync<CreatedSelection, ApiError>;

const saveSelectionRequest: SaveSelection = (pdfId, draft) =>
  resultFetcher(`/api/pdf/${pdfId}/selections`, createdSelectionSchema, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draft),
  });

/** Stores a selected passage and reflects the resulting highlight locally. */
export function useStoreSelection(
  addHighlight: (selection: CreatedSelection) => void,
  saveSelection: SaveSelection = saveSelectionRequest,
) {
  const store = useCallback(
    (pdfId: string, draft: SelectionDraft) =>
      saveSelection(pdfId, draft).andTee((selection) => {
        addHighlight(selection);
      }),
    [addHighlight, saveSelection],
  );

  return { store };
}
