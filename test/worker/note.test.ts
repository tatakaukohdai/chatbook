import { describe, it, expect, beforeAll } from "vite-plus/test";
import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { apiFetch } from "./setup/session";
import { MINIMAL_PDF_BYTES } from "./fixtures/minimalPdf";
import { noteConflictSchema, noteSnapshotSchema } from "../../src/shared/schemas/note";

beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
});

/** Books are de-duplicated by content hash, so each one here needs its own bytes. */
function uniquePdfBytes(tag: string): Uint8Array {
  const suffix = new TextEncoder().encode(`\n%${tag}\n`);
  const bytes = new Uint8Array(MINIMAL_PDF_BYTES.length + suffix.length);
  bytes.set(MINIMAL_PDF_BYTES, 0);
  bytes.set(suffix, MINIMAL_PDF_BYTES.length);
  return bytes;
}

async function uploadBook(tag: string): Promise<string> {
  const formData = new FormData();
  formData.append(
    "file",
    new File([uniquePdfBytes(tag)], `${tag}.pdf`, { type: "application/pdf" }),
  );
  formData.append("fullText", "text");
  formData.append("pageCount", "1");

  const response = await apiFetch("https://example.com/api/pdf/open", {
    method: "POST",
    body: formData,
  });
  return ((await response.json()) as { id: string }).id;
}

const noteUrl = (pdfId: string) => `https://example.com/api/pdf/${pdfId}/note`;

function getNote(pdfId: string): Promise<Response> {
  return apiFetch(noteUrl(pdfId));
}

function putNote(pdfId: string, body: unknown): Promise<Response> {
  return apiFetch(noteUrl(pdfId), {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("GET /api/pdf/:pdfId/note", () => {
  it("answers with an empty note at version 0 for a book nobody has written about", async () => {
    // Not a 404: an untouched note and a saved empty one read the same to the
    // reader, and version 0 is what the first save is written against.
    const pdfId = await uploadBook("note-empty");

    const response = await getNote(pdfId);

    expect(response.status).toBe(200);
    expect(await response.json()).toStrictEqual({ body: "", version: 0 });
  });

  it("hands back what was saved, so another device opens the note where this one left it", async () => {
    const pdfId = await uploadBook("note-roundtrip");
    await putNote(pdfId, { body: "# Raft\n\n3 章がまだ腑に落ちない\n", version: 0 });

    const response = await getNote(pdfId);

    expect(noteSnapshotSchema.parse(await response.json())).toStrictEqual({
      body: "# Raft\n\n3 章がまだ腑に落ちない\n",
      version: 1,
    });
  });

  it("refuses a book that is not on the shelf, which is a different answer from an empty note", async () => {
    const response = await getNote("no-such-book");

    expect(response.status).toBe(404);
    expect(await response.json()).toStrictEqual({
      error: { code: "PDF_NOT_FOUND", message: "PDF not found" },
    });
  });
});

describe("PUT /api/pdf/:pdfId/note", () => {
  it("counts up the version each save, so the next one can name what it was written against", async () => {
    const pdfId = await uploadBook("note-versions");

    const first = await putNote(pdfId, { body: "一行目", version: 0 });
    expect(first.status).toBe(200);
    expect(await first.json()).toStrictEqual({ version: 1 });

    const second = await putNote(pdfId, { body: "一行目\n二行目", version: 1 });
    expect(await second.json()).toStrictEqual({ version: 2 });
  });

  it("gives one of two devices that both created the note a conflict rather than a 500", async () => {
    // Both read the empty note and both save against version 0. "Update, and
    // insert when that touched nothing" would have the second one fail on the
    // unique pdf_id — a server error where the reader can only see something
    // broken, rather than a conflict they can resolve.
    const pdfId = await uploadBook("note-first-save-race");

    const [one, other] = await Promise.all([
      putNote(pdfId, { body: "こちらの端末", version: 0 }),
      putNote(pdfId, { body: "あちらの端末", version: 0 }),
    ]);

    const statuses = [one.status, other.status].sort((a, b) => a - b);
    expect(statuses).toStrictEqual([200, 409]);

    const refused = one.status === 409 ? one : other;
    const conflict = noteConflictSchema.parse(await refused.json());
    expect(conflict.error.code).toBe("NOTE_CONFLICT");
    // The note the winner wrote, so the loser can merge onto it
    expect(conflict.current.version).toBe(1);
    expect(["こちらの端末", "あちらの端末"]).toContain(conflict.current.body);
  });

  it("refuses a save written against a version it has moved past, and says what it holds now", async () => {
    const pdfId = await uploadBook("note-stale");
    await putNote(pdfId, { body: "最初", version: 0 });
    await putNote(pdfId, { body: "別の端末が書いた", version: 1 });

    const response = await putNote(pdfId, { body: "こちらの続き", version: 1 });

    expect(response.status).toBe(409);
    expect(noteConflictSchema.parse(await response.json())).toStrictEqual({
      error: { code: "NOTE_CONFLICT", message: "Note changed since it was read" },
      current: { body: "別の端末が書いた", version: 2 },
    });
  });

  it("leaves the note alone when it refuses the save", async () => {
    const pdfId = await uploadBook("note-refusal-keeps");
    await putNote(pdfId, { body: "残るべき本文", version: 0 });

    await putNote(pdfId, { body: "上書きしてはいけない", version: 0 });

    expect(await (await getNote(pdfId)).json()).toStrictEqual({
      body: "残るべき本文",
      version: 1,
    });
  });

  it("refuses a book that is not on the shelf", async () => {
    const response = await putNote("no-such-book", { body: "どこにも属さないメモ", version: 0 });

    expect(response.status).toBe(404);
    expect(await response.json()).toStrictEqual({
      error: { code: "PDF_NOT_FOUND", message: "PDF not found" },
    });
  });

  it("names the field at fault when the body is not a note", async () => {
    const pdfId = await uploadBook("note-invalid");

    const response = await putNote(pdfId, { body: "メモ", version: -1 });

    expect(response.status).toBe(400);
    expect(await response.json()).toStrictEqual({
      error: { code: "VALIDATION_ERROR", message: "Invalid request body: version" },
    });
  });

  it("takes the note with the book it belongs to", async () => {
    const pdfId = await uploadBook("note-cascade");
    await putNote(pdfId, { body: "本と一緒に消える", version: 0 });

    await apiFetch(`https://example.com/api/pdf/${pdfId}`, { method: "DELETE" });

    const rows = await env.DB.prepare("SELECT COUNT(*) AS n FROM notes WHERE pdf_id = ?")
      .bind(pdfId)
      .first<{ n: number }>();
    expect(rows?.n).toBe(0);
  });
});
