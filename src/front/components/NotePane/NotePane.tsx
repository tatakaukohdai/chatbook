// oxlint-disable-next-line no-restricted-imports -- controlled Markdown挿入後のtextarea selection rangeをDOMへ復元する
import { useEffect, useRef } from "react";
import { useAtom } from "jotai";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { MARKDOWN_COMPONENTS, PlainAnchor, type AnchorProps } from "../markdownComponents";
import { applyMarkdownCommand, type MarkdownCommand } from "../../lib/markdownCommands";
import { useIsNarrow } from "../../hooks/useIsNarrow";
import type { NoteSession, NoteStatus } from "../../hooks/useNoteSession";
import type { TextRange } from "../../lib/noteInsertion";
import type { SelectionDraft } from "../../hooks/useStoreSelection";
import type { SelectionHighlight } from "../../../shared/schemas/selection";
import type { ActiveSelection } from "../../atoms/chatAtom";
import { quickNoteInputAtom } from "../../atoms/noteAtom";
import { isSubmitKey } from "../../lib/isSubmitKey";

/**
 * Where the note stands with the server, said at all times.
 *
 * The reading position only speaks up when it fails; the note says where it
 * stands whether or not anything is wrong. An editor that cannot be asked
 * whether what was typed is safe is not one anybody trusts with anything they
 * would mind losing.
 */
const STATUS_WORDING: Record<NoteStatus, string> = {
  loading: "読み込み中...",
  saved: "保存済み",
  dirty: "未保存",
  saving: "保存中...",
  failed: "保存できませんでした",
  conflicted: "別の端末の変更と競合しています",
};

const STATUS_TONE: Record<NoteStatus, string> = {
  loading: "text-gray-400",
  saved: "text-gray-500",
  dirty: "text-gray-500",
  saving: "text-gray-500",
  failed: "text-red-600",
  conflicted: "text-amber-700",
};

/** The three marks a reader reaches for often enough that typing them is friction. */
const TOOLBAR: { command: MarkdownCommand; label: string }[] = [
  { command: "bold", label: "太字" },
  { command: "heading", label: "見出し" },
  { command: "bullet-list", label: "リスト" },
];

function Notice({ tone, children }: { tone: "red" | "amber"; children: React.ReactNode }) {
  const colours = tone === "red" ? "bg-red-50 text-red-600" : "bg-amber-50 text-amber-800";
  return (
    <p role="status" className={`shrink-0 px-3 py-2 text-xs ${colours}`}>
      {children}
    </p>
  );
}

function ErrorNotice({ children }: { children: React.ReactNode }) {
  return (
    <p role="alert" className="shrink-0 bg-red-50 px-3 py-2 text-xs text-red-600">
      {children}
    </p>
  );
}

export type PendingNoteSelection = Pick<SelectionDraft, "selectedText" | "pageNumber">;

export interface NotePaneProps {
  session: NoteSession;
  /** The last textarea range BookReader observed, including one returned by insertion. */
  editorRange?: TextRange;
  onEditorRangeChange?: (range: TextRange) => void;
  /** Current-book highlights are the authority for links rendered from the note. */
  selections?: SelectionHighlight[];
  onSelectionClick?: (selection: ActiveSelection) => void;
  /** A narrow selection waiting for its optional one-line comment. */
  pendingSelection?: PendingNoteSelection;
  selectionSaveError?: string | null;
  selectionSaving?: boolean;
  onQuickSubmit?: (text: string) => Promise<boolean>;
  onQuickRetry?: () => Promise<boolean>;
}

/** Resolve only the exact internal-link shape this note formatter writes. */
function internalSelection(
  href: string | undefined,
  selections: SelectionHighlight[],
): ActiveSelection | null {
  if (!href?.startsWith("?")) return null;

  const params = new URLSearchParams(href.slice(1));
  const entries = [...params.entries()];
  if (entries.length !== 2 || params.getAll("page").length !== 1) return null;
  if (params.getAll("selection").length !== 1) return null;
  if (entries.some(([key]) => key !== "page" && key !== "selection")) return null;

  const pageText = params.get("page");
  const selectionId = params.get("selection");
  const pageNumber = Number(pageText);
  if (!pageText || !selectionId || !Number.isSafeInteger(pageNumber) || pageNumber < 1) return null;
  if (String(pageNumber) !== pageText) return null;

  const selection = selections.find((candidate) => candidate.id === selectionId);
  if (!selection || selection.pageNumber !== pageNumber) return null;
  return {
    id: selection.id,
    selectedText: selection.selectedText,
    pageNumber: selection.pageNumber,
  };
}

