import { describe, it, expect, vi } from "vite-plus/test";
import { fetchNote, requestNoteSave } from "./noteApi";
import { ApiError } from "./fetcher";

const PDF_ID = "01JBOOK";

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("fetchNote", () => {
  it("reads the note the server holds", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ body: "メモ", version: 2 }, 200));

    await expect(fetchNote(PDF_ID, fetchFn)).resolves.toStrictEqual({ body: "メモ", version: 2 });
    expect(fetchFn).toHaveBeenCalledWith(`/api/pdf/${PDF_ID}/note`, undefined);
  });

  it("passes a refusal on in the words the server used", async () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ error: { code: "PDF_NOT_FOUND", message: "PDF not found" } }, 404),
      );

    await expect(fetchNote(PDF_ID, fetchFn)).rejects.toMatchObject({
      code: "PDF_NOT_FOUND",
      status: 404,
    });
  });
});

describe("requestNoteSave", () => {
  it("hands back the version the save produced", async () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ version: 4 }, 200));

    const result = await requestNoteSave(PDF_ID, { body: "メモ", version: 3 }, fetchFn);

    expect(result._unsafeUnwrap()).toStrictEqual({ version: 4 });
    const [url, init] = fetchFn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`/api/pdf/${PDF_ID}/note`);
    expect(init.method).toBe("PUT");
    expect(init.body).toBe(JSON.stringify({ body: "メモ", version: 3 }));
  });

  it("keeps the note a conflict lost to, which the generic reader would have dropped", () => {
    // `resultFetcher` reads `{ error }` out of a refusal and nothing else, so
    // going through it here would throw away the very text a rebase or a merge
    // has to be made against.
    const fetchFn = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          error: { code: "NOTE_CONFLICT", message: "Note changed since it was read" },
          current: { body: "あちらの端末が書いた", version: 5 },
        },
        409,
      ),
    );

    return requestNoteSave(PDF_ID, { body: "メモ", version: 3 }, fetchFn).match(
      () => expect.unreachable("the save was refused"),
      (failure) =>
        expect(failure).toStrictEqual({
          type: "CONFLICT",
          current: { body: "あちらの端末が書いた", version: 5 },
        }),
    );
  });

  it("treats a 409 without the note it lost to as an ordinary refusal", () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ error: { code: "NOTE_CONFLICT", message: "こじれました" } }, 409),
      );

    return requestNoteSave(PDF_ID, { body: "メモ", version: 3 }, fetchFn).match(
      () => expect.unreachable("the save was refused"),
      (failure) => {
        expect(failure.type).toBe("API");
        expect(failure.type === "API" && failure.cause.message).toBe("こじれました");
      },
    );
  });

  it("reports a refusal in the same words every other request's is reported in", () => {
    const fetchFn = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({ error: { code: "PDF_NOT_FOUND", message: "PDF not found" } }, 404),
      );

    return requestNoteSave(PDF_ID, { body: "メモ", version: 0 }, fetchFn).match(
      () => expect.unreachable("the save was refused"),
      (failure) => {
        expect(failure.type).toBe("API");
        expect(failure.type === "API" && failure.cause).toBeInstanceOf(ApiError);
        expect(failure.type === "API" && failure.cause.code).toBe("PDF_NOT_FOUND");
      },
    );
  });

  it("reports an answer that is not a saved version as one it cannot read", () => {
    const fetchFn = vi.fn().mockResolvedValue(jsonResponse({ saved: true }, 200));

    return requestNoteSave(PDF_ID, { body: "メモ", version: 0 }, fetchFn).match(
      () => expect.unreachable("the answer was not a version"),
      (failure) => expect(failure.type === "API" && failure.cause.code).toBe("INVALID_RESPONSE"),
    );
  });

  it("reports a request that never reached the server", () => {
    const fetchFn = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));

    return requestNoteSave(PDF_ID, { body: "メモ", version: 0 }, fetchFn).match(
      () => expect.unreachable("the request never landed"),
      (failure) => expect(failure.type === "API" && failure.cause.kind).toBe("network"),
    );
  });
});
