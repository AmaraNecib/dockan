# Design: #231 round 3 — close the two remaining Greptile findings on the CI selection PR

**Tier:** Standard — CI workflow, selection logic, map, guard tests and docs; no
money, auth, backup or schema path. Standard gates (guard 1 → quality check →
test-audit → code-review → guard 2) apply; debate is not required.

**Base:** PR #231 head `b7c0bd9` (branch `ci-e2e-selection`, rebased onto
`develop` @ `1ea76b5`). This round is a delta on top of that head; the reviewed
diff is `b7c0bd9..HEAD`, and the full PR diff remains `origin/develop...HEAD`.

**Authority:** lane commits, does NOT push and does NOT merge.

## Problem

Greptile re-reviewed #231 at `b7c0bd9`, scored it 4/5, and re-listed 8 findings
while stating 6 are echoes it is not re-raising ("None was re-reported"). Only
two are actionable on this head:

1. **The path -> spec map still omits specs, third round of the same class.**
   - `debts.tsx` omits `supplier-adjustment.spec.ts` (the supplier-credit checks
     at lines 162-167 drive `/debts`).
   - `activity.tsx` omits `backups.spec.ts` (the backup-filename check at lines
     39-42 drives `/activity`).
   - `sale.tsx` omits `items-flow.spec.ts` (zero-price quick-add) and
     `customer-name-variants.spec.ts` (the party-picker warning).
   A change to one of those pages can pass PR checks without running the browser
   check that covers it; the regression only appears in the post-merge full run.
2. **The build-location wording is misleading.** `docs/ci.md` says the production
   `vite build` "moved into `checks`". It did not: `rust` still runs the same
   build at its own step because Cargo needs `apps/web/dist`. The wording invites
   a future cleanup to delete a build Cargo requires.

## The policy change (finding 1)

Hand-enumerating "which specs does this page reach" has now been wrong three
times. The round-3 fix therefore does both:

- **Widen** the three rows and add a mutation-visible regression case per row
  (the previous rounds' cases are the reason the auditor could see them fail).
- **Promote** to `always_full` every page that is imported by another page or a
  shared component, or that renders a component another feature's rule drives.
  The map records the promotion with its reason; `docs/ci.md` records it as a
  cost decision so the next reader can argue with it.

The invariant the promotion preserves is the design's own: **an unknown path
costs minutes, never coverage.** Widening alone would leave the next unreached
spec for round four; promotion makes the page's whole spec surface run.

Promoted in this round (6 pages):

| page | why |
| --- | --- |
| `apps/web/src/pages/stock.tsx` | imported by `items.tsx` as `StockForm`, so it is a component for another page |
| `apps/web/src/pages/items.tsx` | renders `StockForm` (imported from `stock.tsx`) and the shared catalog picker |
| `apps/web/src/pages/sale.tsx` | renders the shared catalog and parties pickers, whose specs live in the catalog/parties rules |
| `apps/web/src/pages/purchase.tsx` | renders the same shared pickers plus the invoice `InvoiceHeader` |
| `apps/web/src/pages/parties.tsx` | renders the shared `components/parties` forms |
| `apps/web/src/pages/party-detail.tsx` | renders the `components/parties` supplier panels that `supplier-adjustment.spec.ts` drives |

Cost: those six pages now run the full suite on any edit. That is deliberate —
they are the pages a cross-feature spec reaches, which is exactly where
enumeration kept failing. (Round 2 already made `components/catalog/**`,
`components/parties/**` and `vault-gate.tsx` critical for the same reason.)
Pages examined and left as feature rules: `invoice.tsx` (its rule already carries
`returns.spec.ts` for `ReturnsPanel` and `purchase-intake.spec.ts` for
`InvoiceHeader`) and the pages whose components only they render.

## Interfaces

No production API change. The changed seams are:

- `tests/e2e-selection.map.json` — the widened rows and the six `always_full`
  promotions above.
- `.github/workflows/ci.yml` — the misleading "only PR-time `vite build`"
  comment above the `checks` build is corrected too, so it cannot invite deleting
  the build `rust` still needs.
- `scripts/e2e-selection.test.ts` — one regression case per widened row plus the
  promoted-page assertions and a guard that no feature rule is fully shadowed by
  a promotion; the existing exact-list assertions for `debts.tsx` are updated.
- `docs/ci.md` — the build wording correction and the promotion table.

`scripts/e2e-selection.ts` and the workflow's job graph are unchanged: the
selector already implements `always_full -> features -> skip_e2e -> full`, and
the two findings need no workflow edit.

## Planned tests

- `bun run test` runs `scripts/e2e-selection.test.ts`. New cases:
  - `debts.tsx` selects `supplier-adjustment.spec.ts`.
  - `activity.tsx` selects `backups.spec.ts`.
  - the sale rule (reached via `sale.test.tsx`) selects `items-flow.spec.ts` and
    `customer-name-variants.spec.ts`; `sale.tsx` itself is `full` (promotion).
  - each promoted page is `full` with reason `critical path`, not `unmapped`.
- The drift guard still proves every spec on disk is reachable.
- Manual: the selector CLI for each widened rule and each promoted page.

## Risks

- **Promotion shrinks the affected-only win.** Six more pages run the full
  suite. Accepted: coverage over minutes, and the pages are shared surfaces.
- **A widened row is unreachable once its page is promoted.** The sale rule is
  kept correct for its unit-test sibling and for a future un-promotion; the test
  asserts both the page (`full`) and the rule (the widened list).
- **Deleting the `checks` build would break `rust`.** The wording fix makes the
  two builds explicitly independent, so the next reader cannot collapse them.
