import { z } from "zod";
import { errorPayloadSchema } from "./error";

/**
 * How long a note may get. Generous — a book's worth of notes is a few
 * thousand words — but bounded, because the whole body travels on every save
 * and D1 has to hold it in one row.
 */
export const MAX_NOTE_BODY_LENGTH = 500_000;

/**
 * The note as the server holds it: the text, and which save produced it.
 *
 * A book with no note yet answers with `{ body: "", version: 0 }` rather than
 * with nothing — an empty note and a book that has none read the same to the
 * reader, and version 0 is what the first save is written against.
 */
export const noteSnapshotSchema = z.object({
  body: z.string(),
  version: z.number().int().nonnegative(),
});

export type NoteSnapshot = z.infer<typeof noteSnapshotSchema>;

/**
 * What a device sends to save: the text, and the version it was written
 * against. The server refuses it if it has moved past that version.
 */
export const saveNoteRequestSchema = z.object({
  body: z.string().max(MAX_NOTE_BODY_LENGTH),
  version: z.number().int().nonnegative(),
});

export type SaveNoteRequest = z.infer<typeof saveNoteRequestSchema>;

/** What a save that landed answers with: the version it produced. */
export const noteSavedSchema = z.object({
  version: z.number().int().positive(),
});

export type NoteSaved = z.infer<typeof noteSavedSchema>;

/**
 * The 409 body, which carries the note it lost to.
 *
 * The only refusal in this API that says more than why it refused. Without
 * `current` the client would have to ask for the note again to find out what
 * it is now, and by then it could have moved again — and neither a rebase nor
 * a three-way merge can be attempted at all until the other side's text is in
 * hand. `resultFetcher` reads `error` alone out of a refusal, so the note has
 * a save of its own that reads this shape.
 */
export const noteConflictSchema = z.object({
  error: errorPayloadSchema,
  current: noteSnapshotSchema,
});

export type NoteConflict = z.infer<typeof noteConflictSchema>;
