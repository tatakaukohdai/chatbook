import type { CreatedSelection } from "../../shared/schemas/selection";

export type TextRange = { start: number; end: number };

export type NoteInsertion = { body: string; range: TextRange };

type SelectionForNote = Pick<CreatedSelection, "id" | "selectedText" | "pageNumber">;

type Heading = { start: number; end: number; title: string };

const MEMO_HEADING = "メモ";
const AI_HEADING = "AI とのやりとり";

/** Turn a saved selection into the Markdown block the reader inserts into a note. */
export function formatSelectionNote(selection: SelectionForNote, comment?: string): string {
  const quote = selection.selectedText
    .split(/\r?\n/)
    .map((line) => `> ${line}`)
    .join("\n");
  const link = `<sup>[p.${selection.pageNumber}](?page=${selection.pageNumber}&selection=${encodeURIComponent(selection.id)})</sup>`;
  const parts = [quote];

  if (comment?.trim()) parts.push(comment);
  parts.push(link);

  return parts.join("\n\n");
}

/**
 * Insert Markdown where a textarea caret or selection says, without touching
 * the DOM. A missing range is the editor's "no focus" case, so it appends.
 */
export function insertNoteMarkdown(
  body: string,
  markdown: string,
  range?: TextRange,
): NoteInsertion {
  const eol = lineEndingFor(body);
  const insertion = normalizeLineEndings(markdown, eol);

  if (!range) {
    const before = stripTrailingLineBreaks(body);
    const prefix = before && insertion ? `${before}${eol}${eol}` : before;
    const nextBody = `${prefix}${insertion}`;
    const caret = nextBody.length;
    return { body: nextBody, range: { start: caret, end: caret } };
  }

  const first = clamp(range.start, 0, body.length);
  const second = clamp(range.end, 0, body.length);
  const start = Math.min(first, second);
  const end = Math.max(first, second);
  const nextBody = `${body.slice(0, start)}${insertion}${body.slice(end)}`;
  const caret = start + insertion.length;

  return { body: nextBody, range: { start: caret, end: caret } };
}

/**
 * Add a quick entry to the only memo section that is meaningful at the end of
 * the document. Older headings deliberately do not count: moving one must not
 * redirect a later quick note into a historical part of the reader's text.
 */
export function appendQuickNote(body: string, entry: string): string {
  const eol = lineEndingFor(body);
  const headings = headingsOutsideCodeFences(body, eol);
  const target = memoTargetAtDocumentEnd(headings);
  const listItem = asListItem(entry, eol);

  if (!target) {
    const before = stripTrailingLineBreaks(body);
    const prefix = before ? `${before}${eol}${eol}` : "";
    return `${prefix}## ${MEMO_HEADING}${eol}${eol}${listItem}`;
  }

  const targetIndex = headings.indexOf(target);
  const nextHeading = headings[targetIndex + 1];
  const sectionEnd = nextHeading?.start ?? body.length;
  const section = body.slice(target.end, sectionEnd);
  const trailingLineBreaks = section.match(/(?:\r\n|\n)+$/)?.[0] ?? "";
  const sectionContent = section.slice(0, section.length - trailingLineBreaks.length);
  const hasEntry = sectionContent.trim().length > 0;
  const before = body.slice(0, target.end);
  const after = body.slice(sectionEnd);
  const beforeEntry = hasEntry ? `${sectionContent}${eol}` : `${eol}${eol}`;
  // A reader's extra blank lines at the section end are intentional Markdown
  // spacing, so leave their count unchanged after moving the new item before it.
  const afterEntry = trailingLineBreaks || (after ? `${eol}${eol}` : "");

  return `${before}${beforeEntry}${listItem}${afterEntry}${after}`;
}

function lineEndingFor(body: string): "\n" | "\r\n" {
  return body.includes("\r\n") ? "\r\n" : "\n";
}

function normalizeLineEndings(text: string, eol: "\n" | "\r\n"): string {
  return text.replace(/\r?\n/g, eol);
}

function stripTrailingLineBreaks(text: string): string {
  return text.replace(/(?:\r\n|\n)+$/, "");
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function asListItem(entry: string, eol: "\n" | "\r\n"): string {
  const normalized = stripTrailingLineBreaks(normalizeLineEndings(entry, eol));
  const lines = normalized.split(eol);

  return lines
    .map((line, index) => (index === 0 ? `- ${line}` : line ? `  ${line}` : ""))
    .join(eol);
}

/** Collect only level-two headings that Markdown treats as outside fenced code. */
function headingsOutsideCodeFences(body: string, eol: "\n" | "\r\n"): Heading[] {
  const headings: Heading[] = [];
  const lines = body.split(eol);
  let offset = 0;
  let fence: { marker: "`" | "~"; length: number } | null = null;

  for (const line of lines) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);

    if (marker) {
      const mark = marker[1];
      if (!fence) {
        fence = { marker: mark[0] as "`" | "~", length: mark.length };
      } else if (
        mark[0] === fence.marker &&
        mark.length >= fence.length &&
        /^[`~\s]*$/.test(line.slice(marker[0].length))
      ) {
        fence = null;
      }
    } else if (!fence) {
      const title = headingTitle(line);
      if (title !== null) headings.push({ start: offset, end: offset + line.length, title });
    }

    offset += line.length + eol.length;
  }

  return headings;
}

function headingTitle(line: string): string | null {
  const match = line.match(/^ {0,3}##(?!#)[ \t]+(.+?)\s*$/);
  if (!match) return null;

  return match[1].replace(/[ \t]+#+$/, "").trimEnd();
}

function memoTargetAtDocumentEnd(headings: Heading[]): Heading | null {
  const last = headings.at(-1);
  if (!last) return null;
  if (last.title === MEMO_HEADING) return last;

  const previous = headings.at(-2);
  return last.title === AI_HEADING && previous?.title === MEMO_HEADING ? previous : null;
}
