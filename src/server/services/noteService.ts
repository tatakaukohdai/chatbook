import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { ResultAsync, err, ok } from "neverthrow";
import { notes, pdfs } from "../db/schema";
import type { NoteSnapshot, SaveNoteRequest } from "../../shared/schemas/note";
import { notFound, storageFailure, type ServiceError } from "./serviceError";
import type { IdClock } from "./pdfService";

/**
 * How a save came out.
 *
 * A conflict is not a failure of the service: nothing went wrong, the note
 * simply moved on while this device was writing. It travels as a success value
 * so that `ServiceError` keeps meaning "the answer could not be produced" —
 * adding a third case there would put a routine outcome next to a missing book
 * and a store that refused, and every existing `.match` would have to decide
 * what to do about it.
 */
export type NoteSaveOutcome =
  | { type: "SAVED"; version: number }
  | { type: "CONFLICT"; current: NoteSnapshot };

/** A book that has never been written about, which is not a book with no note. */
const UNWRITTEN: NoteSnapshot = { body: "", version: 0 };

/**
 * The book's note, or an empty one at version 0 when nobody has written in it.
 *
 * A missing book is still a missing book: "there is no note yet" and "there is
 * no such book" are different answers, and only the second is the reader's
 * link being wrong.
 */
export function getNote(db: D1Database, pdfId: string): ResultAsync<NoteSnapshot, ServiceError> {
  return ResultAsync.fromPromise(readNote(db, pdfId), storageFailure).andThen((note) =>
    note ? ok(note) : err(notFound()),
  );
}

async function readNote(db: D1Database, pdfId: string): Promise<NoteSnapshot | null> {
  // Left join rather than two reads: the book has to be looked for either way,
  // and the note is the same row's worth of work.
  const row = await drizzle(db)
    .select({ body: notes.body, version: notes.version })
    .from(pdfs)
    .leftJoin(notes, eq(notes.pdfId, pdfs.id))
    .where(eq(pdfs.id, pdfId))
    .get();

  if (!row) return null;
  return row.body === null || row.version === null
    ? UNWRITTEN
    : { body: row.body, version: row.version };
}

/**
 * Save the note, unless it has moved since the sender read it.
 *
 * One statement does both the first save and every one after it. Splitting it
 * into "update, and insert if that touched nothing" reads the same until two
 * devices both read the empty note and both save against version 0: the second
 * insert would then break the unique `pdf_id` and come back as a server error,
 * where what happened is an ordinary conflict the reader can resolve.
 */
export function saveNote(
  db: D1Database,
  pdfId: string,
  input: SaveNoteRequest,
  idClock: IdClock,
): ResultAsync<NoteSaveOutcome, ServiceError> {
  return ResultAsync.fromPromise(writeNote(db, pdfId, input, idClock), storageFailure).andThen(
    (outcome) => (outcome ? ok(outcome) : err(notFound())),
  );
}

async function writeNote(
  db: D1Database,
  pdfId: string,
  input: SaveNoteRequest,
  idClock: IdClock,
): Promise<NoteSaveOutcome | null> {
  const d1Db = drizzle(db);
  // Asked before the write rather than left to the foreign key: a rejected key
  // arrives as an exception, and a link to a book that was deleted would reach
  // the reader as a server error instead of the 404 every other endpoint gives.
  const book = await d1Db.select({ id: pdfs.id }).from(pdfs).where(eq(pdfs.id, pdfId)).get();
  if (!book) return null;

  const now = idClock.now();
  const saved = await db
    .prepare(
      `INSERT INTO notes (id, pdf_id, body, version, created_at, updated_at)
       VALUES (?1, ?2, ?3, 1, ?4, ?4)
       ON CONFLICT(pdf_id) DO UPDATE SET
         body = excluded.body,
         version = notes.version + 1,
         updated_at = excluded.updated_at
       WHERE notes.version = ?5
       RETURNING version`,
    )
    .bind(idClock.newId(), pdfId, input.body, now, input.version)
    .first<{ version: number }>();

  // The insert lands only when there is no row, and the update only when the
  // version still matches — so nothing coming back means the note moved on.
  if (saved) return { type: "SAVED", version: saved.version };

  const current = await readNote(db, pdfId);
  // Read after the refusal rather than before it, so what the reader is shown
  // is where the server stands now — which is what they have to merge onto,
  // whether or not it is the version that beat them to it.
  return { type: "CONFLICT", current: current ?? UNWRITTEN };
}
