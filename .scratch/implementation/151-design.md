# Issue 151 — item history shows a cost correction's recording-order precedence (design)

Tier: **Standard** (display-only clarity) — but it explains a number the owner
uses to trust his costs, so it is proven by tests.

Base: `develop` @ `3c3abcf` (branch `feat-151-item-history`).

## Problem

Issue #144 made a manual cost edit a `MANUAL_ADJUSTMENT` ledger fact
(`delta = 0`, `reason = COST_CORRECTION`). Replay is two-level:

- the ledger is walked in **recording order** (`stock_movements.rowid`) and split
  into segments at each correction;
- inside a segment ordinary movements replay in **business-date** (`occurredAt`)
  order.

The item history, though, is rendered in **business-date** order. A future-dated
purchase recorded *before* a cost correction therefore draws **below** the
correction. Reading top-to-bottom, the owner sees the correction set the average
and then a purchase that apparently did not move it. Replay actually applied the
purchase first and the correction overwrote the average it produced.

Example (display order):

```
occurredAt            kind            delta  unitCost
2026-10-15 10:00      تسوية (تصحيح)     0      300      <- correction
2999-01-01 00:00      مشتريات         +10     200      <- recorded earlier, drawn later
```

## Fix (display only)

Annotate the rows the correction supersedes: an **inflow** that the date-ordered
history draws *below* a cost correction which was **recorded after** it. It gets
a small badge: “recorded before the cost correction above, so its effect on the
average cost was replaced.”

- Ordering, `stockAfter`, the ledger, replay and every computed cost are
  untouched.
- The ordinary date-ordered case (no date/recording inversion) renders exactly
  as before — no badge.
- Only inflows (`delta > 0`) can move the weighted average, so outflows and the
  correction rows themselves are never annotated.

## Where the recording order comes from

The API contract is **not** changed (rule: no schema/contract change). The
history rows already carry `createdAt` (the wall-clock insert time) alongside
`occurredAt` (the business date). Recording order is exactly the insert order;
`createdAt` is the closest signal the view has without `seq`.

Detection rule: row `r` is superseded when some correction `c` appears **above**
`r` in the date-ordered list and `c.createdAt > r.createdAt` (strictly later, so
a same-second tie is left unannotated rather than guessed). `createdAt` is
`YYYY-MM-DDTHH:mm:ss` (fixed width), so the comparison is lexical and total.

The API currently strips `seq` (the authoritative tiebreak). This is a known,
accepted limit of a display-only change: `seq`/`createdAt` diverge only for
inserts in the same second, which the UI cannot produce by hand and which the
strict comparison leaves alone.

### Known limits (display-only, under-annotates; never a wrong cost)

- **Same-second tie** — the correction and an inflow recorded in the same
  second are not ordered, so no badge. One extra second of separation fixes it
  in practice; the e2e waits out the boundary explicitly.
- The `seq`-based authoritative fix would remove this and the limit below, but
  it needs `seq` on the contract, which this ticket forbids.
- **Page-local** — the annotation sees only the current page of a paginated
  history. A correction on an earlier page cannot badge a superseded inflow on
  a later page. Future-dated rows sort at the end of the date-ordered list, so
  this needs many rows between the correction and the future row; the flag
  under-annotates rather than misleads, and no computed value is affected.

Both limits are consequences of the no-contract-change rule. Fixing them needs
`seq` (or the governing correction) on the wire and is a follow-up, not this
display change.

## Interfaces

New pure, exported helper in `apps/web/src/pages/stock.tsx` (unit-testable):

```ts
export interface PrecedenceRow {
  delta: number;
  unitCost: number | null;
  reason: string | null;
  createdAt: string;
}

/** Indices of inflow rows the date-ordered history draws below a cost
 * correction that was recorded after them (issue 151). */
export function supersededByCorrection(rows: readonly PrecedenceRow[]): Set<number>;
```

Render change: in the “kind” cell, when `superseded.has(index)`, add

```tsx
<span className="mr-2 rounded bg-warning px-2 py-0.5 text-xs text-warning-foreground"
      data-testid="history-superseded">
  {t("historySupersededByCorrection")}
</span>
```

i18n (Arabic, `apps/web/src/lib/i18n.ts`):

```
historySupersededByCorrection: "سُجِّل قبل تصحيح التكلفة أعلاه، فاستُبدل أثره في متوسط التكلفة",
```

No API display text is introduced; the API keeps emitting locale-neutral tokens.

## Dependencies

None new. Reuses `formatDateTime` (not needed by the badge) and the existing
`COST_CORRECTION` reason token already translated by `movementReasonText`.

## Planned tests

Unit (`apps/web/src/pages/stock.test.tsx`, `bun:test`):

- the issue scenario: a future-dated inflow drawn after a later-recorded
  correction is flagged; the correction index is the one above it;
- an inflow recorded **after** the correction (normal blend) is not flagged;
- an outflow below a correction is not flagged (outflows do not move the
  average);
- a correction recorded **before** an inflow but drawn below it is not flagged;
- the ordinary date-ordered list with no correction yields an empty set;
- a tie (`createdAt` equal) is left unannotated;
- the badge copy is the `t("historySupersededByCorrection")` value (asserted by
  key, never a hardcoded literal), and does not contain the raw API token.

E2E (`tests/e2e/stock-ledger.spec.ts`, Playwright):

- seed an item, `stockAddManual` a future-dated `PURCHASE` (via the RPC wire the
  page session carries), edit the cost to append the correction, open the item
  history, and assert the future-dated purchase row carries the badge while the
  correction row does not; the ordinary same-date purchase case stays clean.

## Risks

- `createdAt` vs `seq` tie: documented and left conservative (no annotation).
- False negatives if a purchase and correction land in the same second: display
  under-annotates rather than misleads; no cost is affected.
- No money path touched; `weightedAverageCost`, `projectLedger`, the ledger rows
  and the cached cost are all unchanged.
