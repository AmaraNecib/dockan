# Code review — issue #181 review-fix round 1 (final)

Base: `fc95113` · Final head: `9bdb8c8` · Tier: **High-assurance**
Method: `code-review` — Standards and Spec axes, plus a doc-vs-code audit and a
rebase-resolution audit after the branch merged `#174`.

## Standards

No hard code violations in the delta (docs/comments + tests). Judgement calls dismissed:
the redundant re-trim in `adjustmentDedupKey` (the shared predicate makes the two trims
provably identical), the string-matched `isUniqueViolation` (already scoped to
`supplier_account_entries.dedup_key` and test-pinned), and the `AdjustmentDedupInput & {
ref }` review probe (deliberate).

Fixed in this round:

- ADR-0011 title read as key-replaces-signature → now "the signature, plus the client's
  key when sent".
- ADR "written by the one guarded write path" ignored the raw `insertSupplierEntry` seam →
  now names both writers.
- ADR index sentence implied the index never covers two identical unkeyed requests →
  clarified: identical `sig:` keys are index-covered; only a different-key or keyed-vs-
  signature duplicate falls to the guard.
- ADR option (C) said the timestamp is "not stored per row", contradicting the shipped
  `sig:[…, null]` → reworded as a query-time wildcard the raw-column index cannot express.
- ADR stored-key claim was unconditional → qualified for legacy (backfilled time-inclusive)
  vs rows written since v4.
- `hasSupplierAdjustment` keyed-retry clause was unconditional → now "while its signature
  is unchanged".
- Two `router.ts` comments and the design §Interfaces/base header → corrected at `9bdb8c8`.

## Spec

No missing or partial requirements. Both issue gaps are implemented and tested: the
optional `idempotencyKey` with the changed-timestamp retry refused, and the partial unique
index with the v3→v4 self-healing migration and older-build refusal. The bulk-vs-manual
overlap is kept, no money invariant is weakened, and the design/ADR state the exact
key-vs-signature composition. The one hard contradiction found in the delta review (design
Planned-tests "a key change with the same signature is allowed") was corrected to "still
refused".

## Doc-vs-code audit at the rebased HEAD

Every substantive claim about adjustment duplicates (key forms, key arm, signature arm,
`ref` exclusion, `occurredAt`/`serverStamped` handling, index scope, backfill self-heal,
version gate, error mapping) holds against `adjustmentDedupKey`, `hasExplicitIdempotencyKey`,
`adjustmentSignatureConditions`, `hasSupplierAdjustment`, and the migration code.

## Rebase-resolution audit

#174 (paged party-detail reads) and #181 (adjustment dedup) coexist with no lost code: the
paged `partyInvoices`/`partyPayments`/`supplierEntries` are wired end-to-end and the money
path still reads the full `listSupplierEntries`/`partyDetail`; #181's key/migration/guard
are intact; the shared select helpers keep full vs paged behavior. The `router.test.ts`
conflict kept both describes and exactly one `setupSupplier`.

## Summary

- Standards: 7 findings — all fixed (docs/comments); no code defects.
- Spec: 0 missing, 0 wrong; the one delta contradiction fixed.
- Worst per axis: none outstanding.

## Gates

- `bun install` 0; `bun run lint` 0; `bun run typecheck` 0; `bun run test` 0 (848 web + api);
  `bun run test:e2e` 0 (55 passed).
