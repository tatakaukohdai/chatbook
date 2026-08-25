# Reading Notes Phase 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** PDF の選択箇所を読書メモへ挿入し、狭い画面では選択付き・選択なしのクイックメモを、競合で文章やハイライトを失わず保存できるようにする。

**Architecture:** Phase 1 の `useNoteSession` を唯一のメモ書き込み口として維持する。広い画面の挿入は現在のローカル本文へ適用して既存の自動保存・3-way merge に流し、狭い画面の追記は再適用可能な intent として session に保持し、409 時に最新サーバ本文へ同じ追記を適用する。selection はメモより先に一度だけ保存し、返った id を Markdown リンクと再試行状態に保持する。

**Tech Stack:** React 19、TypeScript、Jotai、SWR、neverthrow、Vitest/jsdom、Playwright、Cloudflare Workers/D1。

**Spec:** `docs/superpowers/specs/2026-08-23-reading-notes-design.md`

## Global Constraints

- メモは本ごとに 1 枚の Markdown 文書であり、メモから LLM へ送る経路は作らない。
- 広い画面の textarea 自由編集・PDF 挿入は現在のローカル本文へ適用し、サーバへ別の `PUT` を投げない。
- 狭い画面には自由編集 textarea を置かず、プレビューと 1 行クイック入力だけを置く。
- selection を先に保存し、メモ保存失敗後の再試行で同じ selection id を使う。ハイライトを増殖させない。
- 狭い画面の位置非依存追記は 409 の最新本文へ再適用する。再試行には `MAX_CONFLICT_RETRIES = 3` の上限を持つ。
- クイックメモは末尾側のコードフェンス外 H2 だけを調べ、最後の `## AI とのやりとり` の直前が `## メモ` の場合だけそこへ積む。それ以外は過去の同名見出しを探さず、新しい `## メモ` を末尾に作る。
- 引用リンクは `<sup>[p.N](?page=N&selection=<id>)</sup>` とし、プレビューでは既存のページ移動・ハイライト表示経路へ渡す。
- `useEffect` をデータ取得や状態コピーのために追加しない。必要な外部同期には既存ルールどおり理由コメントを付ける。
- `vp` を使い、生の `vite` / `vitest` は直接実行しない。
- git コマンドは実行せず、各タスク完了時にユーザーへコミット候補を提示する。

---

### Task 1: Markdown 挿入の純粋関数

**Files:**

- Create: `src/front/lib/noteInsertion.ts`
- Create: `src/front/lib/noteInsertion.test.ts`

**Interfaces:**

- Consumes: `CreatedSelection` の `id` / `selectedText` / `pageNumber`。
- Produces:
  - `type TextRange = { start: number; end: number }`
  - `type NoteInsertion = { body: string; range: TextRange }`
  - `formatSelectionNote(selection, comment?): string`
  - `insertNoteMarkdown(body, markdown, range?): NoteInsertion`
  - `appendQuickNote(body, entry): string`

- [ ] **Step 1: 引用とキャレット挿入の失敗テストを書く**

  `noteInsertion.test.ts` に、複数行の各行が `> ` になること、空の補足を省くこと、URL が `?page=42&selection=<encoded-id>` になること、指定 range を置換して返却 range が挿入直後に畳まれること、range が無い場合は本文末尾へ空行を正規化して追加することを書く。

- [ ] **Step 2: 対象テストが未実装で失敗することを確認する**

  Run: `./node_modules/.bin/vp exec vitest run src/front/lib/noteInsertion.test.ts`
  Expected: import または関数未定義で FAIL。

- [ ] **Step 3: 引用整形と range 挿入を最小実装する**

  `formatSelectionNote` は引用、任意 comment、`<sup>` リンクを空行で区切る。`insertNoteMarkdown` は `range` を `0..body.length` に丸め、未指定時は末尾へ追加し、既存本文と挿入片の境界を 2 改行に正規化する。

- [ ] **Step 4: 末尾 `## メモ` 判定の失敗テストを書く**

  次を網羅する: 空本文、新規節、末尾の既存メモ節、末尾 AI 節直前のメモ節、過去にだけある同名見出し、コードフェンス内の見出し、CRLF、末尾改行なし、連続空行。

