import { useRef } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { MARKDOWN_COMPONENTS } from "../markdownComponents";
import { applyMarkdownCommand, type MarkdownCommand } from "../../lib/markdownCommands";
import { useIsNarrow } from "../../hooks/useIsNarrow";
import type { NoteSession, NoteStatus } from "../../hooks/useNoteSession";

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
export function NotePane({ session }: { session: NoteSession }) {
  const isNarrow = useIsNarrow();
  const editorRef = useRef<HTMLTextAreaElement>(null);

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
    // Put back after React has written the new text, so the reader carries on
    // from where the mark left them rather than from the end of the note.
    queueMicrotask(() => {
      editor.focus();
      editor.setSelectionRange(next.selStart, next.selEnd);
    });
  };

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
        {(session.status === "failed" || session.status === "conflicted") && (
          <button
            type="button"
            onClick={session.save}
            className="cursor-pointer rounded border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
          >
            保存
          </button>
        )}
      </div>

      {session.saveError !== null && <Notice tone="amber">{session.saveError}</Notice>}
      {session.draftError !== null && <Notice tone="amber">{session.draftError}</Notice>}

      {isNarrow ? (
        <NotePreview body={session.body} className="flex-1" />
      ) : (
        <>
          <textarea
            ref={editorRef}
            aria-label="読書メモ"
            value={session.body}
            onChange={(e) => session.edit(e.target.value)}
            disabled={session.status === "loading"}
            placeholder="気づいたことを書き留める"
            className="min-h-0 flex-1 resize-none border-b border-gray-200 p-3 font-mono text-sm text-gray-800 outline-none placeholder:text-gray-400"
          />
          {/* Under the source rather than beside it: this pane is as wide as
              the chat it shares a tab bar with, and two columns in it would
              leave neither readable. */}
          <NotePreview body={session.body} className="min-h-0 flex-1" />
        </>
      )}
    </div>
  );
}

function NotePreview({ body, className }: { body: string; className: string }) {
  return (
    <div className={`overflow-y-auto p-3 text-sm text-gray-800 ${className}`}>
      {body.trim() === "" ? (
        <p className="text-sm text-gray-400">まだ何も書かれていません</p>
      ) : (
        <Markdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
          components={MARKDOWN_COMPONENTS}
        >
          {body}
        </Markdown>
      )}
    </div>
  );
}
