import { describe, it, expect, beforeEach, afterEach, vi } from "vite-plus/test";
import { renderHook, act } from "@testing-library/react";
import { ResultAsync, errAsync, okAsync } from "neverthrow";
import type { ReactNode } from "react";
import { MAX_CONFLICT_RETRIES, noteKey, useNoteSession } from "./useNoteSession";
import type { SaveNote, SaveNoteFailure } from "../lib/noteApi";
import type { NoteSaved, SaveNoteRequest } from "../../shared/schemas/note";
import { ApiError } from "../lib/fetcher";
import { noteDraftKey, type NoteDraft } from "../lib/noteDraft";
import { SwrTestCache } from "../../test/swrTestCache";
import { setViewportWidth, PHONE_WIDTH } from "../../test/viewport";

const PDF_ID = "01JBOOK";
const DEBOUNCE = 50;

/** A store that keeps what it is given, in place of the browser's. */
function memoryStorage(seed: Record<string, string> = {}): Storage {
  const held = new Map(Object.entries(seed));
  return {
    get length() {
      return held.size;
    },
    clear: () => held.clear(),
    key: (i: number) => [...held.keys()][i] ?? null,
    getItem: (key: string) => held.get(key) ?? null,
    setItem: (key: string, value: string) => void held.set(key, value),
    removeItem: (key: string) => void held.delete(key),
  };
}

/** A save whose answer the test decides, and decides when. */
function deferredSave() {
  let settle!: (outcome: { version: number } | SaveNoteFailure) => void;
  const answer = new Promise<NoteSaved>((resolve, reject) => {
    settle = (outcome) => ("version" in outcome ? resolve(outcome) : reject(outcome));
  });
  return {
    result: ResultAsync.fromPromise(answer, (cause) => cause as SaveNoteFailure),
    settle,
  };
}

const conflictWith = (body: string, version: number): SaveNoteFailure => ({
  type: "CONFLICT",
  current: { body, version },
});

const SERVER_NOTE = { body: "# Raft\n\n選挙の話\n", version: 3 };

interface HarnessOptions {
  /** What the server holds when the note is first read. */
  server?: { body: string; version: number };
  /** Answers to hand back, one per save, in order. */
  answers?: (SaveNoteFailure | { version: number })[];
  storage?: Storage;
  draft?: NoteDraft;
}

function noteHarness({ server = SERVER_NOTE, answers = [], storage, draft }: HarnessOptions = {}) {
  const store = storage ?? memoryStorage();
  if (draft) store.setItem(noteDraftKey(PDF_ID), JSON.stringify(draft));

  const sent: SaveNoteRequest[] = [];
  const pending: ((outcome: { version: number } | SaveNoteFailure) => void)[] = [];
  let answered = 0;

  const saveNote: SaveNote = (_pdfId, input) => {
    sent.push(input);
    const scripted = answers[answered++];
    if (scripted === undefined) {
      // Left hanging so the test can say when the answer arrives
      const { result, settle } = deferredSave();
      pending.push(settle);
      return result;
    }
    return "version" in scripted ? okAsync(scripted) : errAsync(scripted);
  };

  const wrapper = ({ children }: { children: ReactNode }) => (
    <SwrTestCache seed={{ [noteKey(PDF_ID)]: server }}>{children}</SwrTestCache>
  );

  const view = renderHook(
    () => useNoteSession(PDF_ID, { saveNote, debounceMs: DEBOUNCE, storage: store }),
    { wrapper },
  );

  /** Type, and let the wait for the next keystroke run out. */
  const type = async (body: string) => {
    act(() => view.result.current.edit(body));
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE);
    });
  };

  /** Answer the save that is still out. */
  const answer = async (outcome: { version: number } | SaveNoteFailure) => {
    const settle = pending.shift();
    if (!settle) throw new Error("no save is waiting for an answer");
    await act(async () => {
      settle(outcome);
    });
  };

  const draftIn = (): NoteDraft | null => {
    const stored = store.getItem(noteDraftKey(PDF_ID));
    return stored === null ? null : (JSON.parse(stored) as NoteDraft);
  };

  return { view, sent, type, answer, draftIn, store, session: () => view.result.current };
}

