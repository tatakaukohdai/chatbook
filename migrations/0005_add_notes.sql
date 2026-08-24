-- One Markdown note per book, kept in its own table rather than as a column on
-- `pdfs`: `readPdf` / `storePdf` list every column of that table by name, so a
-- note living there would be read from D1 on each opening of the book,
-- alongside the full text it already carries.
--
-- `version` is what makes a save an answer rather than an overwrite. Two
-- devices reading a book is this app's premise — it is what the reading state
-- syncs for — and losing a paragraph is not the same kind of accident as
-- losing a page number, so a save says which version it was written against
-- and the server refuses one written against a version it has moved past.
CREATE TABLE notes (
  id          TEXT PRIMARY KEY,
  -- UNIQUE is what lets the save be a single conditional UPSERT: "update, and
  -- insert if that touched nothing" would let two devices that both read an
  -- empty note insert at once, and one of them would get a constraint failure
  -- rather than a conflict it could resolve.
  pdf_id      TEXT NOT NULL UNIQUE REFERENCES pdfs(id) ON DELETE CASCADE,
  body        TEXT NOT NULL,
  version     INTEGER NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
