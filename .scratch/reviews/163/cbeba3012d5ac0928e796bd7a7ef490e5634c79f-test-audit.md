# Test audit — issue #163 (Standard tier)

> **Superseded** by `f651a97…-test-audit.md` (Greptile round-1 fix delta). Kept as history.

Reviewed code SHA: `79a7e65281206875b547c2add383eae81e5e1377`
Evidence SHA (this filename): `cbeba3012d5ac0928e796bd7a7ef490e5634c79f` (adds only the wisdom note)
Base: `c0794b7a1a0e1ec0e5af0ca6bd51c1a6588a4b92` (`origin/develop`)
Tier: Standard (the feature+skill pipeline mandates test-audit for Standard too).

## Scope

Test files in the change:

- `apps/api/src/store/pagination-store.test.ts` (new)
- `apps/api/src/rpc/router.test.ts` (pagination + itemsAll/total updates)
- `apps/api/src/store/drizzle-store.test.ts`, `stock-ledger-store.test.ts`,
  `supplier-account-store.test.ts`, `supplier-account-zero.test.ts`
- `apps/web/src/lib/pagination.test.ts` (new)
- `apps/web/src/components/ui/pager.test.tsx` (new)
- `apps/web/src/pages/invoices.test.tsx`, `items.test.tsx`
- `tests/e2e/pagination.spec.ts` (new)

## Agent 1 — Edge Case Hunter

| Edge case | Status | Where |
|---|---|---|
| Empty list (`total = 0`) | covered | `pageCount(0,10) === 1`, `pageRange(0,10,0)`, Pager hidden test |
| `total === pageSize` (exact fit) | covered | Pager hidden test (`10/10`) |
| `total === pageSize + 1` | covered | `pageCount(11,10) === 2`, page-window tests |
| Offset past the end | covered | store test (`offset 10000 → 0 items, total intact`), Pager clamp test |
| `limit = 0` | covered | router test (`activitiesList({limit:0})` rejects) |
| `limit > MAX_PAGE_SIZE` | covered | router test 501 rejects; Pager custom 501 test |
| Page size off-preset / custom | covered | Pager custom-size test |
| Falling below the page boundary | covered | Pager `clampOffset` effect + unit test |
| Cumulative `stockAfter` on a later page | **was missing → added** | router test "pages the ledger without losing the cumulative stockAfter" (would have caught a slice-before-projection bug) |
| Expenses sorted then sliced | **was missing → added** | router test "pages expenses after the sort, keeping the total stable" |
| Duplicate rows across pages | covered | store tests assert the two pages are disjoint and cover the created ids |

No remaining 🔴/🟠 findings. The two added tests are the only fixes.

## Agent 2 — Coverage Analyst

Acceptance criteria → test:

1. **One envelope `{limit,offset} → {items,total}`** — store tests cover
   items/invoices/activities/returns/supplier returns; router covers
   items/expenses/history. ✅
2. **Default page size 10** — `parsePageSize(undefined) === 10`, `resolvePagination`
   applied in every router handler, e2e asserts 10 rows on a 17-row list. ✅
3. **Pager hidden at `total <= pageSize`** — Pager test + e2e. ✅
4. **Presets 20/25/50/100 + «مخصّص…»** — Pager tests (preset click, custom apply,
   invalid refuse). ✅
5. **«عرض X–Y من Z»** — `pageRange` unit tests + e2e range text. ✅
6. **Offset resets on filter/search change** — `paginationReducer` reset unit test,
   invoices e2e filter reset, invoices page filter handlers call `reset()`. ✅
7. **Page size persists** — `usePreference` encoding unit test + e2e reload. ✅
8. **Supplier account entries pagination** — ❌ deferred (see code-review spec axis).

Tests are diverse (pure math, store SQL, component, e2e), not one repeated
pattern. No duplicate coverage found.

## Agent 3 — Quality Reviewer

- Names describe the rule ("returns to the first page on a search or filter
  change", "pages the ledger without losing the cumulative stockAfter").
- Async handling is `await`-correct; no floating assertions.
- Setup duplication: the store pagination test uses `beforeAll` + local
  factories; acceptable.
- Assertions are specific (ids, amounts, offsets), never "does not throw".
- Isolation: the new store test uses its own temp database, so it cannot be
  polluted by the shared store tests.

**Grade: A.**

## Verdict

No unaddressed findings. `bun run typecheck`, `bun run lint`, `bun run test`
and `bun run test:e2e` (52 passed) are green at the reviewed SHA.
