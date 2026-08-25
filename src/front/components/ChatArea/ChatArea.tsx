import { useId, useRef, useState } from "react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  chatMessagesAtom,
  streamingContentAtom,
  isStreamingAtom,
  activeSelectionAtom,
  chatErrorAtom,
  abortChatStreamAtom,
  selectionDeletedAtom,
  type ActiveSelection,
} from "../../atoms/chatAtom";
import type { BookDetail } from "../../../shared/schemas/book";
import { ChatMessageList } from "./ChatMessageList";
import { ChatInput } from "./ChatInput";
import { HighlightListPanel } from "./HighlightListPanel";
import { useWebSearchAtom } from "../../atoms/settingsAtom";
import { useChatStream } from "../../hooks/useChatStream";
import { useHighlights, type DeleteHighlight } from "../../hooks/useHighlights";
import { useHighlightSearch, type SearchSelections } from "../../hooks/useHighlightSearch";
import { formatQuotedQuestion } from "../../lib/quotedQuestion";
import type { ReadChatQuote } from "../../lib/chatQuoteSelection";
import { rightPaneTabAtom, type RightPaneTab } from "../../atoms/noteAtom";
import { NotePane, type PendingNoteSelection } from "../NotePane/NotePane";
import type { NoteSession } from "../../hooks/useNoteSession";
import type { TextRange } from "../../lib/noteInsertion";

interface ChatAreaProps {
  /** The book being read, or nothing while it is still being read in. */
  book: BookDetail | undefined;
  /** Why the book could not be read, if it could not. */
  bookError?: Error;
  onSelectionClick: (selection: ActiveSelection) => void;
  /** Reads what a drag over the thread selected; injectable for tests. */
  readQuote?: ReadChatQuote;
  /** Removes a highlight; injectable so tests can record or refuse one. */
  deleteHighlight?: DeleteHighlight;
  /** Searches the highlights and their chats; injectable for the same reason. */
  searchHighlights?: SearchSelections;
  /** The book's note, which the pane's other tab holds. */
  note: NoteSession;
  noteEditorRange?: TextRange;
  onNoteEditorRangeChange?: (range: TextRange) => void;
  pendingNoteSelection?: PendingNoteSelection;
  noteSelectionSaveError?: string | null;
  noteSelectionSaving?: boolean;
  onQuickNoteSubmit?: (text: string) => Promise<boolean>;
  onQuickNoteRetry?: () => Promise<boolean>;
}

/** What each tab is called, and the order they sit in. */
const TABS: { tab: RightPaneTab; label: string }[] = [
  { tab: "chat", label: "チャット" },
  { tab: "note", label: "メモ" },
];

/**
 * The two things that can be beside the book.
 *
 * Rendered as tabs rather than as a pane each: a third column, or a drawer
 * over one, takes its room out of the page — and the page is what the reader
 * opened the book for.
 */
function PaneTabs({
  idBase,
  tab,
  onChange,
}: {
  idBase: string;
  tab: RightPaneTab;
  onChange: (tab: RightPaneTab) => void;
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);

  const selectAndFocus = (index: number) => {
    onChange(TABS[index].tab);
    buttons.current[index]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="チャットとメモ"
      className="flex shrink-0 border-b border-gray-200"
    >
      {TABS.map((entry, index) => (
        <button
          key={entry.tab}
          ref={(button) => {
            buttons.current[index] = button;
          }}
          type="button"
          role="tab"
          id={`${idBase}-tab-${entry.tab}`}
          aria-controls={`${idBase}-panel-${entry.tab}`}
          aria-selected={tab === entry.tab}
          tabIndex={tab === entry.tab ? 0 : -1}
          onClick={() => onChange(entry.tab)}
          onKeyDown={(event) => {
            const next =
              event.key === "ArrowRight"
                ? (index + 1) % TABS.length
                : event.key === "ArrowLeft"
                  ? (index - 1 + TABS.length) % TABS.length
                  : event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? TABS.length - 1
                      : null;
            if (next === null) return;
            event.preventDefault();
            selectAndFocus(next);
          }}
          className={`h-11 cursor-pointer px-4 text-sm ${
            tab === entry.tab
              ? "border-b-2 border-blue-600 font-medium text-blue-700"
              : "text-gray-500 hover:text-gray-700"
          }`}
        >
          {entry.label}
        </button>
      ))}
    </div>
  );
}

/** A failure worded for the reader, in the one place the panel shows them. */
function ChatErrorNotice({ message }: { message: string }) {
  return (
    <p role="alert" className="m-2 rounded-md bg-red-50 p-3 text-sm text-red-600">
      {message}
    </p>
  );
}

