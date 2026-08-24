# Code Review — Ticket #28 (catalog search + barcode scanning)

- Diff: `git diff 3bbad9c...bbff481` (merge-base comparison), branch `feat/28-catalog-search`
- HEAD reviewed: `bbff4815c7b53057977ba62cff1bc0130002e96a`
- Feature commit: `bbff481` (the range also contains skill/doc/vendor commits `8a311e8`, `3e9cbdb`; reviewable source files are listed below)
- Spec source: GitHub issue `gh issue view 28`
- Standards sources: `docs/engineering-workflow.md`, `docs/adr/0003-store-port-sqlite-first.md`, `docs/adr/0004-rbac-wildcard-permissions.md`, plus the Fowler smell baseline from `.agents/skills/code-review/SKILL.md`

## Standards

### Conformance to documented standards

- **ADR-0003 (store port)** — satisfied. The new capability enters through the port (`apps/api/src/store/port.ts:39` adds `getItemByBarcode`); only the sqlite/drizzle adapter implements it (`apps/api/src/store/drizzle-store.ts:254-256`). Router and ranking code depend on the port and the pure lib, not on drizzle. Legacy-schema handling lives in the adapter's `setup()` (`ensureItemsBarcodeColumn`, drizzle-store.ts:202-212), matching the existing `rebuildLegacyAuthTables` pattern.
- **ADR-0004 (RBAC reserved)** — satisfied. No per-procedure permission logic was scattered into handlers; the existing single-admin session guard (`guardedInput`) remains the one enforcement point exactly as the ADR prescribes until real RBAC lands.
- **Engineering workflow** — evidence path convention followed by this report (`.scratch/reviews/<issue-id>/<head-sha>-<gate>.md`). Checks run below.

### Smell baseline (all judgement calls; no repo standard overrides them)

- **Duplicated Code** (minor) — `apps/api/src/rpc/router.ts`: the identical try/catch mapping `isUniqueViolation → ORPCError CONFLICT BARCODE_EXISTS` appears three times (itemsCreate ~L120-135, itemsCreateWithStock ~L139-158, itemsUpdate ~L161-185). Extract a `withBarcodeConflict(fn)` wrapper so a future change (e.g. also mapping FK violations) touches one site.
- **Duplicated Code** (minor) — `apps/web/src/pages/items.tsx` (CatalogSearch component): re-inlines `` t(`matchedBy${match.matchedBy.charAt(0)}${match.matchedBy.slice(1).toLowerCase()}`) `` even though `matchBadgeKey` is exported from `apps/web/src/components/catalog/item-picker-dialog.tsx:17`. The 150 ms debounce effect is also duplicated verbatim between `CatalogSearch` and `ItemPickerDialog`. Import `matchBadgeKey` and consider extracting a `useDebounced(value)` hook.
- **Primitive Obsession** (very minor) — i18n keys derived by string-mangling the `matchedBy` enum (`matchedBy${...}`) rather than a small lookup map; works today but breaks silently if an enum member is added without adding the translation key.
- No Mysterious Name / Feature Envy / Speculative Generality concerns: names are domain-honest (`rankCatalog`, `requireBarcode`, `UnknownScanDialog`), and the two-tier internal `Tier` vs external `matchedBy` split in `catalog-search.ts:19-37` is justified by its doc comment (BARCODE_PREFIX/BARCODE_CONTAINS collapse to one output kind).

### Minor hygiene

- `apps/api/src/rpc/router.ts` ends without a trailing newline (`\ No newline at end of file`).

## Spec

Checked against each acceptance criterion of issue #28:

