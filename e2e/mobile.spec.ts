import { test, expect, type Locator, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  COVER_TITLE,
  FIXTURE_FILE_NAME,
  OUTLINE,
  PAGE_COUNT,
} from "./fixtures/testBookManifest.ts";

/**
 * The reader on a screen with room for one column.
 *
 * Everything here is about what the width changes: the panes folding into a
 * page with a toolbar under it, and the gestures that replace a pointer. What
 * both layouts share — opening a book, drawing it, following a citation — is
 * covered once, against the panes, in `chatbook.spec.ts`.
 *
 * Not covered here: the pinch. Playwright drives one finger, and a gesture
 * needing two cannot be sent at all; `src/front/lib/touchNavigation.test.ts`
 * holds the arithmetic instead.
 */

const TEST_PDF = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  FIXTURE_FILE_NAME,
);

function pageLabel(pageNumber: number): string {
  return `${pageNumber} / ${PAGE_COUNT}`;
}

/** Upload the fixture book and land in the reader, with no highlights on it. */
/**
 * Sign in, so the rest of the run can reach the API.
 *
 * The credentials are the ones `.dev.vars` carries for local development; the
 * deployed app has a password of its own that never appears here.
 */
async function logIn(page: Page): Promise<void> {
  const response = await page.request.post("/api/auth/login", {
    data: { username: "demo", password: "demo" },
  });
  expect(response.status()).toBe(200);
}

/**
 * Empty the shared fixture's note with the version the server just returned.
 *
 * All three projects upload the same bytes and therefore use the same pdf id.
 * Returning whether anything changed lets the caller reload only when the
 * already-mounted note session has become stale because of this reset.
 */
async function clearNote(page: Page, pdfId: string): Promise<boolean> {
  const note = (await (await page.request.get(`/api/pdf/${pdfId}/note`)).json()) as {
    body: string;
    version: number;
  };
  if (note.body === "") return false;

  const response = await page.request.put(`/api/pdf/${pdfId}/note`, {
    data: { body: "", version: note.version },
  });
  expect(response.status()).toBe(200);
  return true;
}

async function openTestBook(page: Page): Promise<string> {
  await logIn(page);
  await page.goto("/");
  await page.setInputFiles('input[type="file"]', TEST_PDF);
  await expect(page).toHaveURL(/\/books\//, { timeout: 60000 });

  const pdfId = new URL(page.url()).pathname.split("/").pop()!;
  const { selections, readingState } = (await (
    await page.request.get(`/api/pdf/${pdfId}`)
  ).json()) as {
    selections: { id: string }[];
    readingState: {
      page: number;
      outlineOpen: boolean | null;
      chatPanelOpen: boolean | null;
    } | null;
  };
  for (const selection of selections) {
    await page.request.delete(`/api/pdf/${pdfId}/selections/${selection.id}`);
  }

  // The three specs share this book, and the reader's place — both panels
  // included — is kept on the server now: uploading goes through the shelf,
  // which names no page, so an earlier test's place would be where this one
  // opens.
  await page.request.put(`/api/pdf/${pdfId}/reading-state`, {
    data: { page: 1, selectionId: null, outlineOpen: true, chatPanelOpen: true },
  });
  const noteWasWrittenIn = await clearNote(page, pdfId);

  // Reload only where the reader is showing something the reset has just
  // replaced: a second load of the book costs as much as the first one.
  const resumedElsewhere =
    readingState !== null &&
    (readingState.page !== 1 ||
      readingState.outlineOpen === false ||
      readingState.chatPanelOpen === false);
  if (selections.length > 0 || resumedElsewhere || noteWasWrittenIn) {
    await page.goto(`/books/${pdfId}?page=1`);
  }
  // The page counter arrives with the book, but a tap or a drag needs the page
  // itself to have been drawn.
  await expect(page.getByText(pageLabel(1), { exact: true })).toBeVisible({ timeout: 60000 });
  await expect(page.locator("canvas.block")).toBeVisible({ timeout: 60000 });
  await expect(page.locator('.textLayer span[data-page-number="1"]').first()).toBeVisible({
    timeout: 60000,
  });
  return pdfId;
}

/** Drag a known fixture line with the browser's real selection behavior. */
async function dragPassage(page: Page, line: Locator): Promise<string> {
  const box = (await line.boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 12 });
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  await page.mouse.up();
  return selected;
}

/** The pane the page is drawn and scrolled in. */
function pagePane(page: Page) {
  return page.locator("main .overflow-auto").first();
}

