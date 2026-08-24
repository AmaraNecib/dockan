# Test Audit — Dokan Ticket #28 (catalog search + barcodes)

- Range: `3bbad9c...bbff481` on `feat/28-catalog-search`
- Audited tests:
  - `apps/api/src/lib/catalog-search.test.ts` (new, 131 lines)
  - `apps/api/src/store/drizzle-store.test.ts` — `describe("barcodes (ticket 28)")`
  - `apps/api/src/rpc/router.test.ts` — `describe("catalog search + barcodes (ticket 28)")`
  - `tests/e2e/ticket28.spec.ts` (new)
- Sources cross-read: `apps/api/src/lib/catalog-search.ts`, `packages/contracts/src/core.ts` (`normalizeBarcode`, `normalizeTextKey`, zod schemas), `apps/api/src/store/drizzle-store.ts`, `apps/api/src/rpc/router.ts`, `apps/web/src/lib/use-barcode-scanner.ts`.
- Process: `.agents/skills/test-audit/SKILL.md`, three perspectives (edge-case hunter, coverage analyst, quality reviewer) folded into one report. Review-only run — **no source or test files were modified** (overrides the skill's "apply fixes" step).
- Evidence: `bun test src/lib/catalog-search.test.ts src/store/drizzle-store.test.ts src/rpc/router.test.ts --timeout 10000` → **56 pass, 0 fail** (140 expects, 2.58s).

---

## 1. Edge Case Hunter

### Covered well (verified, not guessed)

| Edge case | Where |
|---|---|
| Blank/whitespace-only query returns `{exact:null, matches:[]}` | `catalog-search.test.ts` `"returns empty for blank queries"` |
| Barcode length boundaries: 2 rejected, 3 accepted, 65 rejected vs 3..64 rule | `"keeps a 3-char minimum"`, `"rejects empty and over-long codes"` |
| Zero-width U+200B / soft-hyphen U+00AD junk stripped before validation | `"strips zero-width and soft-hyphen junk…"` |
| Arabic / Arabic-Indic digits rejected as barcodes (no mojibake storage) | `"rejects Arabic / IME output…"` |
| Exact-barcode excluded from `matches`; case-insensitive normalized exact | two dedicated tests |
| Tier ordering: BARCODE_PARTIAL prefix > substring > NAME > CATEGORY, including a query that hits names *and* category simultaneously | `"ranks partial-barcode prefix above…"`, `"prefix beats substring within the same partial tier"` |
| Limit applied to `matches` but not `exact` (30 items, limit 5) | `"applies the limit to matches but never to exact"` |
| Tatweel/diacritic noise in *query* (not just stored data) | `"ignores tatweel/diacritics noise in the query"` |
| Store: null barcode stays valid, set-and-clear via update, miss returns undefined, sequential duplicate → UNIQUE violation | `drizzle-store.test.ts` barcodes describe |
| Legacy migration: pre-ticket-28 `items` table without column, existing row survives, ALTER verified via PRAGMA, temp dir cleanup retried | `"migrates a legacy items table…"` |
| API seam: barcode normalization at input boundary (`" abc-123 "` → `"ABC-123"`), duplicate → `BARCODE_EXISTS`, unauthorized `catalogSearch` | `router.test.ts` ticket-28 describe |

### Missing edge cases

1. **🟠 Concurrent duplicate-barcode creates via the API race** — `router.test.ts` has exactly this race pattern for categories ("two concurrent creates … resolve as CONFLICT"), and `router.ts` `itemsCreate` wraps the barcode insert in `withTransaction` with a UNIQUE-violation catch precisely for that race, but the equivalent `Promise.allSettled` test for two simultaneous `itemsCreate` calls with the same barcode is absent. Both existing barcode-duplicate tests are strictly sequential. Risk: the race-to-CONFLICT translation for barcodes is unproven even though its sibling feature (categories) proves it. Suggested test: mirror the categories concurrency test with `barcode: "RACE-1"`.
2. **🟠 `updateItem` colliding into an existing barcode** — store test covers create-time duplicates only. Setting item B's barcode to item A's code via `updateItem` should hit the same UNIQUE constraint; nothing pins that behavior (nor any router-level translation of it to `BARCODE_EXISTS`).
3. **🟡 Duplicate-exact assumption unpinned** — `rankCatalog` keeps only the first EXACT hit ("global uniqueness guarantees at most one"); a unit test feeding two items with the same barcode would document the defensive behavior instead of relying on the DB constraint alone.
4. **🟡 Inner-whitespace barcode normalization untested** — `normalizeBarcode` strips *inner* spaces (`\s+` global) per its docstring, but tests only cover leading/trailing spaces (`"  6290123456789 "`). A `"62 90 123"` case would lock the documented behavior.
5. **🟡 Same-tier name tie-break** — the `localeCompare(…, "ar")` secondary sort inside a tier is never asserted (the prefix/substring test exercises tier-internal ordering via different tiers of match length, effectively). Minor; Arabic collation order is hard to assert meaningfully, so low priority.
6. **🟡 Zod boundary of `catalogSearchInputSchema`** — empty query (`min(1)`) and over-long query (`max(128)`) rejection through the RPC seam is untested; only the pure-function blank-query path is.

## 2. Coverage Analyst

### Acceptance-criteria mapping

- Exact-scan add/pick → covered at every layer: unit (`exact wins…`), store (`getItemByBarcode`), API seam (`finds them by exact scan`), e2e step 3 (`scan-found` contains بطارية).
- Partial/ranked search → unit tier tests + seam smoke test + e2e steps 2 (typed `6210001000017`, Arabic `زيت`, no-results message).
- Duplicate barcode protection → store UNIQUE test, API `BARCODE_EXISTS` test, e2e double-scan loop (round 2 after 900 ms is treated as fresh scan; the in-window drop is what prevents double-handling between rounds).
- Unknown-scan choices → e2e covers all three branches: cancel-creates-nothing (row count compared before/after), create prefilled with scanned barcode then rescannable, create-with-stock landing stock 7.
- Legacy DB migration → dedicated store test with real legacy DDL + data row.
- Arabic text handling → tatweel/diacritic folding unit-tested on both data and query sides; Arabic used throughout store/router/e2e fixtures.

Test diversity is good: pure-function units, sqlite store integration (incl. schema-migration fixture), typed-client-over-real-HTTP seam tests, and one Playwright journey. Little duplicated coverage; the layered repetition (same scenario at 4 layers) is intentional and each layer asserts different things (ranking math vs constraint vs wire format vs UI wiring).

### Gaps

1. **🔴→🟠 `apps/web/src/lib/use-barcode-scanner.ts` has zero direct tests.** This is the most intricate new logic (burst-gap reset at 50 ms, `SCAN_MIN_LENGTH`, duplicate window, editable-vs-window regimes, `isComposing` guard) and it is exercised only indirectly by the e2e happy path in the *non-editable* regime. Specifically untested anywhere:
   - **IME composing behavior** — `if (event.isComposing) return;` has no test at any level. An Arabic IME composing inside a field must never be swallowed or committed as a scan; a jsdom/happy-dom unit test dispatching `isComposing: true` keydowns would pin this cheaply.
   - Editable-focus burst regime: slow human typing into an input must NOT trigger scans (gap > 50 ms resets buffer) — untested.
   - In-window duplicate drop (`code === lastCommitCode && < 800ms`) is only implied by the e2e's 900 ms sleeps, never asserted positively (that an immediate re-send is dropped).
   - Window blur resetting the buffer.
2. **🟠 Item-picker dialog keyboard navigation** — `apps/web/src/components/catalog/item-picker-dialog.tsx` (121 lines) has no unit test and the e2e never opens it. Arrow-key/Enter selection, focus trap, and Escape handling are unverified.
3. **🟡 `limit` param of `catalogSearch` never passes through the seam** (unit-only coverage).
4. **🟡 No negative-path e2e for scanning while focused in an input** (the second regime of the hook).

## 3. Quality Reviewer

**Grade: A−**

- **Names/intent**: excellent — test names state the behavioral contract ("prefix beats substring within the same partial tier", "applies the limit to matches but never to exact"), and inline comments explain *why* (e.g., why the second e2e scan round waits 900 ms).
- **Assertions**: predominantly meaningful, not shallow. Exceptions: the seam ranking test (`router.test.ts` "ranks search results through the real store seam") only checks `matchedBy ∈ {allowed set}` per match without asserting order or ids — acceptable as a wire-format smoke test since the unit layer owns ranking assertions, but it is the weakest assertion in the suite. The e2e asserts concrete visible outcomes (row counts before/after cancel, prefilled barcode value, stock number in row) rather than mere visibility.
- **Async**: correct throughout — `await expect(...).rejects.toThrow(/unique/i)` patterns, no floating promises, `Promise.allSettled` used deliberately for races.
- **Isolation/cleanup**: tmp dirs with retrying removal in `finally` (Windows file-lock aware); seam tests share one authenticated app instance via `beforeAll`, which is a pragmatic trade-off documented in the header comment.
- **Brittleness risks (notes, not blockers)**:
  - e2e relies on `waitForTimeout(900)` / `(300)` sleeps coupled to `SCAN_DUPLICATE_WINDOW_MS = 800`. If the constant changes, the test silently degrades. Importing the constant (or exporting timing config) would remove hidden coupling.
  - `keyboard.type(..., { delay: 4 })` depends on the 50 ms gap threshold holding under CI load; the non-editable regime is deterministic per design, so this is mitigated, but the editable-regime tests (when added) will need the same care.
  - One monolithic 108-line e2e test rather than several scoped ones — acceptable for a single seeded journey, but a failure mid-way obscures which branch broke.

## Findings by severity

- **Blocker**: none.
- **High**: none in shipped tests; closest is the total absence of direct tests for `use-barcode-scanner.ts` (incl. IME composing guard) — rated High-Medium because the hook is new, subtle, timing-based interaction logic guarding a money-relevant workflow.
- **Medium**:
  - M1 — No concurrent duplicate-barcode API race test (categories have one; barcodes deserve parity). `router.test.ts`.
  - M2 — Update-path barcode collision (`updateItem` → existing barcode) untested at store and router levels. `drizzle-store.test.ts`.
  - M3 — Item-picker dialog keyboard navigation untested. `item-picker-dialog.tsx`.
- **Minor**: duplicate-exact-first-wins unpinned (🟡); inner-space barcode normalization untested (🟡); seam ranking assertion shallow (🟡); zod boundary of search input untested through RPC (🟡); e2e sleep constants coupled to hook constants (🟡).

## Missing-coverage list (worth flagging upstream)

1. Unit tests for `use-barcode-scanner.ts`: IME composing passthrough, editable-focus slow-typing reset, positive duplicate-drop assertion, blur reset.
2. Concurrent `itemsCreate` same-barcode race → both resolve/one CONFLICT `BARCODE_EXISTS` (mirror categories race test).
3. `updateItem` barcode collision → UNIQUE/BARCODE_EXISTS behavior.
4. Item-picker dialog keyboard nav (unit or e2e).
5. `catalogSearch` `limit` param through the RPC seam; input-schema rejection of empty/>128-char queries.
6. E2E: scan while focus is inside an input (editable regime) at least once.

## Verdict

The audited suite is strong: layered, honest assertions, real seams, real edge cases (Arabic normalization, length bounds, migration with surviving data), and the Playwright journey covers the critical user paths requested (exact scan add/pick, unknown-scan cancel/create/create-with-stock, Arabic typed search, duplicate-scan window). All 56 API tests pass. The gaps above are follow-up items, not defects in what exists.

VERDICT: PASS
