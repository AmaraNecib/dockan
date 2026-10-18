# Test audit — issue 67 (category name in items list)

**Issue:** #67. **Base:** `f4d4674`. **Head:** `1b0b20f` (final; reviewed at `2a2bbc7`,
post-review commit `1b0b20f` is the audit-recommended E2E race hardening, see
Quality reviewer note).
**Tier:** Standard. Run: 3 parallel sub-agents (edge case hunter, coverage
analyst, quality reviewer). All suite runs green: `bun test` 420 pass
(drizzle-store 60, router 132 included); `tsc --noEmit` clean; targeted E2E
`items-categories` passed.

## Edge case hunter

**Blocker:** none.

Verified safe:
- `LEFT JOIN` is 1:1 on FK `items.categoryId` — no row duplication;
  `orderBy(items.name)` preserved; `itemCols` keys don't collide with
  `categoryName`.
- Callers of `listItems` unaffected: dashboard uses `.length` only;
  `catalogSearch` passes `ItemListItem[]` into `rankCatalog(items: Item[])`
  (superset, structurally assignable) and its `catalogMatchSchema.item` is
  base `itemSchema`, so zod strips the field there — catalog output unchanged.
- create/update/barcode/low-stock paths untouched.
- Null `categoryName` passes `z.string().nullable()` — orphans never rejected.

Notes (accepted, not blockers):
- 🟠 Orphan/null branch (`categoryName: null` + `"—"` fallback) has no direct
  test. The app has no category-delete path, so an orphan is unreachable at
  the seam; creating one in a test would require raw SQL deletes, which the
  store-seam doctrine forbids (drizzle-store.test.ts header: "verified through
  StorePort ... never SQL"). LEFT JOIN + nullable is defensive only.
- 🟡 The E2E asserts the named case, not the `"—"` case — same unreachability
  rationale.

## Coverage analyst

All three acceptance criteria covered:
1. **Table shows NAME** — E2E `items-categories.spec.ts` asserts the saved row
   `toContainText(زيوت-{stamp})`; implementation removed `item.categoryId`
   entirely (items.tsx:427).
2. **API output carries name** — two seams: store (`drizzle-store.test.ts`
   `listItems()` returns `categoryName` + unchanged `categoryId`) and RPC
   (`router.test.ts` proves `categoryName` survives the orpc output schema —
   guards against zod stripping).
3. **create/update/low-stock unchanged** — no schema/method touched; 420
   pre-existing tests pass untouched.

Diversity: three tests share the create→list→assert pattern but pin three
different seams (SQL join / wire schema / rendered UI) — required, not
duplicate. No gaps needing code change.

## Quality reviewer

**Grade: A-**

Strengths: behavior-descriptive names with issue refs; complete awaits;
self-seeded isolation; assertions check exact category name AND unchanged
`categoryId`; E2E asserts the NAME, and the stamped name prevents false
positives.

Notes (actioned):
- **Medium — E2E dropdown race**: `selectOption({ label })` ran after a fresh
  `goto("/items")`; options arrive via async categories query
  (items.tsx:205, 320-327). Fixed in commit `1b0b20f` by waiting for the
  option element (`toHaveCount(1)`) before selecting; E2E re-ran green.
- Low — non-null `!` on `find` in both unit tests (bare TypeError if row
  missing); consistent with file style, no change.
- Low — nullable branch untested; accepted (see edge hunter).

## Synthesis — actions

- Fix applied: E2E option wait (`1b0b20f`).
- Rejected test ideas: orphan/null-branch tests (require raw SQL, violates
  store-seam seam doctrine; path unreachable without a category-delete
  feature).
- Evidence keyed to final HEAD `1b0b20f`; only post-review delta is the applied
  audit fix itself.