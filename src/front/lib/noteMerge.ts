import { merge } from "node-diff3";

/**
 * What the markers call the two sides.
 *
 * The reader's own words rather than git's: the thing they are choosing
 * between is what they wrote and what the server holds, and neither of them is
 * a branch.
 */
const MINE_LABEL = "自分";
const SERVER_LABEL = "サーバ";

/** A note as it came out of a merge, and whether the reader has to finish it. */
export interface NoteMergeResult {
  body: string;
  /** True when markers were left in the body for the reader to resolve. */
  conflicted: boolean;
}

/**
 * A note as lines, and back.
 *
 * The merge is line by line — handed a string, `node-diff3` splits on
 * whitespace and merges word by word, which turns an untouched paragraph into
 * a re-flowed one. Splitting on "\n" alone is an exact inverse of joining on
 * it: a trailing newline shows up as a final empty line and is put back as
 * one, so a note that merges cleanly comes out byte for byte as it went in.
 */
export function toLines(body: string): string[] {
  return body.split("\n");
}

export function fromLines(lines: string[]): string {
  return lines.join("\n");
}

/**
 * The marker a merge writes at the start of a line, and nothing else.
 *
 * Anchored per line so a note that quotes one — a reader writing about merges
 * is not far-fetched in a book about distributed systems — is not mistaken for
 * one that is still being resolved.
 */
const CONFLICT_MARKER = /^(?:<{7}|={7}|>{7})(?: |$)/m;

/** Whether a merge's markers are still in the note, unresolved. */
export function hasConflictMarkers(body: string): boolean {
  return CONFLICT_MARKER.test(body);
}

/**
 * Fold this device's note and the server's together over the note both started
 * from.
 *
 * The session keeps the text it loaded, which is what makes this possible at
 * all: with the common ancestor in hand, edits that never touched each other
 * fold together silently, and only the lines both sides rewrote come back for
 * the reader to settle. Those come back as markers in the Markdown itself —
 * the note is already source in a textarea, so it is its own merge screen and
 * needs no second one.
 */
export function mergeNoteBodies(mine: string, base: string, theirs: string): NoteMergeResult {
  const merged = merge(toLines(mine), toLines(base), toLines(theirs), {
    // Both devices making the same correction is agreement, not a clash; asked
    // to resolve it the reader would be choosing between a line and itself.
    excludeFalseConflicts: true,
    label: { a: MINE_LABEL, b: SERVER_LABEL },
  });

  return { body: fromLines(merged.result), conflicted: merged.conflict };
}