- [ ] **Step 5: Markdown の末尾構造を読む最小実装を追加する**

  コードフェンスの開閉を行単位に追い、フェンス外 H2 の位置だけを集める。対象節が末尾規約に合わなければ `## メモ` を末尾に作る。入力の改行コードは維持する。

- [ ] **Step 6: Task 1 のテストを緑にする**

  Run: `./node_modules/.bin/vp exec vitest run src/front/lib/noteInsertion.test.ts`
  Expected: 全件 PASS。

- [ ] **Step 7: ユーザー向けコミット候補を記録する**

  Suggested commit: `feat: add note insertion rules`

---

### Task 2: Note session のローカル挿入とクイック追記 intent

**Files:**

- Modify: `src/front/hooks/useNoteSession.ts`
- Modify: `src/front/hooks/useNoteSession.test.tsx`
- Modify: `src/test/noteSession.ts`

**Interfaces:**

- Consumes: Task 1 の `TextRange`、`insertNoteMarkdown`、`appendQuickNote`。
- Produces `NoteSession` 追加 API:
  - `insert(markdown: string, range?: TextRange): NoteInsertion`
  - `appendQuick(entry: string): Promise<boolean>`
  - `retryQuickAppend(): Promise<boolean>`
  - `quickAppendError: string | null`
  - `quickAppending: boolean`

- [ ] **Step 1: ローカル挿入の失敗テストを書く**

  現在の `stateRef.current.body` に対して挿入すること、保存中に本文が変わっても古い render の `body` で上書きしないこと、広い画面では既存ドラフト鏡写しと通常の debounce 保存へ流れることを偽タイマーで書く。

- [ ] **Step 2: ローカル挿入テストが API 不在で失敗することを確認する**

  Run: `./node_modules/.bin/vp exec vitest run src/front/hooks/useNoteSession.test.tsx`
  Expected: `insert` 不在で FAIL。

- [ ] **Step 3: `insert` を既存 `commit` 上へ実装する**

  `stateRef.current` を読み、Task 1 の純粋関数で次本文を作り、`statusFor` と `commit` を通す。返した range は NotePane が textarea のキャレット復元に使えるようにする。

- [ ] **Step 4: 位置非依存 append の競合テストを書く**

  次を偽タイマーと deferred `SaveNote` で検証する: 最初の PUT はローカル本文、409 後は `current.body` へ同じ entry を再適用、PUT は常に直列、3 回で停止、ネットワーク失敗で intent と入力を保持、retry は同じ intent を再送、成功時だけ pending/error を消す。

- [ ] **Step 5: quick append intent を既存 single-flight 状態機械へ統合する**

  pending intent を ref に保持し、quick append 中の 409 は `mergeNoteBodies` ではなく `appendQuickNote(failure.current.body, entry)` を使う。成功時は server base/body/version を進め、通常の未保存自由編集が同時にあれば消さずに既存 queue へ戻す。

- [ ] **Step 6: narrow draft 契約の回帰テストを確認する**

  狭い画面で quick append が新しい localStorage draft を作らないこと、広い画面で既に作った draft を狭くしても消さない既存テストを残す。

- [ ] **Step 7: Task 2 の対象テストを緑にする**

  Run: `./node_modules/.bin/vp exec vitest run src/front/hooks/useNoteSession.test.tsx`
  Expected: 全件 PASS。

- [ ] **Step 8: ユーザー向けコミット候補を記録する**

  Suggested commit: `feat: add reliable quick note appends`

---

### Task 3: Selection を一度だけ保存するメモ入口

**Files:**

- Create: `src/front/hooks/useStoreSelection.ts`
- Create: `src/front/hooks/useStoreSelection.test.tsx`
- Modify: `src/front/hooks/useAskAboutSelection.ts`
- Modify: `src/front/components/PdfViewer/PdfViewer.tsx`
- Modify: `src/front/components/PdfViewer/PdfViewer.test.tsx`
- Modify: `src/front/components/PdfViewer/SelectionActionBar.tsx`
- Modify: `src/front/components/PdfViewer/SelectionPopover.tsx`

**Interfaces:**

