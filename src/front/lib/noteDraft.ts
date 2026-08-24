import { z } from "zod";

/**
 * A note as this device last had it, kept where a reload can find it.
 *
 * The text is not enough on its own: to know whether a draft is ahead of the
 * server or behind it, this device would have to compare clocks with whatever
 * device wrote the server's copy, and two devices do not agree on the time. So
 * the draft carries the note it was written against, and the question becomes
 * one about text rather than about when — the same question the merge already
 * answers.
 */
const noteDraftSchema = z.object({
  body: z.string(),
  baseBody: z.string(),
  baseVersion: z.number().int().nonnegative(),
});

export type NoteDraft = z.infer<typeof noteDraftSchema>;

/** Where a book's draft lives. One per book, like the note itself. */
export const noteDraftKey = (pdfId: string) => `chatbook:note-draft:${pdfId}`;

/** Whether the draft was kept, and what to tell the reader when it was not. */
export type DraftWrite = { kept: true } | { kept: false; reason: string };

const OUT_OF_ROOM = "この端末に下書きを保存できませんでした（保存領域の空きが足りません）";
const UNAVAILABLE = "この端末に下書きを保存できませんでした";

/**
 * The store, or nothing where there is none.
 *
 * A private window, a browser told to refuse site data, and a preview that
 * renders the page outside a document all reach this — and in some of them
 * naming `localStorage` at all is what throws, so the reference itself is
 * taken inside the try.
 */
function defaultStorage(): Storage | null {
  try {
    return localStorage;
  } catch {
    return null;
  }
}

/** The draft kept for this book, or nothing when there is none to be had. */
export function readDraft(
  pdfId: string,
  storage: Storage | null = defaultStorage(),
): NoteDraft | null {
  if (!storage) return null;

  try {
    const stored = storage.getItem(noteDraftKey(pdfId));
    if (stored === null) return null;
    const parsed = noteDraftSchema.safeParse(JSON.parse(stored));
    // Anything else at that key is treated as no draft at all: this is the
    // backup, and taking the note pane down over a backup would cost the
    // reader the thing it was protecting.
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Mirror the note here, so a tab closed before a save still has it.
 *
 * The failure comes back rather than being swallowed: a reader who believes
 * there is a copy writes differently from one who knows there is not.
 */
export function writeDraft(
  pdfId: string,
  draft: NoteDraft,
  storage: Storage | null = defaultStorage(),
): DraftWrite {
  if (!storage) return { kept: false, reason: UNAVAILABLE };

  try {
    storage.setItem(noteDraftKey(pdfId), JSON.stringify(draft));
    return { kept: true };
  } catch (cause) {
    const outOfRoom = cause instanceof DOMException && cause.name === "QuotaExceededError";
    return { kept: false, reason: outOfRoom ? OUT_OF_ROOM : UNAVAILABLE };
  }
}

/**
 * Drop the draft.
 *
 * Only once the text on screen is known to be the text on the server — a draft
 * dropped on the strength of a save that has since been added to is a draft
 * dropped while there is still something in it worth keeping.
 */
export function clearDraft(pdfId: string, storage: Storage | null = defaultStorage()): void {
  if (!storage) return;

  try {
    storage.removeItem(noteDraftKey(pdfId));
  } catch {
    // Nothing to tell the reader: whatever is left behind is only ever read
    // against the note it was written for, and is dropped on the next save.
  }
}
