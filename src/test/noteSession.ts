import type { NoteSession } from "../front/hooks/useNoteSession";

/**
 * A note session that does nothing, for the tests of everything around it.
 *
 * The session's own behaviour — saving, conflicts, drafts — is what
 * `useNoteSession.test.tsx` is for; components rendered over it only need one
 * to exist.
 */
export function stubNoteSession(overrides: Partial<NoteSession> = {}): NoteSession {
  return {
    body: "",
    status: "saved",
    saveError: null,
    loadError: null,
    draftError: null,
    draftOffer: null,
    edit: () => {},
    save: () => {},
    recoverDraft: () => {},
    discardDraft: () => {},
    ...overrides,
  };
}