- Consumes: existing `SelectionDraft`、`SaveSelection`、`CreatedSelection`、`useHighlights.addHighlight`。
- Produces:
  - `useStoreSelection(addHighlight, saveSelection?)`
  - `store(pdfId, draft): ResultAsync<CreatedSelection, ApiError>`
  - `PdfViewerProps.onAddSelectionToNote(selection: CreatedSelection): void`
  - `PdfViewerProps.onPrepareSelectionQuickNote(draft): void`

- [ ] **Step 1: selection 保存共通 hook の失敗テストを書く**

  成功時に `addHighlight` が一度だけ呼ばれること、失敗時に呼ばれないこと、in-flight 中の同一送信を UI が二重開始しないため Result を呼び出し元へ返すことを書く。

- [ ] **Step 2: テストが hook 不在で失敗することを確認する**

  Run: `./node_modules/.bin/vp exec vitest run src/front/hooks/useStoreSelection.test.tsx`
  Expected: import 不在で FAIL。

- [ ] **Step 3: selection 保存を抽出し、質問 hook を同じ経路へ載せ替える**

  現在 private の `storeSelection` と highlight 追加だけを共通化する。チャット atom 更新とストリーム開始は `useAskAboutSelection` に残す。

- [ ] **Step 4: PdfViewer のメモ操作の失敗テストを書く**

  広い画面の `SelectionPopover` と touch/narrow の `SelectionActionBar` に「メモに追加」が出ること、広い画面は保存完了後だけ callback を呼ぶこと、失敗時は選択 UI と理由を残すこと、二重送信で selection POST が一回であること、タブレット幅の touch でも action bar を通ることを書く。

- [ ] **Step 5: 広い画面と狭い画面の分岐を実装する**

  広い画面は selection を即保存して `onAddSelectionToNote` へ `CreatedSelection` 相当を渡す。狭い画面はまだ保存せず `onPrepareSelectionQuickNote` に完全な `SelectionDraft` を渡し、NotePane の一行入力で確定する。selection snapshot は成功または明示 dismiss まで保持する。

- [ ] **Step 6: Task 3 の対象テストを緑にする**

  Run: `./node_modules/.bin/vp exec vitest run src/front/hooks/useStoreSelection.test.tsx src/front/components/PdfViewer/PdfViewer.test.tsx`
  Expected: 全件 PASS。

- [ ] **Step 7: ユーザー向けコミット候補を記録する**

  Suggested commit: `feat: add selection-to-note actions`

---

### Task 4: BookReader・NotePane・ChatArea の統合

**Files:**

- Modify: `src/front/pages/AppPage.tsx`
- Modify: `src/front/pages/AppPage.test.tsx`
- Modify: `src/front/components/NotePane/NotePane.tsx`
- Modify: `src/front/components/NotePane/NotePane.test.tsx`
- Modify: `src/front/components/ChatArea/ChatArea.tsx`
- Modify: `src/front/components/ChatArea/ChatArea.test.tsx`

**Interfaces:**

- Consumes: Task 1 formatter、Task 2 session API、Task 3 PdfViewer callbacks、既存 `rightPaneTabAtom` / `chatPanelOpenAtom` / `chatSheetAtom`。
- Produces:
  - `revealNote()` orchestration in `BookReader`
  - narrow quick-note input in `NotePane`
  - note preview internal-link callback using existing `onSelectionClick`

- [ ] **Step 1: wide 統合の失敗テストを書く**

  selection 保存成功後に現在の未保存本文へ挿入し、記録済み textarea range があればそこ、無ければ末尾へ入ること、メモタブへ切り替え、畳まれた右ペインを開くことを書く。selection 保存失敗時は本文・タブ・ペインを変えない。

- [ ] **Step 2: narrow quick input の失敗テストを書く**

  狭い画面では自由編集 textarea と書式ツールバーが無く、`aria-label="クイックメモ"` の1行入力があること、Enter/ボタンで選択なし entry を送ること、選択付き pending draft が引用として表示されること、失敗時は入力と pending selection を残し、成功時だけ消すことを書く。