function NoteAnchor({
  selections,
  onSelectionClick,
  node: _node,
  ...props
}: AnchorProps & {
  selections: SelectionHighlight[];
  onSelectionClick?: (selection: ActiveSelection) => void;
}) {
  if (!props.href?.startsWith("?")) return <PlainAnchor {...props} />;

  const selection = internalSelection(props.href, selections);

  return (
    <a
      {...props}
      className="text-blue-600 underline"
      onClick={(event) => {
        event.preventDefault();
        if (selection) onSelectionClick?.(selection);
      }}
    />
  );
}

/**
 * The reader's own note about the book, beside the chat rather than under it.
 *
 * A wide screen gets the Markdown source and a preview of it; a narrow one
 * gets the preview alone. Writing at length is not what happens on a phone —
 * what happens there is throwing a passage in on the way past — and a textarea
 * that cannot be written in comfortably is a road to a conflict nobody can
 * resolve on that screen either. **That choice is what keeps the conflict
 * handling out of the narrow layout**, so adding an editor there means
 * designing the conflict story for it too.
 */
export function NotePane({
  session,
  editorRange,
  onEditorRangeChange,
  selections = [],
  onSelectionClick,
  pendingSelection,
  selectionSaveError = null,
  selectionSaving = false,
  onQuickSubmit,
  onQuickRetry,
}: NotePaneProps) {
  const isNarrow = useIsNarrow();
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const [quickInput, setQuickInput] = useAtom(quickNoteInputAtom);
  const quickSubmitInFlight = useRef(false);

  useEffect(() => {
    if (isNarrow || !editorRange) return;
    const editor = editorRef.current;
    if (!editor) return;

    const start = Math.min(editorRange.start, editor.value.length);
    const end = Math.min(editorRange.end, editor.value.length);
    editor.focus();
    editor.setSelectionRange(start, end);
  }, [editorRange?.end, editorRange?.start, isNarrow, session.body]);

  const reportRange = (editor: HTMLTextAreaElement) => {
    onEditorRangeChange?.({ start: editor.selectionStart, end: editor.selectionEnd });
  };

  const runCommand = (command: MarkdownCommand) => {
    const editor = editorRef.current;
    if (!editor) return;

    const next = applyMarkdownCommand(
      editor.value,
      editor.selectionStart,
      editor.selectionEnd,
      command,
    );
    session.edit(next.text);
    onEditorRangeChange?.({ start: next.selStart, end: next.selEnd });
    // Put back after React has written the new text, so the reader carries on
    // from where the mark left them rather than from the end of the note.
    queueMicrotask(() => {
      editor.focus();
      editor.setSelectionRange(next.selStart, next.selEnd);
    });
  };

  const submitQuick = async () => {
    if (!onQuickSubmit || quickSubmitInFlight.current) return;
    if (!pendingSelection && quickInput.trim() === "") return;

    quickSubmitInFlight.current = true;
    try {
      if (await onQuickSubmit(quickInput)) setQuickInput("");
    } finally {
      quickSubmitInFlight.current = false;
    }
  };

  const retryQuick = async () => {
    if (!onQuickRetry || quickSubmitInFlight.current) return;
    quickSubmitInFlight.current = true;
    try {
      if (await onQuickRetry()) setQuickInput("");
    } finally {
      quickSubmitInFlight.current = false;
    }
  };

  const quickLocked =
    session.status === "loading" ||
    selectionSaving ||
    session.quickAppending ||
    session.quickAppendError !== null;

  return (
    <div className="flex h-full flex-col bg-white">
      {session.loadError !== null && (
        <Notice tone="red">メモを読み込めませんでした: {session.loadError}</Notice>
      )}

      {/* Offered rather than applied: the server's note is what every other
          device agrees on, and quietly putting this device's leftovers over it
          would be this device deciding for all of them. */}
      {session.draftOffer !== null && (
        <div role="status" className="shrink-0 bg-blue-50 px-3 py-2 text-xs text-blue-800">
          <p className="mb-2">この端末に、サーバへ届いていない下書きがあります。</p>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={session.recoverDraft}
              className="cursor-pointer rounded border border-blue-300 bg-white px-2 py-1 hover:bg-blue-100"
            >
              下書きを復元
            </button>
            <button
              type="button"
              onClick={session.discardDraft}
              className="cursor-pointer rounded border border-blue-200 px-2 py-1 hover:bg-blue-100"
            >
              破棄
            </button>
          </div>
        </div>
      )}

      <div className="flex shrink-0 items-center gap-2 border-b border-gray-200 px-2 py-1.5">
        {!isNarrow &&
          TOOLBAR.map(({ command, label }) => (
            <button
              key={command}
              type="button"
              onClick={() => runCommand(command)}
              disabled={session.status === "loading"}
              className="cursor-pointer rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50 disabled:cursor-default disabled:opacity-50"
            >
              {label}
            </button>
          ))}
        <span role="status" className={`ml-auto text-xs ${STATUS_TONE[session.status]}`}>
          {STATUS_WORDING[session.status]}
        </span>
        {/* Only where automatic saving has stopped or come up short — offered
            at all times it would read as saving being something the reader has
            to remember to do. */}
        {!isNarrow && session.quickAppendError !== null ? (
          <button
            type="button"
            onClick={() => void retryQuick()}
            disabled={selectionSaving || session.quickAppending || !onQuickRetry}
            className="h-11 cursor-pointer rounded border border-blue-300 px-3 text-xs text-blue-700 hover:bg-blue-50 disabled:cursor-default disabled:opacity-50"
          >
            クイックメモを再試行
          </button>
        ) : (session.status === "failed" || session.status === "conflicted") &&
          session.quickAppendError === null ? (
          <button
            type="button"
            onClick={session.save}
            className="cursor-pointer rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
          >
            保存
          </button>
        ) : null}
      </div>

      {session.saveError !== null && <Notice tone="amber">{session.saveError}</Notice>}
      {session.draftError !== null && <Notice tone="amber">{session.draftError}</Notice>}
      {selectionSaveError !== null ? (
        <ErrorNotice>ハイライトを保存できませんでした: {selectionSaveError}</ErrorNotice>
      ) : null}
      {session.quickAppendError !== null ? (
        <ErrorNotice>クイックメモを保存できませんでした: {session.quickAppendError}</ErrorNotice>
      ) : null}

      {isNarrow ? (
        <>
          {pendingSelection ? (
            <blockquote className="mx-3 mt-3 shrink-0 border-l-2 border-blue-300 pl-3 text-sm text-gray-600">
              <p>{pendingSelection.selectedText}</p>
              <p className="mt-1 text-xs text-gray-400">p.{pendingSelection.pageNumber}</p>
            </blockquote>
          ) : null}
          <NotePreview
            body={session.body}
            className="min-h-0 flex-1"
            selections={selections}
            onSelectionClick={onSelectionClick}
          />
          <div className="flex shrink-0 gap-2 border-t border-gray-200 p-2">
            <input
              type="text"
              aria-label="クイックメモ"
              value={quickInput}
              onChange={(event) => setQuickInput(event.target.value)}
              onKeyDown={(event) => {
                if (!isSubmitKey(event.nativeEvent as unknown as KeyboardEvent)) return;
                event.preventDefault();
                void submitQuick();
              }}
              readOnly={quickLocked}
              placeholder={pendingSelection ? "選択箇所へのメモ（任意）" : "一言メモ"}
              className="h-11 min-w-0 flex-1 rounded border border-gray-300 px-3 text-sm outline-none read-only:bg-gray-50"
            />
            {session.quickAppendError !== null ? (
              <button
                type="button"
                onClick={() => void retryQuick()}
                disabled={selectionSaving || session.quickAppending || !onQuickRetry}
                className="h-11 rounded bg-blue-600 px-3 text-sm text-white disabled:opacity-50"
              >
                再試行
              </button>
            ) : (
              <button
                type="button"
                onClick={() => void submitQuick()}
                disabled={
                  quickLocked || !onQuickSubmit || (!pendingSelection && quickInput.trim() === "")
                }
                className="h-11 rounded bg-blue-600 px-3 text-sm text-white disabled:opacity-50"
              >
                {selectionSaving || session.quickAppending ? "追加中..." : "メモを追加"}
              </button>
            )}
          </div>
        </>
      ) : (
        <>
          <textarea
            ref={editorRef}
            aria-label="読書メモ"
            value={session.body}
            onChange={(e) => {
              session.edit(e.target.value);
              reportRange(e.target);
            }}
            onSelect={(e) => reportRange(e.currentTarget)}
            disabled={session.status === "loading"}
            placeholder="気づいたことを書き留める"
            className="min-h-0 flex-1 resize-none border-b border-gray-200 p-3 font-mono text-sm text-gray-800 outline-none placeholder:text-gray-400"
          />
          {/* Under the source rather than beside it: this pane is as wide as
              the chat it shares a tab bar with, and two columns in it would
              leave neither readable. */}
          <NotePreview
            body={session.body}
            className="min-h-0 flex-1"
            selections={selections}
            onSelectionClick={onSelectionClick}
          />
        </>
      )}
    </div>
  );
}

function NotePreview({
  body,
  className,
  selections = [],
  onSelectionClick,
}: {
  body: string;
  className: string;
  selections?: SelectionHighlight[];
  onSelectionClick?: (selection: ActiveSelection) => void;
}) {
  return (
    <div className={`overflow-y-auto p-3 text-sm text-gray-800 ${className}`}>
      {body.trim() === "" ? (
        <p className="text-sm text-gray-400">まだ何も書かれていません</p>
      ) : (
        <Markdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
          components={{
            ...MARKDOWN_COMPONENTS,
            a: (props) => (
              <NoteAnchor {...props} selections={selections} onSelectionClick={onSelectionClick} />
            ),
          }}
        >
          {body}
        </Markdown>
      )}
    </div>
  );
}