describe("useNoteSession", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("opens on the note the server holds, with nothing left to save", () => {
    const { session } = noteHarness();

    expect(session().body).toBe(SERVER_NOTE.body);
    expect(session().status).toBe("saved");
  });

  it("saves what was typed, against the version it was typed onto", async () => {
    const { session, sent, type, answer } = noteHarness();

    await type("# Raft\n\n選挙の話（過半数）\n");
    expect(session().status).toBe("saving");
    expect(sent).toStrictEqual([{ body: "# Raft\n\n選挙の話（過半数）\n", version: 3 }]);

    await answer({ version: 4 });
    expect(session().status).toBe("saved");
  });

  it("waits out the typing rather than saving each keystroke", async () => {
    const { sent, view } = noteHarness();

    act(() => view.result.current.edit("一"));
    act(() => {
      vi.advanceTimersByTime(DEBOUNCE - 10);
    });
    act(() => view.result.current.edit("一行"));
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE - 10);
    });

    expect(sent).toStrictEqual([]);
  });

  it("keeps typing that lands mid-save, and sends it once the first save is in", async () => {
    // Two requests at once would be written against the same version, and the
    // second would conflict with this very browser before any other device got
    // the chance to.
    const { session, sent, type, answer } = noteHarness();

    await type("一行目\n");
    expect(sent).toHaveLength(1);

    act(() => session().edit("一行目\n二行目\n"));
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE);
    });
    expect(sent).toHaveLength(1);
    expect(session().body).toBe("一行目\n二行目\n");

    await answer({ version: 4 });
    expect(session().status).toBe("dirty");

    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE);
    });
    // Written against the version the first save produced, not the one it was
    // sent against
    expect(sent[1]).toStrictEqual({ body: "一行目\n二行目\n", version: 4 });
  });

  it("folds the server's note in and sends again when the save is refused as stale", async () => {
    const { session, sent, type } = noteHarness({
      answers: [conflictWith("# Raft\n\n選挙の話\n\n## ログ複製\n", 5)],
    });

    await type("# Raft\n\n選挙の話（過半数）\n");

    // Neither device touched what the other did, so the reader is not asked
    expect(session().body).toBe("# Raft\n\n選挙の話（過半数）\n\n## ログ複製\n");
    expect(session().status).toBe("dirty");

    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE);
    });
    expect(sent[1]).toStrictEqual({
      body: "# Raft\n\n選挙の話（過半数）\n\n## ログ複製\n",
      version: 5,
    });
  });

  it("hands the reader the markers when both sides rewrote the same line, and stops saving", async () => {
    const { session, sent, type } = noteHarness({
      answers: [conflictWith("# Raft\n\nあちらの書き直し\n", 5)],
    });

    await type("# Raft\n\nこちらの書き直し\n");

    expect(session().status).toBe("conflicted");
    expect(session().body).toContain("<<<<<<< 自分");
    expect(session().body).toContain(">>>>>>> サーバ");
    expect(session().saveError).toContain("別の端末");

    // Nothing more goes out on its own while the markers are in it
    await act(async () => {
      vi.advanceTimersByTime(DEBOUNCE * 10);
    });
    expect(sent).toHaveLength(1);
  });

  it("starts saving again once the reader has settled the markers", async () => {
    const { session, sent, type } = noteHarness({
      answers: [conflictWith("# Raft\n\nあちらの書き直し\n", 5)],
    });
    await type("# Raft\n\nこちらの書き直し\n");

    await type("# Raft\n\n両方を活かした行\n");

    expect(session().status).toBe("saving");
    // Against the version the conflict handed back, which is what the merged
    // note was built on
    expect(sent[1]).toStrictEqual({ body: "# Raft\n\n両方を活かした行\n", version: 5 });
  });

  it("stops rebuilding the save when the other device will not stop writing", async () => {
    // Each fold succeeds and each retry is refused again. Left alone this would
    // go on for as long as the other device cares to keep saving.
    const answers = Array.from({ length: MAX_CONFLICT_RETRIES }, (_, i) =>
      conflictWith(`# Raft\n\n選挙の話\n\n## ${i} 章\n`, 5 + i),
    );
    const { session, sent, type } = noteHarness({ answers });

    await type("# Raft\n\n選挙の話（過半数）\n");
    for (let i = 1; i < MAX_CONFLICT_RETRIES; i++) {
      await act(async () => {
        vi.advanceTimersByTime(DEBOUNCE);
      });
    }

    expect(sent).toHaveLength(MAX_CONFLICT_RETRIES);
    expect(session().status).toBe("conflicted");
    expect(session().saveError).toContain("保存を中断");
    // The reader's own words are still in the note, on top of the last one the
    // server sent back
    expect(session().body).toContain("選挙の話（過半数）");
  });

  it("keeps the text and says why when the save could not be sent", async () => {
    const { session, type } = noteHarness({
      answers: [
        { type: "API", cause: new ApiError("回線が切れました", "NETWORK_ERROR", 0, "network") },
      ],
    });

    await type("届かなかった本文\n");

    expect(session().status).toBe("failed");
    expect(session().saveError).toBe("回線が切れました");
    expect(session().body).toBe("届かなかった本文\n");
  });

  it("tries again on the next edit after a save that failed", async () => {
    const { sent, type } = noteHarness({
      answers: [
        { type: "API", cause: new ApiError("回線が切れました", "NETWORK_ERROR", 0, "network") },
      ],
    });
    await type("届かなかった本文\n");

    await type("届かなかった本文\nもう一行\n");

    expect(sent).toHaveLength(2);
  });

  describe("the copy kept on this device", () => {
    it("keeps unsaved text where a closed tab can still be got at it", async () => {
      const { draftIn, type } = noteHarness();

      await type("まだ送っていない本文\n");

      expect(draftIn()).toStrictEqual({
        body: "まだ送っていない本文\n",
        baseBody: SERVER_NOTE.body,
        baseVersion: SERVER_NOTE.version,
      });
    });

    it("drops the copy once the text on screen is the text on the server", async () => {
      const { draftIn, type, answer } = noteHarness();
      await type("送る本文\n");
      expect(draftIn()).not.toBeNull();

      await answer({ version: 4 });

      expect(draftIn()).toBeNull();
    });

    it("keeps the copy when the save landed but the reader has written more since", async () => {
      const { draftIn, session, type, answer } = noteHarness();
      await type("送る本文\n");
      act(() => session().edit("送る本文\nさらに書いた\n"));

      await answer({ version: 4 });

      expect(draftIn()).toStrictEqual({
        body: "送る本文\nさらに書いた\n",
        baseBody: "送る本文\n",
        baseVersion: 4,
      });
    });

    it("offers text found here that never reached the server", () => {
      const { session } = noteHarness({
        draft: { body: "閉じる前に書いた本文\n", baseBody: SERVER_NOTE.body, baseVersion: 3 },
      });

      expect(session().draftOffer).toBe("閉じる前に書いた本文\n");
      // Not put on screen behind the reader's back: taking it up is theirs to
      // say, since the server's note is what everything else agrees on
      expect(session().body).toBe(SERVER_NOTE.body);
    });

    it("offers nothing when the copy says only what the server already does", () => {
      const { session, draftIn } = noteHarness({
        draft: { body: SERVER_NOTE.body, baseBody: SERVER_NOTE.body, baseVersion: 3 },
      });

      expect(session().draftOffer).toBeNull();
      expect(draftIn()).toBeNull();
    });

    it("puts the copy back on screen when the reader takes it up", async () => {
      const { session } = noteHarness({
        draft: { body: "閉じる前に書いた本文\n", baseBody: SERVER_NOTE.body, baseVersion: 3 },
      });

      act(() => session().recoverDraft());

      expect(session().body).toBe("閉じる前に書いた本文\n");
      expect(session().status).toBe("dirty");
      expect(session().draftOffer).toBeNull();
    });

    it("folds the copy onto the server's note when that has moved on since", () => {
      // Written against one note, coming back to another. Time cannot settle
      // this — two devices do not agree on it — so the text does.
      const { session } = noteHarness({
        server: { body: "# Raft\n\n選挙の話\n\n## ログ複製\n", version: 7 },
        draft: {
          body: "# Raft\n\n選挙の話（過半数）\n",
          baseBody: "# Raft\n\n選挙の話\n",
          baseVersion: 3,
        },
      });

      act(() => session().recoverDraft());

      expect(session().body).toBe("# Raft\n\n選挙の話（過半数）\n\n## ログ複製\n");
      expect(session().status).toBe("dirty");
    });

    it("throws the copy away when the reader says to", () => {
      const { session, draftIn } = noteHarness({
        draft: { body: "要らなかった本文\n", baseBody: SERVER_NOTE.body, baseVersion: 3 },
      });

      act(() => session().discardDraft());

      expect(session().draftOffer).toBeNull();
      expect(draftIn()).toBeNull();
      expect(session().body).toBe(SERVER_NOTE.body);
    });

    it("says so when this device has no room to keep the copy", async () => {
      const store = memoryStorage();
      store.setItem = () => {
        throw new DOMException("full", "QuotaExceededError");
      };
      const { session, type } = noteHarness({ storage: store });

      await type("入りきらない本文\n");

      expect(session().draftError).toContain("下書きを保存できませんでした");
    });

    it("keeps a copy made on a wide screen after the window has narrowed", async () => {
      const { view, draftIn, type } = noteHarness();
      await type("広い画面で書いた本文\n");

      await act(async () => {
        setViewportWidth(PHONE_WIDTH);
      });
      act(() => view.result.current.edit("広い画面で書いた本文\nさらに\n"));

      // Narrow screens write no draft of their own — there is no editing there
      // to draft — but a resized window is not the reader throwing work away
      expect(draftIn()).toStrictEqual({
        body: "広い画面で書いた本文\n",
        baseBody: SERVER_NOTE.body,
        baseVersion: SERVER_NOTE.version,
      });
    });
  });
});