test("opens a book as one column, with the page controls under it", async ({ page }) => {
  await openTestBook(page);

  await expect(page.getByRole("navigation", { name: "ページ操作" })).toBeVisible();
  // The splitter sizes a second pane, and there is none
  await expect(page.getByRole("separator")).toHaveCount(0);
  // The page is drawn across the full width rather than shrunk to fit beside
  // something: it fills the window bar the pane's own padding.
  const pane = (await pagePane(page).boundingBox())!;
  // Waited for rather than read straight away: an unrendered canvas still has
  // a box, the 300x150 one every canvas starts with, and measuring that reads
  // as a page shrunk to a third of the window.
  const drawn = page.locator("main canvas").first();
  await expect
    .poll(async () => (await drawn.boundingBox())?.width ?? 0)
    .toBeGreaterThan(pane.width - 40);
});

test("turns the page on a tap at the edge, and leaves the middle alone", async ({ page }) => {
  await openTestBook(page);
  const pane = (await pagePane(page).boundingBox())!;
  const middleY = pane.y + pane.height / 2;

  await page.touchscreen.tap(pane.x + pane.width * 0.9, middleY);
  await expect(page.getByText(pageLabel(2), { exact: true })).toBeVisible();

  await page.touchscreen.tap(pane.x + pane.width * 0.1, middleY);
  await expect(page.getByText(pageLabel(1), { exact: true })).toBeVisible();

  // The middle belongs to the double tap that zooms, so one tap there does
  // nothing rather than turning the page under the reader's finger.
  await page.touchscreen.tap(pane.x + pane.width * 0.5, middleY);
  await expect(page.getByText(pageLabel(1), { exact: true })).toBeVisible();

  // Asserting page 1 straight after the middle tap would pass whether the tap
  // was ignored or had not been acted on yet. Turning the page from here says
  // which: a middle tap that had counted would land on 3 instead.
  await page.touchscreen.tap(pane.x + pane.width * 0.9, middleY);
  await expect(page.getByText(pageLabel(2), { exact: true })).toBeVisible();
});

test("brings the outline over the page, and jumps from it", async ({ page }) => {
  await openTestBook(page);
  const chapter = OUTLINE.find((entry) => entry.page > 1)!;

  await page.getByRole("button", { name: "目次", exact: true }).tap();
  await expect(page.getByRole("button", { name: "目次を閉じる" })).toBeVisible();

  await page.getByRole("button", { name: new RegExp(`^${chapter.title}`) }).tap();

  await expect(page.getByText(pageLabel(chapter.page), { exact: true })).toBeVisible();
  // Jumping is also leaving: the drawer covers the page it just moved to
  await expect(page.getByRole("button", { name: "目次を閉じる" })).toHaveCount(0);
});

test("raises the chat from the toolbar without taking the page turn away", async ({ page }) => {
  await openTestBook(page);

  await page.getByRole("button", { name: "チャット" }).tap();

  await expect(page.getByRole("region", { name: "チャット" })).toBeVisible();
  // The sheet stops above the toolbar, so reading on is still possible while
  // an answer is up — which is the point of having both on screen.
  await page.getByRole("button", { name: "次のページ" }).tap();
  await expect(page.getByText(pageLabel(2), { exact: true })).toBeVisible();
});

test("gives the answer the whole pane once the sheet is drawn all the way up", async ({ page }) => {
  await openTestBook(page);

  await page.getByRole("button", { name: "チャット" }).tap();
  const sheet = page.getByRole("region", { name: "チャット" });
  const pane = (await page.locator("main").boundingBox())!;
  expect((await sheet.boundingBox())!.height).toBeLessThan(pane.height * 0.6);

  await page.getByRole("button", { name: "チャットを広げる" }).tap();

  // Reading an answer through is what drawing the sheet up is for, and a strip
  // of the page above it is neither readable nor worth the lines of the answer
  // it costs.
  expect((await sheet.boundingBox())!.height).toBeCloseTo(pane.height, 0);
  // Still short of the toolbar, so the way on and the way back are both in reach
  await expect(page.getByRole("button", { name: "次のページ" })).toBeVisible();
  await expect(page.getByRole("button", { name: "チャットを縮める" })).toBeVisible();
});

test("offers to ask about a passage, and puts the question box up on request", async ({ page }) => {
  await openTestBook(page);

  // A drag over a line is what a long press settles into; the viewer reads it
  // from the browser announcing the selection rather than from a mouse button.
  const line = page.locator(".textLayer span").first();
  const box = (await line.boundingBox())!;
  await page.mouse.move(box.x + 1, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();

  const ask = page.getByRole("button", { name: "AIに質問" });
  await expect(ask).toBeVisible({ timeout: 10000 });
  // The passage is quoted back, where a selection off by a word shows up
  // before a highlight is stored from it
  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? "");
  expect(selected.trim().length).toBeGreaterThan(0);

  // The keyboard only arrives once the offer is taken
  await expect(page.getByPlaceholder("選択した文章について質問する...")).toHaveCount(0);
  await ask.tap();
  await expect(page.getByPlaceholder("選択した文章について質問する...")).toBeVisible();
});