export function ChatArea({
  book,
  bookError,
  onSelectionClick,
  readQuote,
  deleteHighlight,
  searchHighlights,
  note,
  noteEditorRange,
  onNoteEditorRangeChange,
  pendingNoteSelection,
  noteSelectionSaveError,
  noteSelectionSaving,
  onQuickNoteSubmit,
  onQuickNoteRetry,
}: ChatAreaProps) {
  const [tab, setTab] = useAtom(rightPaneTabAtom);
  const tabIdBase = useId();
  const [activeSelection, setActiveSelection] = useAtom(activeSelectionAtom);
  const { highlights, removeHighlight } = useHighlights(book?.id, undefined, deleteHighlight);
  const { query, setQuery, submit, matchedIds, searchError } = useHighlightSearch(
    book?.id,
    searchHighlights,
  );
  const selectionDeleted = useSetAtom(selectionDeletedAtom);
  const messages = useAtomValue(chatMessagesAtom);
  const streamingContent = useAtomValue(streamingContentAtom);
  const isStreaming = useAtomValue(isStreamingAtom);
  const chatError = useAtomValue(chatErrorAtom);
  const useWebSearch = useAtomValue(useWebSearchAtom);
  const abortChatStream = useSetAtom(abortChatStreamAtom);

  const { sendMessage } = useChatStream();

  /** A passage of this thread the next question is about, if one was picked. */
  const [quote, setQuote] = useState<string | null>(null);

  // A quote is a passage of the conversation it was taken from, so opening
  // another one leaves it behind. Adjusted during the render that brings the
  // new thread in, so the input never shows the old quote under it.
  const [quotedFrom, setQuotedFrom] = useState(activeSelection?.id);
  if (activeSelection?.id !== quotedFrom) {
    setQuotedFrom(activeSelection?.id);
    setQuote(null);
  }

  const handleSend = async (content: string) => {
    if (!book || !activeSelection) return;
    // The quote rides inside the message: the thread is stored as content and
    // nothing beside it would survive a reload or reach the model.
    const question = quote === null ? content : formatQuotedQuestion(quote, content);
    setQuote(null);
    await sendMessage(book.id, activeSelection.id, question, useWebSearch);
  };

  if (bookError && !book) {
    // The highlights are read out of the book, so a book that did not load has
    // no list to show — and an empty list here reads as "nothing marked yet".
    // A book already in hand still wins: a failed re-read of it changes nothing
    // about the highlights on screen.
    return (
      <div className="flex h-full flex-col justify-center bg-white">
        <ChatErrorNotice message={`ハイライトを読み込めませんでした: ${bookError.message}`} />
      </div>
    );
  }

  if (!book) {
    return (
      <div className="flex items-center justify-center h-full bg-white">
        <p className="text-gray-400 text-sm">PDFを開いてテキストを選択してください</p>
      </div>
    );
  }

  const body = !activeSelection ? (
    <HighlightListPanel
      highlights={matchedIds ? highlights.filter((h) => matchedIds.has(h.id)) : highlights}
      total={highlights.length}
      query={query}
      onQueryChange={setQuery}
      onSearch={submit}
      searched={matchedIds !== null}
      searchError={searchError}
      onSelect={onSelectionClick}
      // Leaving the chat is the store's to decide once the server answers:
      // the reader can have opened one while the request was in flight.
      onDelete={(id) => removeHighlight(book.id, id).map(() => selectionDeleted(id))}
    />
  ) : (
    <div className="flex h-full flex-col bg-white">
      <div className="px-2 py-2 border-b border-gray-200 shrink-0">
        <button
          type="button"
          onClick={() => {
            abortChatStream();
            setActiveSelection(null);
          }}
          className="cursor-pointer rounded px-2 py-1 text-sm text-blue-600 hover:bg-gray-50"
        >
          <span aria-hidden="true">←</span> 一覧に戻る
        </button>
      </div>
      <ChatMessageList
        messages={messages}
        streamingContent={streamingContent}
        isStreaming={isStreaming}
        onQuote={setQuote}
        readQuote={readQuote}
      />
      {chatError !== null && <ChatErrorNotice message={chatError} />}
      <ChatInput
        onSend={handleSend}
        disabled={isStreaming}
        quotedText={quote ?? activeSelection.selectedText}
        onClearQuote={quote === null ? undefined : () => setQuote(null)}
      />
    </div>
  );

  return (
    <div className="flex h-full flex-col bg-white">
      <PaneTabs idBase={tabIdBase} tab={tab} onChange={setTab} />
      {/* Keep both panel shells in the accessibility tree's relationship graph.
          Only the selected panel owns content, so switching tabs preserves the
          previous unmount semantics while every tab's `aria-controls` still
          names an element that actually exists. */}
      {TABS.map((entry) => {
        const selected = tab === entry.tab;
        return (
          <div
            key={entry.tab}
            role="tabpanel"
            id={`${tabIdBase}-panel-${entry.tab}`}
            aria-labelledby={`${tabIdBase}-tab-${entry.tab}`}
            hidden={!selected}
            className="min-h-0 flex-1"
          >
            {selected && entry.tab === "note" ? (
              <NotePane
                session={note}
                editorRange={noteEditorRange}
                onEditorRangeChange={onNoteEditorRangeChange}
                selections={book.selections}
                onSelectionClick={onSelectionClick}
                pendingSelection={pendingNoteSelection}
                selectionSaveError={noteSelectionSaveError}
                selectionSaving={noteSelectionSaving}
                onQuickSubmit={onQuickNoteSubmit}
                onQuickRetry={onQuickNoteRetry}
              />
            ) : selected ? (
              body
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
