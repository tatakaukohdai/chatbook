/**
 * What the note's toolbar can do to the text under the caret.
 *
 * Kept to three: the marks a reader reaches for often enough that typing them
 * is friction, and no more. Anything rarer is quicker to type than to find.
 */
export type MarkdownCommand = "bold" | "heading" | "bullet-list";

/** A textarea's contents and what is picked in it, before and after a command. */
export interface TextSelection {
  text: string;
  selStart: number;
  selEnd: number;
}

const BOLD = "**";
const HEADING = "## ";
const BULLET = "- ";

/**
 * Apply a toolbar command, and say where the caret goes afterwards.
 *
 * Pure, and knowing nothing of the DOM: what a textarea holds is a string and
 * two offsets, so the whole of what these buttons do can be tested without one
 * — and the component is left with nothing to get wrong but reading the
 * offsets out and writing them back.
 */
export function applyMarkdownCommand(
  text: string,
  selStart: number,
  selEnd: number,
  command: MarkdownCommand,
): TextSelection {
  if (command === "bold") return applyBold(text, selStart, selEnd);
  return applyLinePrefix(text, selStart, selEnd, command === "heading" ? HEADING : BULLET);
}

function applyBold(text: string, selStart: number, selEnd: number): TextSelection {
  const picked = text.slice(selStart, selEnd);
  const wrapped =
    text.slice(selStart - BOLD.length, selStart) === BOLD &&
    text.slice(selEnd, selEnd + BOLD.length) === BOLD;

  if (wrapped) {
    return {
      text: text.slice(0, selStart - BOLD.length) + picked + text.slice(selEnd + BOLD.length),
      selStart: selStart - BOLD.length,
      selEnd: selEnd - BOLD.length,
    };
  }

  return {
    text: `${text.slice(0, selStart)}${BOLD}${picked}${BOLD}${text.slice(selEnd)}`,
    // With nothing picked the two offsets meet in the middle, so the reader
    // types into the marks rather than having to walk back over them.
    selStart: selStart + BOLD.length,
    selEnd: selEnd + BOLD.length,
  };
}

/**
 * Where the lines the selection touches begin and end.
 *
 * A command that marks lines acts on whole ones: a caret in the middle of a
 * line means that line, and a selection means every line it runs through, even
 * the ones it only clips.
 */
function lineRange(text: string, selStart: number, selEnd: number): { from: number; to: number } {
  const from = text.lastIndexOf("\n", selStart - 1) + 1;
  const lineEnd = text.indexOf("\n", selEnd);
  return { from, to: lineEnd === -1 ? text.length : lineEnd };
}

function applyLinePrefix(
  text: string,
  selStart: number,
  selEnd: number,
  prefix: string,
): TextSelection {
  const { from, to } = lineRange(text, selStart, selEnd);
  const lines = text.slice(from, to).split("\n");

  // Only when every line already carries it — a run where some do and some do
  // not is one the reader is asking to make uniform, and taking the marks off
  // would leave them with neither the list nor the lines they started from.
  const marked = lines.every((line) => line.startsWith(prefix));
  const rewritten = lines.map((line) => (marked ? line.slice(prefix.length) : `${prefix}${line}`));

  const block = rewritten.join("\n");
  const rewrittenText = text.slice(0, from) + block + text.slice(to);

  // A caret stays a caret, carried along by what was put in front of its line,
  // so the reader keeps typing where they were rather than having the line
  // they are in the middle of picked out from under them. Never further back
  // than the start of that line, which is where a caret sitting inside a mark
  // that was just removed ends up.
  if (selStart === selEnd) {
    const moved = marked ? selStart - prefix.length : selStart + prefix.length;
    const caret = Math.max(from, moved);
    return { text: rewrittenText, selStart: caret, selEnd: caret };
  }

  return { text: rewrittenText, selStart: from, selEnd: from + block.length };
}
