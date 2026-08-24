// oxlint-disable-next-line no-restricted-imports -- 保存という React の外の状態への同期（デバウンスしたタイマーで書き出す）
import { useCallback, useEffect, useRef, useState } from "react";
import useSWRImmutable from "swr/immutable";
import { useIsNarrow } from "./useIsNarrow";
import {
  fetchNote,
  requestNoteSave,
  type LoadNote,
  type SaveNote,
  type SaveNoteFailure,
} from "../lib/noteApi";
import { clearDraft, readDraft, writeDraft } from "../lib/noteDraft";
import { hasConflictMarkers, mergeNoteBodies } from "../lib/noteMerge";

/**
 * How long an edit waits before it is saved.
 *
 * The same wait the reading position uses, for the same reason: a paragraph
 * typed out is one save rather than one per keystroke, and a reader who stops
 * to think has their words on the server before they look away.
 */
export const NOTE_SAVE_DEBOUNCE_MS = 1000;

/**
 * How many times a save may be rebuilt on the server's note and sent again.
 *
 * Another device saving steadily could keep this going for as long as it
 * cares to, and a note that is forever about to be saved is worse than one
 * that says plainly it needs the reader. At the limit it stops and hands over.
 */
export const MAX_CONFLICT_RETRIES = 3;

/**
 * Where the note stands with the server, which the pane shows at all times.
 *
 * The reading position only speaks up when it fails; a note has to say where
 * it stands always. An editor that cannot be asked whether what was typed is
 * on the server is not one anybody trusts with anything they would mind
 * losing — and losing a paragraph is not the kind of accident losing a page
 * number is.
 */
export type NoteStatus = "loading" | "saved" | "dirty" | "saving" | "failed" | "conflicted";

/** The note this device is working on, and what it knows of the server's. */
interface SessionState {
  /** The note as the server last confirmed it, which merges are made against. */
  baseBody: string;
  baseVersion: number;
  /** The note on screen. */
  body: string;
  status: NoteStatus;
  saveError: string | null;
}

export interface NoteSession {
  body: string;
  status: NoteStatus;
  /** Why the last save did not land, in the server's words or the network's. */
  saveError: string | null;
  /** Why the note itself could not be read. */
  loadError: string | null;
  /** Why this device could not keep a copy of the note, when it could not. */
  draftError: string | null;
  /** Text found on this device that never reached the server, if any. */
  draftOffer: string | null;
  /** The reader typed. */
  edit: (body: string) => void;
  /** Save now, rather than waiting out the debounce. */
  save: () => void;
  /** Take the draft up, merging it onto the server's note if that has moved. */
  recoverDraft: () => void;
  /** Throw the draft away. */
  discardDraft: () => void;
}

const LOADING: SessionState = {
  baseBody: "",
  baseVersion: 0,
  body: "",
  status: "loading",
  saveError: null,
};

const CONFLICT_MESSAGE = "別の端末の変更と重なりました。マーカーの箇所を直すと保存を再開します";
const RETRIES_SPENT = "別の端末が書き込み続けているため保存を中断しました。「保存」で書き込めます";

/** Cache key of a book's note. */
export const noteKey = (pdfId: string) => `/api/pdf/${pdfId}/note`;

/**
 * The one place the note is written from.
 *
 * Every way of adding to a note — typing in it, dropping a passage of the PDF
 * into it, copying a chat exchange across — lands here, on one body of text
 * with one queue behind it. Given a `GET` and a `PUT` of their own, those
 * entrances would race each other before any second device got the chance to:
 * the same browser would be its own conflict.
 *
 * What the server holds is read once and becomes `baseBody` / `baseVersion`,
 * the note both sides diverged from. It is not kept in step with the server
 * after that — the text on screen is the reader's, and the base is only what a
 * merge is measured against.
 *
 * Saving is single-flight. While a `PUT` is out, further typing changes the
 * text but starts no second request; when the answer comes back the base moves
 * forward and whatever is still unsaved goes out next. A save refused as stale
 * is folded onto the note the server sent back and tried again, up to
 * `MAX_CONFLICT_RETRIES`; if the fold leaves markers, or the tries run out,
 * automatic saving stops and the note waits for the reader.
 */
