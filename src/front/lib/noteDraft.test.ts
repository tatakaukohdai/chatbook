import { describe, it, expect, beforeEach } from "vite-plus/test";
import { clearDraft, noteDraftKey, readDraft, writeDraft } from "./noteDraft";

const PDF_ID = "01JBOOK";

/** A store that keeps what it is given, standing in for `localStorage`. */
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

const DRAFT = { body: "書きかけ\n", baseBody: "もと\n", baseVersion: 3 };

describe("writeDraft / readDraft", () => {
  it("keeps a draft where the same book will look for it", () => {
    const storage = memoryStorage();

    expect(writeDraft(PDF_ID, DRAFT, storage)).toStrictEqual({ kept: true });
    expect(readDraft(PDF_ID, storage)).toStrictEqual(DRAFT);
  });

  it("keeps each book's draft apart", () => {
    const storage = memoryStorage();
    writeDraft(PDF_ID, DRAFT, storage);

    expect(readDraft("01JOTHER", storage)).toBeNull();
  });

  it("reports nothing for a book nothing was ever written about", () => {
    expect(readDraft(PDF_ID, memoryStorage())).toBeNull();
  });

  it("treats a draft it cannot read as one that is not there", () => {
    // Another release, another tab, or the devtools can leave anything at that
    // key. Throwing here would take the note pane down over a backup.
    const storage = memoryStorage({ [noteDraftKey(PDF_ID)]: "{ 壊れた" });

    expect(readDraft(PDF_ID, storage)).toBeNull();
  });

  it("treats a draft that is missing what it needs as one that is not there", () => {
    const storage = memoryStorage({ [noteDraftKey(PDF_ID)]: JSON.stringify({ body: "本文だけ" }) });

    expect(readDraft(PDF_ID, storage)).toBeNull();
  });

  it("says it could not keep the draft when the store is full", () => {
    // Swallowed, the reader goes on writing believing there is a copy of it.
    const storage = memoryStorage();
    storage.setItem = () => {
      throw new DOMException("full", "QuotaExceededError");
    };

    expect(writeDraft(PDF_ID, DRAFT, storage)).toStrictEqual({
      kept: false,
      reason: "この端末に下書きを保存できませんでした（保存領域の空きが足りません）",
    });
  });

  it("says it could not keep the draft when the store refuses to be written to at all", () => {
    const storage = memoryStorage();
    storage.setItem = () => {
      throw new Error("denied");
    };

    expect(writeDraft(PDF_ID, DRAFT, storage).kept).toBe(false);
  });
});

describe("clearDraft", () => {
  it("takes the draft away once its text is known to be on the server", () => {
    const storage = memoryStorage();
    writeDraft(PDF_ID, DRAFT, storage);

    clearDraft(PDF_ID, storage);

    expect(readDraft(PDF_ID, storage)).toBeNull();
  });

  it("says nothing when there is no store to clear", () => {
    expect(() => clearDraft(PDF_ID, null)).not.toThrow();
  });
});

describe("readDraft with no store", () => {
  beforeEach(() => {
    // A private window, or a browser set to refuse site data
  });

  it("reports nothing rather than throwing", () => {
    expect(readDraft(PDF_ID, null)).toBeNull();
    expect(writeDraft(PDF_ID, DRAFT, null).kept).toBe(false);
  });
});
