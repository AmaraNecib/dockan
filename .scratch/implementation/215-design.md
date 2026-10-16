# Issue 215 — recording order on the wire, page-independent superseded-row badge (design)

Tier: **Standard** (display-only, but it changes the `itemHistoryOutputSchema`
contract, so the change must be provably additive).

Base: `origin/develop` @ `4bf10be`.

Follow-up to #151. Read `.scratch/implementation/151-design.md` and
`.agents/wisdom/2026-10-15-display-vs-recording-order.md` first — this ticket
exists to remove the two limits #151 documented and could not fix.

## Problem

#151 badges an inflow row the date-ordered history draws below a cost
correction, by comparing `createdAt` **within the returned page only**. Two
documented false negatives follow:

1. **page-local** — a correction on a prior page cannot badge a superseded row
   on a later page;
2. **same-second tie** — a correction and the inflow it replaces written in the
   same second compare equal, so the strict `>` leaves the row silent.

Both are consequences of inferring recording order from `createdAt` on a
paginated page. The authoritative signal is the store rowid (`seq`), which the
api already has (`store.listStockMovements` returns it) and which the router
*strips* before answering. Replay itself already orders by `seq` (see
`byRecordingOrder` in `apps/api/src/lib/stock-ledger.ts`), so the view should
never have re-derived it from wall-clock strings.

## Fix

Expose recording order and resolve precedence where the whole ledger is in
scope — the api — then let the view render the resolved answer. This is the
"governing correction id" option issue #215 offers alongside "add `seq`".

### Contract (`packages/contracts/src/core.ts`) — additive

A new history-row schema, used only by `itemHistoryOutputSchema`:

```ts
export const itemHistoryMovementSchema = stockMovementWithBalanceSchema.extend({
  /** store rowid: the ledger's recording order (issue 215). */
  seq: z.number().int().min(1).optional(),
  /** recording order of the nearest correction the date-ordered view draws
   * above this row and that was recorded after it, resolved by the api over
   * the WHOLE ledger; `null` = no such correction. Optional so a response
   * cached before the field existed still parses. */
  supersededBySeq: z.number().int().min(1).nullable().optional(),
});

export const itemHistoryOutputSchema = z.object({
  movements: z.array(itemHistoryMovementSchema),
  total: z.number().int().min(0),
  stockOnHand: z.number().int().min(0),
});
```

Additivity argument:

- both fields are optional, so a payload without them (an old cached response)
  parses unchanged;
- `z.object` ignores unknown keys by default, so an **old client** validating a
  new payload with the old schema also parses;
- no stored column, no migration, no schema-version bump — nothing is persisted
  differently and no number changes.

### Server — resolve over the whole ledger

New pure function in `apps/api/src/lib/stock-ledger.ts`, next to the other
replay math:

```ts
/** Recording order of the correction that supersedes each date-ordered
 * history row (issue 215), or null; aligned by index. */
export function supersededByCorrectionSeq(rows: readonly HistoryRow[]): Array<number | null>;
```

A row `r` is superseded when some correction `c` is **drawn above** it in the
date-ordered list (`j < i`) and was **recorded after** it (`c.seq > r.seq`).
Because a later-recorded correction with an equal `occurredAt` is drawn *below*
`r` (seq breaks the date tie), the rule needs no explicit same-second guard: the
strict ordering is already there. Only inflows (`delta > 0`) are considered;
`isCostCorrection` keeps the "zero delta, non-null cost, `COST_CORRECTION`
reason" definition.

The router (`itemsHistory`) stops stripping `seq` and annotates every projected
row before slicing:

```ts
const projected = historyWithRemaining(movements);
const superseded = supersededByCorrectionSeq(projected);
const annotated = projected.map((row, i) => ({ ...row, supersededBySeq: superseded[i] ?? null }));
const rows = annotated.slice(offset, offset + limit);
```

Precedence is computed on `projected` (the whole ledger), not `rows` (the page),
which is the whole point.

The reported `seq` is the nearest qualifying correction drawn above the row,
matching #151's fallback. Replay's segment terminator is the *first* correction
recorded after the row; with several later corrections both drawn above, the
two can differ. The badge only needs the correction the view draws directly
above the row (the one it points at), and the view reads the field's
presence/absence, so the nearest referent is the honest value to expose.

### Web — trust the annotation, keep the legacy fallback

`apps/web/src/pages/stock.tsx`:

- `PrecedenceRow` gains `seq?: number` and `supersededBySeq?: number | null`.
- `supersededByCorrection(rows)` returns the annotated set as soon as any row
  carries `supersededBySeq`; otherwise falls back to the #151 page-local
  `createdAt` comparison (a response cached before issue 215).
- The fallback prefers `seq` for the recording-order compare when both rows
  carry it, and `createdAt` otherwise.

No row order, no `stockAfter`, no computed cost, no replay output changes.

## Interfaces

| Seam | Change |
| --- | --- |
| `itemHistoryMovementSchema` | new optional `seq`, optional nullable `supersededBySeq` |
| `supersededByCorrectionSeq(rows)` | new pure api helper, whole-ledger |
| `itemsHistory` router handler | annotates projected rows before slicing |
| `supersededByCorrection(rows)` | reads the annotation, legacy fallback else |

## Planned tests

Unit — `apps/api/src/lib/stock-ledger.test.ts`:
- flags an inflow drawn below a correction recorded after it (seq-based);
- **same-second tie**: equal `createdAt`, correction recorded after and dated
  above → flagged (the #151 false negative);
- ignores a correction recorded before the row;
- never flags outflows or a non-correction zero-delta row;
- aligned output: corrections/outflows get `null`.

Wire — `apps/api/src/rpc/router.test.ts`:
- **cross-page acceptance**: seed a future-dated inflow first, an ordinary
  inflow dated before it, then a cost correction; request the page that holds
  the future row (`limit`/`offset`) and assert its `supersededBySeq` is the
  correction's `seq` and that the correction page carries `null`. The
  correction is on a *different* page than the badged row, so this fails
  before the change;
- additivity: a response row with `seq`/`supersededBySeq` stripped still parses
  against `itemHistoryOutputSchema`.

Unit — `apps/web/src/pages/stock.test.tsx`:
- the annotation drives the badge across pages (a page-2 row with
  `supersededBySeq` set is flagged; `null` is not);
- the legacy fallback is untouched (all #151 cases stay green).

E2E — `tests/e2e/stock-ledger.spec.ts`:
- page size 2; page 1 holds the correction, page 2 holds the future-dated
  superseded inflow; the badge is visible on page 2. Before the change the
  page-local rule sees no correction on page 2 and shows nothing.

## Risks

- **Contract drift**: the annotation is derived from the same `seq` replay
  already uses, so it cannot disagree with `weightedAverageCost`. No new source
  of truth.
- **Under-annotate, never over-annotate** (wisdom #151): `supersededBySeq` is
  set only when the correction is both drawn above and recorded later.
- **Payload size**: two small fields per row; no extra query.
- No money path touched.
