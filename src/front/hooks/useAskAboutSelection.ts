import { useCallback, useState } from "react";
import { useSetAtom } from "jotai";
import {
  activeSelectionAtom,
  chatMessagesAtom,
  chatPanelOpenAtom,
  chatSheetAtom,
} from "../atoms/chatAtom";
import { useIsNarrow } from "./useIsNarrow";
import type { CreatedSelection } from "../../shared/schemas/selection";
import { useChatStream } from "./useChatStream";
import { useStoreSelection, type SaveSelection, type SelectionDraft } from "./useStoreSelection";

// Keep the old type import path working for existing callers while the storage
// concern itself lives in `useStoreSelection`.
export type { SaveSelection, SelectionDraft } from "./useStoreSelection";

/**
 * Turn a passage the reader has just marked into a highlight and a question
 * about it.
 *
 * The two steps are in that order for a reason: the answer is stored against
 * the highlight, so asking before the highlight exists would stream a reply
 * with nothing to hang it on. A failure to store therefore stops the ask, and
 * the caller is told so — the viewer keeps its popover open, with the question
 * still in it, rather than losing what the reader typed.
 */
export function useAskAboutSelection(
  addHighlight: (selection: CreatedSelection) => void,
  saveSelection?: SaveSelection,
) {
  const setActiveSelection = useSetAtom(activeSelectionAtom);
  const setChatMessages = useSetAtom(chatMessagesAtom);
  const setChatSheet = useSetAtom(chatSheetAtom);
  const setChatPanelOpen = useSetAtom(chatPanelOpenAtom);
  const isNarrow = useIsNarrow();
  const { sendMessage } = useChatStream();
  const { store } = useStoreSelection(addHighlight, saveSelection);
  const [saveError, setSaveError] = useState<string | null>(null);
  const clearSaveError = useCallback(() => setSaveError(null), []);

  const askAboutSelection = useCallback(
    (pdfId: string, draft: SelectionDraft, question: string, useWebSearch: boolean) => {
      clearSaveError();

      return store(pdfId, draft)
        .andTee((selection) => {
          setActiveSelection({
            id: selection.id,
            selectedText: selection.selectedText,
            pageNumber: selection.pageNumber,
          });
          setChatMessages([]);
          // Asking is the strongest way a reader can ask for the conversation,
          // so the answer is never streamed into something folded away: the
          // sheet comes up on one column and a hidden panel comes back on two.
          // A sheet already drawn up is left where it is, as `openChat` does.
          if (isNarrow) {
            setChatSheet((sheet) => (sheet === "closed" ? "half" : sheet));
          } else {
            setChatPanelOpen(true);
          }
          // The answer is not waited for. It takes seconds to arrive, and what
          // the caller is waiting on is whether the highlight was kept. The
          // stream reports its own failures through chatErrorAtom.
          void sendMessage(pdfId, selection.id, question, useWebSearch);
        })
        .orTee((failure) => {
          // Why it failed, in the server's words. The viewer writes the
          // sentence around it, as every other display of a failure does.
          setSaveError(failure.message);
        });
    },
    [
      isNarrow,
      clearSaveError,
      sendMessage,
      setActiveSelection,
      setChatMessages,
      setChatPanelOpen,
      setChatSheet,
      store,
    ],
  );

  return { askAboutSelection, saveError, clearSaveError };
}