1. **Optional loose normalized ASCII barcode with global uniqueness; uncoded items remain valid** — satisfied. `barcodeSchema` (printable ASCII `\x21-\x7E{3,64}`, trimmed) is `.nullable()`/`.optional()` on item/create/update schemas (`packages/contracts/src/core.ts:47-52, 91-93, 220-236`); global uniqueness via `CREATE UNIQUE INDEX idx_items_barcode` (`apps/api/src/db/schema.ts:165`) — SQLite UNIQUE permits multiple NULLs, so uncoded items coexist. Legacy DBs get the column via `ensureItemsBarcodeColumn` PRAGMA check + ALTER (`drizzle-store.ts:202-212`). Tested: `drizzle-store.test.ts:99` ("round-trips a barcode; uncoded items stay valid"), `:118` (duplicate rejected), `:127` (legacy migration).
2. **Search exact barcode first, then partial barcode, then normalized name/category** — satisfied. `rankCatalog` (`apps/api/src/lib/catalog-search.ts`) ranks EXACT → BARCODE_PREFIX → BARCODE_CONTAINS → NAME → CATEGORY; exact is reported through `exact` and excluded from `matches`. Arabic normalization shared via `normalizeTextKey` (strips tatweel `\u0640` and diacritics). Tested exhaustively in `catalog-search.test.ts` including case-insensitive exact match, prefix-beats-substring, Arabic category names, limit semantics.
3. **Manual catalog picker using the same search behavior** — satisfied. `ItemPickerDialog` calls the same `orpc.catalogSearch` procedure with ranked matches + kind badges. *Note:* in `items.tsx` the page-level usage passes `onSelect={() => setPickerOpen(false)}` — the selected item is discarded. Acceptable as a stub until the invoice/sale flow (#30) consumes it, but the picker currently has no observable effect on the Items page beyond closing.
4. **USB wedge capture at window level, burst buffering, duplicate protection** — satisfied. `use-barcode-scanner.ts`: single window keydown listener (no input focus required), editable-focus regime uses inter-key gap timing (`SCAN_MAX_GAP_MS = 50`) with buffer reset on gaps, non-editable regime commits every burst deterministically, duplicate suppression within 800 ms, blur resets the buffer, Enter is prevented from submitting forms, `isComposing` guards IME. Judgement-call edge cases (non-blocking): modifier chords (e.g. Ctrl+C) still append their printable key to the buffer while focus is non-editable; Escape does not clear a half-typed buffer. Both would need an unlikely coincidence with a ≥3-char burst to matter.
5. **Unknown scans offer create / create+stock / manual line / cancel; nothing silently created** — satisfied. `handleScan` (items.tsx) falls back to `setUnknownCode(code)` on any non-exact result or error; `UnknownScanDialog` presents exactly the four paths; create/create-with-stock prefill the form for explicit submit (never auto-create); manual line shows an honest deferral toast tied to #30. `itemsCreateWithStock` creates item + initial stock atomically through the existing transaction seam and is tested (`router.test.ts:244`).
6. **API, UI, scanner-path, Arabic/IME-safe test coverage** — satisfied. Unit: `catalog-search.test.ts` (normalization incl. rejecting Arabic/IME output as mojibake, tatweel/diacritic folding); store: barcode round-trip/uniqueness/migration; router: session guard, normalized-barcode create, `CONFLICT BARCODE_EXISTS` race mapping, ranking through the real store seam; E2E: `tests/e2e/ticket28.spec.ts`.

### Requirements implemented but possibly short of intent

- Issue "What to build": *"Exact barcode matches add immediately"* — on the Items page an exact scan only surfaces a found notice (`scanFoundItem`); there is no cart/invoice context yet, so "add immediately" cannot be demonstrated here. This is consistent with the invoice flow being deferred (#30) and the dialog copy saying so explicitly, but the acceptance checkbox should not be ticked end-to-end until #30 wires consumption. Tagged as a residual risk, not a defect in this diff.

No scope creep found beyond shadcn/ui primitives and loading skeletons introduced by the prerequisite commit `3e9cbdb` (already merged into the range before the feature commit; UI-consistent, RTL-aware).

## Verification run

- `bun test src/lib/catalog-search.test.ts src/store/drizzle-store.test.ts src/rpc/router.test.ts --timeout 10000` in `apps/api`: **56 pass, 0 fail** (140 expect calls, 3.01 s).
- Source files were not modified during this review.

## Findings summary

| Severity | Location | Finding |
| --- | --- | --- |
| Blocker | — | none |
| Note | apps/api/src/rpc/router.ts (~L120, L139, L161) | triplicated unique-violation→CONFLICT try/catch; extract helper (judgement call) |
| Note | apps/web/src/pages/items.tsx (CatalogSearch) | duplicates `matchBadgeKey` inline + debounce logic shared with ItemPickerDialog (judgement call) |
| Note | apps/web/src/pages/items.tsx | picker `onSelect` discards the chosen item — intentional stub pending #30 |
| Note | apps/web/src/lib/use-barcode-scanner.ts | modifier-chord chars can enter the buffer; Escape doesn't reset buffer (minor edge cases) |
| Note | apps/api/src/rpc/router.ts (EOF) | missing trailing newline |
| Residual risk | overall | "exact match adds immediately" is only demonstrable once ticket #30 provides an invoice/cart consumer |

## Verdict

VERDICT: PASS
