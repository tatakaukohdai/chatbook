import { ResultAsync } from "neverthrow";
import {
  noteConflictSchema,
  noteSavedSchema,
  noteSnapshotSchema,
  type NoteSaved,
  type NoteSnapshot,
  type SaveNoteRequest,
} from "../../shared/schemas/note";
import { ApiError, CLIENT_ERROR_CODES, fetcher, networkFailure, readRefusal } from "./fetcher";

const noteUrl = (pdfId: string) => `/api/pdf/${pdfId}/note`;

/** Reads the book's note. A read, so its failure travels as a throw for SWR. */
export type LoadNote = (pdfId: string) => Promise<NoteSnapshot>;

/**
 * `fetchFn` is the seam every other request in this app has, and the reason
 * these two are written out rather than typed as `LoadNote` / `SaveNote`: an
 * extra optional parameter is assignable to those, but not the other way
 * round, so the type would take the seam away from the tests.
 */
export function fetchNote(pdfId: string, fetchFn: typeof fetch = fetch): Promise<NoteSnapshot> {
  return fetcher(noteUrl(pdfId), noteSnapshotSchema, undefined, fetchFn);
}

/**
 * Why a save did not land.
 *
 * A conflict is kept apart from every other failure because it is the only one
 * with something in it the caller can act on: the note it lost to. Everything
 * else is the usual `ApiError`, which the pane words for the reader.
 */
export type SaveNoteFailure =
  | { type: "CONFLICT"; current: NoteSnapshot }
  | { type: "API"; cause: ApiError };

export type SaveNote = (
  pdfId: string,
  input: SaveNoteRequest,
) => ResultAsync<NoteSaved, SaveNoteFailure>;

const apiFailure = (cause: ApiError): SaveNoteFailure => ({ type: "API", cause });

/**
 * Save the note, and keep what a conflict came back with.
 *
 * The one write in this app that does not go through `resultFetcher`. That
 * one reads `{ error: { code, message } }` out of a refusal and drops the
 * rest, which here is exactly the part that matters — without the server's own
 * text there is nothing to rebase onto and nothing to merge against, and the
 * reader would be told their note clashed with something they cannot see.
 */
export function requestNoteSave(
  pdfId: string,
  input: SaveNoteRequest,
  fetchFn: typeof fetch = fetch,
): ResultAsync<NoteSaved, SaveNoteFailure> {
  const url = noteUrl(pdfId);

  return ResultAsync.fromPromise(
    (async (): Promise<NoteSaved> => {
      const response = await fetchFn(url, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });

      if (response.status === 409) {
        // Cloned so the body is still there for `readRefusal` below: a 409 that
        // does not carry the note is nothing this can resolve, and is passed on
        // in the same words as any other refusal rather than in invented ones.
        const conflict = noteConflictSchema.safeParse(
          await response
            .clone()
            .json()
            .catch(() => null),
        );
        if (conflict.success) throw new NoteConflictSignal(conflict.data.current);
        throw await readRefusal(url, response);
      }

      if (!response.ok) throw await readRefusal(url, response);

      const parsed = noteSavedSchema.safeParse(await response.json().catch(() => null));
      if (!parsed.success) {
        throw new ApiError(
          `unexpected response from ${url}`,
          CLIENT_ERROR_CODES.invalidResponse,
          response.status,
          "parse",
        );
      }
      return parsed.data;
    })(),
    (cause): SaveNoteFailure => {
      if (cause instanceof NoteConflictSignal) return { type: "CONFLICT", current: cause.current };
      return apiFailure(cause instanceof ApiError ? cause : networkFailure(url, cause));
    },
  );
}

/**
 * The conflict, on its way out of the async body above.
 *
 * A throw rather than a return because everything else in there leaves the
 * same way, and one exit for both keeps the `ResultAsync` reading as the two
 * outcomes it has rather than three.
 */
class NoteConflictSignal extends Error {
  readonly current: NoteSnapshot;

  constructor(current: NoteSnapshot) {
    super("Note changed since it was read");
    this.name = "NoteConflictSignal";
    this.current = current;
  }
}