- [ ] **Step 3: BookReader に caret と pending selection を集約する**

  NotePane から最後の textarea range を BookReader へ報告する。wide callback は selection 保存後の最新 session 本文へ `note.insert` し、narrow callback は draft を pending に置いて note を表示する。`revealNote` は wide で `rightPaneTabAtom="note"` + `chatPanelOpenAtom=true`、narrow で同 tab + `chatSheetAtom closed→half` とする。

- [ ] **Step 4: narrow quick submit を実装する**

  選択なしは comment を entry として `note.appendQuick`。選択ありは selection を一度保存し、Task 1 の `formatSelectionNote(selection, comment)` を entry として `note.appendQuick`。note 側失敗後の retry は `retryQuickAppend` だけを呼び、selection 保存を繰り返さない。

- [ ] **Step 5: note preview の内部リンクを既存ナビゲーションへ接続する**

  `?page=N&selection=id` だけを横取りし、現在の `book.selections` から該当 selection を解決して `onSelectionClick` へ渡す。通常の Web URL は既存 anchor のままにする。URL の直接書き換えや `setSearchParams` の新しい書き手は作らない。

- [ ] **Step 6: Task 4 の対象テストを緑にする**

  Run: `./node_modules/.bin/vp exec vitest run src/front/components/NotePane/NotePane.test.tsx src/front/components/ChatArea/ChatArea.test.tsx src/front/pages/AppPage.test.tsx src/front/components/PdfViewer/PdfViewer.test.tsx`
  Expected: 全件 PASS。

- [ ] **Step 7: ユーザー向けコミット候補を記録する**

  Suggested commit: `feat: integrate PDF passages with notes`

---

### Task 5: E2E・回帰検証・開発者文書

**Files:**

- Modify: `e2e/chatbook.spec.ts`
- Modify: `e2e/mobile.spec.ts`
- Modify: `e2e/tablet.spec.ts`
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`

**Interfaces:**

- Consumes: completed Phase 2 UI and existing `openTestBook` / selection helpers。
- Produces: deterministic shared-fixture reset、desktop/mobile/tablet acceptance coverage、maintenance rules。

- [ ] **Step 1: E2E fixture の note reset を全 project へ揃える**

  `mobile.spec.ts` と `tablet.spec.ts` の `openTestBook` に、既存 desktop の `clearNote` と同じ version-aware reset を追加する。本文が変わった場合だけ reload し、session の version をサーバと揃える。

- [ ] **Step 2: desktop E2E を追加する**

  実ドラッグ選択から「メモに追加」を押し、editor の記録済みキャレットへ引用が入り、保存後 reload して残ること、プレビューの `p.N` から元 selection を開けることを書く。

- [ ] **Step 3: mobile E2E を追加する**

  メモシートの1行入力で通常クイックメモを追加でき自由編集 textarea が無いこと、選択後の action bar から選択付きクイックメモへ進み、メモタブ/シートが開き引用が保存されることを書く。

- [ ] **Step 4: tablet E2E を追加する**

  1024px + touch の既存選択 helper を使い、action bar の「メモに追加」から wide editor の本文へ引用が入ることを書く。幅で pointer type を推測する退行を検出する。

- [ ] **Step 5: Phase 2 の保守規約を文書化する**

  `AGENTS.md` と `CLAUDE.md` の読書メモ節へ、selection-first、wide local insertion、narrow rebase intent、selection id の再利用、内部リンクの既存ナビゲーション利用、E2E note reset を追記する。

- [ ] **Step 6: 全検証を実行する**

  Run:
  - `./node_modules/.bin/vp exec vitest run`
  - `./node_modules/.bin/vp exec vitest run -c vitest.workers.config.ts`
  - `./node_modules/.bin/vp check`
  - `./node_modules/.bin/vp build`
  - `pnpm run test:e2e --project=desktop`
  - `pnpm run test:e2e --project=mobile`
  - `pnpm run test:e2e --project=tablet`

  Expected: 全コマンド exit 0。Worker/E2E が sandbox のローカル待受を必要とする場合は権限付きで同一コマンドを再実行する。

- [ ] **Step 7: ユーザー向けコミット候補を記録する**

  Suggested commit: `feat: complete reading notes phase 2`
