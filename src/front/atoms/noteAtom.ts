import { atom } from "jotai";

/** Which of the two things the right-hand pane can hold is on top. */
export type RightPaneTab = "chat" | "note";

/**
 * The tab the right pane is showing.
 *
 * A tab rather than a third pane or a drawer: both of those take their room
 * out of the page, and the page is what the reader came for. The chat and the
 * note are the same kind of thing — something written beside the book — so
 * they share the room already given to that.
 *
 * In the reader's per-book store, so opening another book comes back to the
 * chat: which of the two was last looked at is about the reading being done,
 * not a setting.
 */
export const rightPaneTabAtom = atom<RightPaneTab>("chat");

/**
 * The one-line note being prepared on a narrow screen.
 *
 * Kept in the reader's per-book store rather than `NotePane`: changing tabs or
 * closing the sheet unmounts that pane, but neither means the reader discarded
 * what they typed. Only the pane subscribes, so one character does not render
 * the whole `BookReader` and its PDF again.
 */
export const quickNoteInputAtom = atom("");
