# Code review — issue #176, Greptile round-1 fix

Reviewed SHA: `a7e7f7e`. Standards + Spec axes, two rounds.

## Standards

No documented-standard violation. Judgement-call smells:

- Web `supplierEntrySign` (`apps/web/src/lib/supplier-entry-display.ts`) is a
  third mirror of the kind→sign rule (api pure helper + SQL helper). It is
  display-only and documented; the natural single home is `@dokan/contracts`.
- The query-key prefixes (`apps/web/src/lib/query-keys.ts`) are literal path
  prefixes. They are now outside `@/lib/rpc` (which tests mock wholesale) and
  the shape is pinned by a unit test.
- The three-key invalidation block is duplicated in the panel and the bulk page;
  a shared `invalidateSupplierMoneyQueries` helper would consolidate it (also
  fixes the sibling panels).

## Spec — the six PR #178 findings

1. **Bulk row filter** — fixed: a tolerant reader plus explicit
   `untouched | invalid | filled` / `incomplete | duplicate` states; an invalid
   or incomplete draft blocks the save with a row error instead of being
   dropped. ✔
2. **Invoice auto-switch** — fixed: the stored selection is never replaced; a
   lost selection shows «لم تعد مفتوحة» and blocks. ✔
3. **Dashboard `weOwe`** — fixed: the signed supplier ledger plus typed-only
   purchase remainders, matching the `/debts` supplier total; the customer side
   is unchanged. ✔
4. **Batch limit** — fixed: `isOpeningBatchOverLimit` (exactly 200 allowed),
   shown and disabled before saving. ✔
5. **Query keys** — fixed: `reportsDebts`, `debtsByParty`, `dashboardSummary`,
   plus the list/activity families, now use real generated keys/prefixes. ✔
6. **Opposite adjustments** — fixed: the `/debts` account table shows the signed
   amount and the direction word via the shared helper. ✔

No unintended behavior change, no scope creep. The `party-detail` refactor to
the shared helper is a pure dedup with identical labels.

## Deferred (non-blocking)

- Adopt `query-keys.ts` / a shared invalidation helper in the sibling panels
  outside this diff (pre-existing dead flat keys).
- Consolidate the sign rule into `@dokan/contracts`.
- Align the null-direction ADJUSTMENT handling (unreachable via the store seam).