test("adds plain and selected quick notes without exposing the wide editor", async ({ page }) => {
  const pdfId = await openTestBook(page);

  await page.getByRole("button", { name: "チャット" }).tap();
  await page.getByRole("tab", { name: "メモ" }).tap();

  const noteSheet = page.getByRole("region", { name: "チャット" });
  await expect(noteSheet).toBeVisible();
  const quickInput = page.getByRole("textbox", { name: "クイックメモ" });
  await expect(quickInput).toBeVisible();
  expect(await quickInput.evaluate((node) => node.tagName)).toBe("INPUT");
  await expect(noteSheet.locator("textarea")).toHaveCount(0);
  await expect(page.getByRole("textbox", { name: "読書メモ" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "太字" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "見出し" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "リスト" })).toHaveCount(0);

  const plainMemo = "選択なしのクイックメモ";
  await quickInput.fill(plainMemo);
  const plainSave = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/pdf/${pdfId}/note`) &&
      response.request().method() === "PUT" &&
      response.request().postData()?.includes(plainMemo) === true &&
      response.ok(),
  );
  await page.getByRole("button", { name: "メモを追加" }).tap();
  await plainSave;
  await expect(page.getByText(plainMemo, { exact: true })).toBeVisible();
  await expect(page.getByText("保存済み", { exact: true })).toBeVisible();

  const afterPlain = (await (await page.request.get(`/api/pdf/${pdfId}/note`)).json()) as {
    body: string;
  };
  expect(afterPlain.body).toContain(plainMemo);

  await page.getByRole("button", { name: "チャットを閉じる" }).tap();
  await expect(page.getByRole("region", { name: "チャット" })).toHaveCount(0);

  const selected = await dragPassage(page, page.locator(".textLayer span").first());
  expect(selected).toBe(COVER_TITLE);
  const addSelection = page.getByRole("button", { name: "メモに追加" });
  await expect(addSelection).toBeVisible({ timeout: 10000 });
  await addSelection.tap();

  await expect(noteSheet).toBeVisible();
  await expect(page.getByRole("tab", { name: "メモ" })).toHaveAttribute("aria-selected", "true");
  await expect(noteSheet.getByText(COVER_TITLE, { exact: true })).toBeVisible();

  const comment = "あとで本文と照合する";
  await quickInput.fill(comment);
  const selectionSaved = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/pdf/${pdfId}/selections`) &&
      response.request().method() === "POST" &&
      response.ok(),
  );
  const selectedNoteSaved = page.waitForResponse(
    (response) =>
      response.url().endsWith(`/api/pdf/${pdfId}/note`) &&
      response.request().method() === "PUT" &&
      response.request().postData()?.includes(comment) === true &&
      response.ok(),
  );
  await page.getByRole("button", { name: "メモを追加" }).tap();

  const selectionResponse = await selectionSaved;
  await selectedNoteSaved;
  const created = (await selectionResponse.json()) as {
    id: string;
    selectedText: string;
    pageNumber: number;
  };
  expect(created.selectedText).toBe(COVER_TITLE);
  expect(created.pageNumber).toBe(1);
  expect(created.id).not.toBe("");

  await expect(page.getByText(comment, { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "p.1" })).toBeVisible();
  await expect(page.getByText("保存済み", { exact: true })).toBeVisible();

  const book = (await (await page.request.get(`/api/pdf/${pdfId}`)).json()) as {
    selections: Array<{ id: string; selectedText: string; pageNumber: number }>;
  };
  expect(book.selections).toEqual([
    expect.objectContaining({ id: created.id, selectedText: COVER_TITLE, pageNumber: 1 }),
  ]);
  const durableNote = (await (await page.request.get(`/api/pdf/${pdfId}/note`)).json()) as {
    body: string;
  };
  expect(durableNote.body).toContain(`> ${COVER_TITLE}`);
  expect(durableNote.body).toContain(comment);
  expect(durableNote.body).toContain(`?page=1&selection=${created.id}`);
});

test("keeps the shelf shut until the password is typed", async ({ page }) => {
  // The whole reason this is deployed behind a login: the URL is public, and
  // what is behind it — the books, and the API key the answers cost — is not.
  const refused = await page.request.get("/api/pdfs", { failOnStatusCode: false });
  expect(refused.status()).toBe(401);

  await page.goto("/");
  await expect(page.getByLabel("パスワード")).toBeVisible();

  await page.getByLabel("ユーザー名").fill("demo");
  await page.getByLabel("パスワード").fill("demo");
  await page.getByRole("button", { name: "ログイン" }).tap();

  // Signed in, and still at the address that was asked for
  await expect(page.getByRole("button", { name: "PDFを追加" })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");
});