export function useNoteSession(
  pdfId: string | undefined,
  options: {
    loadNote?: LoadNote;
    saveNote?: SaveNote;
    debounceMs?: number;
    /** Where drafts are kept; passed by tests, `localStorage` otherwise. */
    storage?: Storage | null;
  } = {},
): NoteSession {
  const {
    loadNote = fetchNote,
    saveNote = requestNoteSave,
    debounceMs = NOTE_SAVE_DEBOUNCE_MS,
  } = options;
  const storage = "storage" in options ? options.storage : undefined;

  const {
    data: loaded,
    error: loadFailure,
    isLoading,
  } = useSWRImmutable(pdfId ? noteKey(pdfId) : null, () => loadNote(pdfId as string));

  const [state, setState] = useState<SessionState>(LOADING);
  const [draftOffer, setDraftOffer] = useState<string | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);

  const isNarrow = useIsNarrow();

  // Read from inside the save, which runs long after the render that set it up
  const stateRef = useRef(state);
  const savingRef = useRef(false);
  const conflictsRef = useRef(0);
  const offerRef = useRef(draftOffer);
  const narrowRef = useRef(isNarrow);
  narrowRef.current = isNarrow;

  /**
   * Keep a copy of the note where a closed tab can still be got at.
   *
   * This is what stands in for the reading position's parting write: that one
   * is a few dozen bytes and rides out on `keepalive`, which caps at 64KB — a
   * note that has been written in all week does not fit through it.
   *
   * Only a wide screen writes one, since only a wide screen edits. A draft
   * already here is left alone on a narrow one: a window resized or a tablet
   * turned on its side is not the reader throwing their work away.
   */
  const mirrorDraft = useCallback(
    (next: SessionState) => {
      if (!pdfId || narrowRef.current || next.status === "loading") return;
      // The offer is backed by the very draft this would drop
      if (offerRef.current !== null) return;

      if (next.body === next.baseBody) {
        // The text on screen is the text on the server — this is the one
        // moment the copy is known to be worth nothing
        clearDraft(pdfId, storage);
        setDraftError(null);
        return;
      }

      const kept = writeDraft(
        pdfId,
        { body: next.body, baseBody: next.baseBody, baseVersion: next.baseVersion },
        storage,
      );
      // Said out loud rather than swallowed: a reader who believes there is a
      // copy of their note writes differently from one who knows there is not
      setDraftError(kept.kept ? null : kept.reason);
    },
    [pdfId, storage],
  );

  /**
   * Move the session on.
   *
   * The ref is written first and the render asked for second, so a save that
   * answers before React has re-rendered still reads the note as it is now
   * rather than as it was when the request went out.
   */
  const update = useCallback((next: SessionState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const commit = useCallback(
    (next: SessionState) => {
      update(next);
      mirrorDraft(next);
    },
    [mirrorDraft, update],
  );

  // The server's note becomes this session's starting point, once. Adjusted
  // during the render it arrives in rather than in an effect, so the pane never
  // shows an empty note under a book that has one.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (pdfId !== undefined && loaded !== undefined && seededFor !== pdfId) {
    setSeededFor(pdfId);
    const settled: SessionState = {
      baseBody: loaded.body,
      baseVersion: loaded.version,
      body: loaded.body,
      status: "saved",
      saveError: null,
    };
    update(settled);

    const draft = readDraft(pdfId, storage);
    if (draft === null || draft.body === loaded.body) {
      // Nothing in it the server does not already have
      if (draft !== null) clearDraft(pdfId, storage);
      offerRef.current = null;
      setDraftOffer(null);
    } else {
      offerRef.current = draft.body;
      setDraftOffer(draft.body);
    }
  }

  const draftRef = useRef<{ body: string; baseBody: string } | null>(null);
  if (pdfId !== undefined && draftOffer !== null && draftRef.current?.body !== draftOffer) {
    const draft = readDraft(pdfId, storage);
    draftRef.current = draft && { body: draft.body, baseBody: draft.baseBody };
  }

  /** What a text on screen means for whether there is anything to save. */
  const statusFor = useCallback((next: string, base: string): NoteStatus => {
    if (hasConflictMarkers(next)) return "conflicted";
    return next === base ? "saved" : "dirty";
  }, []);

  const onSaved = useCallback(
    (snapshot: string, version: number) => {
      conflictsRef.current = 0;
      const now = stateRef.current;
      // Whatever was typed while the request was out is still unsaved, and the
      // base has moved to what the server just took
      commit({
        baseBody: snapshot,
        baseVersion: version,
        body: now.body,
        status: statusFor(now.body, snapshot),
        saveError: null,
      });
    },
    [commit, statusFor],
  );

  const onRefused = useCallback(
    (failure: SaveNoteFailure) => {
      const now = stateRef.current;

      if (failure.type === "API") {
        // Left standing, with the text kept: the next edit is what tries again
        commit({ ...now, status: "failed", saveError: failure.cause.message });
        return;
      }

      conflictsRef.current += 1;
      // Folded onto what the server holds, against the note both sides came
      // from. Edits that never met each other come out silently merged; only
      // lines both devices rewrote come back as markers, in the Markdown
      // itself — the note is already source in a textarea, so it is its own
      // merge screen.
      const merged = mergeNoteBodies(now.body, now.baseBody, failure.current.body);
      const spent = conflictsRef.current >= MAX_CONFLICT_RETRIES;

      commit({
        baseBody: failure.current.body,
        baseVersion: failure.current.version,
        body: merged.body,
        status: merged.conflicted || spent ? "conflicted" : "dirty",
        saveError: merged.conflicted ? CONFLICT_MESSAGE : spent ? RETRIES_SPENT : null,
      });
    },
    [commit],
  );

  const runSave = useCallback(() => {
    const book = pdfId;
    if (!book) return;

    const now = stateRef.current;
    if (now.status === "loading") return;
    // Single-flight: a second request would be written against a version the
    // first one is about to move past, and would conflict with this very
    // browser. Whatever is still unsaved goes out once this answer is in.
    if (savingRef.current) return;

    const snapshot = now.body;
    savingRef.current = true;
    update({ ...now, status: "saving" });

    void saveNote(book, { body: snapshot, version: now.baseVersion })
      .match(
        ({ version }) => onSaved(snapshot, version),
        (failure) => onRefused(failure),
      )
      .finally(() => {
        savingRef.current = false;
      });
  }, [onRefused, onSaved, pdfId, saveNote, update]);

  // The wait a keystroke resets, and the queue behind a save that has just
  // answered: any move of the session re-reads the state and, if something is
  // still unsaved, sets the next write going. A note left with markers in it
  // is not written at all until the reader has settled them.
  useEffect(() => {
    if (!pdfId || state.status !== "dirty") return;

    const timer = setTimeout(runSave, debounceMs);
    return () => clearTimeout(timer);
  }, [pdfId, state, debounceMs, runSave]);

  const edit = useCallback(
    (body: string) => {
      const now = stateRef.current;
      if (now.status === "loading") return;
      // A save that failed is retried by the next edit, and markers edited out
      // are what starts the saving again
      commit({ ...now, body, status: statusFor(body, now.baseBody), saveError: null });
    },
    [commit, statusFor],
  );

  const recoverDraft = useCallback(() => {
    const draft = draftRef.current;
    offerRef.current = null;
    setDraftOffer(null);
    if (!draft) return;

    const now = stateRef.current;
    // The server may have moved on since the draft was written, so the two are
    // folded together over the note the draft was written against — the same
    // three-way the conflict path uses, for the same reason.
    const merged =
      draft.baseBody === now.baseBody
        ? { body: draft.body, conflicted: false }
        : mergeNoteBodies(draft.body, draft.baseBody, now.baseBody);

    commit({
      ...now,
      body: merged.body,
      status: merged.conflicted ? "conflicted" : statusFor(merged.body, now.baseBody),
      saveError: merged.conflicted ? CONFLICT_MESSAGE : null,
    });
  }, [commit, statusFor]);

  const discardDraft = useCallback(() => {
    offerRef.current = null;
    draftRef.current = null;
    setDraftOffer(null);
    if (pdfId) clearDraft(pdfId, storage);
  }, [pdfId, storage]);

  return {
    body: state.body,
    status: pdfId !== undefined && isLoading ? "loading" : state.status,
    saveError: state.saveError,
    loadError: loadFailure instanceof Error ? loadFailure.message : null,
    draftError,
    draftOffer,
    edit,
    save: runSave,
    recoverDraft,
    discardDraft,
  };
}
