# Code review — Sale checkout (issue #30, PR #42): final follow-up

- **Head reviewed:** f4e87d1b89cca30edcd9b541bd4ea94bb9bd55a9

## This round (fresh 4/5 finding: markerless backfill vs legitimate snapshots)

Reviewed against the current HEAD (the invariant-based predicate from the
previous round). The quoted scenario — an upgraded markerless DB holding a
modern SALE line with `defaultUnitPrice = 0` and a negotiated `unitPrice > 0`
(item priced 0, owner charges more) — is **already handled**: the predicate
requires `discount_allocated = 0 AND net_total = 0`, and such a line has
`net = gross − 0 > 0` (or allocated > 0 when discounted, or unit 0 when free),
so it can never match the UPDATE. The domain fact the reviewer supplied
(pre-#30 had only PURCHASE lines since SALE was a stub; purchase unitPrice =
cost basis) is now documented in the code and confirms the invariant is exactly
the legacy row shape and exactly excludes every post-#30 row.

No behavior change was needed to the predicate; this round adds:
- code comment with the domain-fact reasoning;
- byte-identical raw-row regression (SELECT * before/after setup()) for the
  undiscounted zero-default sale line, the fully-discounted variant, and a
  modern zero-cost PURCHASE-with-explicit-price line (the only analogous
  modern corner; also protected);
- the interrupted-legacy heal assertion remains and still passes.

## Standards / smells (retained)
ADR-0005 + ADR-0002 amendment; relocated doc comment; unified
`normalizeInvoiceLegacy`; dead zod checks removed; contracts reject
conflicting/sale-only inputs; quantity capped at 1e6; anti-slop SAFETY comments
adjacent to type assertions in the migration.

## Spec axis
Complete: all six acceptance criteria have code + multi-layer tests; no
behavioural scope creep beyond documented guards.

## Verdict
Merge-safe pending parent push + Greptile re-run at the new HEAD. All gates
green: typecheck 0, lint 0, 173 API + 17 web unit tests, 10/10 worker-1 E2E.