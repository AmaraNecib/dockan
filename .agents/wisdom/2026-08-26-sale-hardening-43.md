# Wisdom: sale hardening issue 43 (exact COGS, backdated movements, quantity draft)

## Rounded FIFO snapshots are lossy — snapshot the exact total at sale time (🟠 Major)

`cost_at_sale` stores `Math.round(totalCost / quantity)`. Exact per-line COGS
can never be derived later: the rounding discards the layer-sum remainder, and
ledger re-derivation is order-unstable once backdated rows interleave. When a
report needs exact per-line profit, snapshot the unrounded layer sum in the
same write that snapshots the rounded unit (`fifoOutflowCost → { totalCost,
unitCost }`) instead of adding report-time reconstruction. Backfill legacy
rows with the OLD formula (`quantity × cost_at_sale`), which is at least as
accurate as the historical report — never claim more.

**Always**: money reports that need per-line exactness get an additive column
at write time; document which row populations are exact vs. old-formula.

## A dated sale movement must never sort ahead of stock it consumes (🟠 Major)

Backdating a SALE movement to `invoiceDate` can place it before purchases the
units came from → FIFO replay throws STOCK_NEGATIVE (e.g. 5@Jun1 + 3@Jun5,
6-unit sale dated Jun 3: stock at Jun 3 is 5). Clamp `occurredAt` to
`max(invoiceDay midnight, newest inflow occurredAt)` where "inflow" = ANY
delta>0 movement (positive MANUAL_ADJUSTMENT adds a cost layer too, so
"last purchase" alone is too weak). Apply the rule only for EXPLICIT invoice
dates so undated flows stay byte-identical. This makes replay validity hold by
construction; verify with a property test (un-clamped throws, clamped
replays).

## A migration marker must never gate a value-repair UPDATE when a row invariant exists (🟠 Major)

Greptile's P1 was "column presence must not gate backfills; use a marker."
The symmetric trap: marker-gated backfill + a later rollback to a binary that
writes DEFAULT 0 → re-upgrade skips healing forever, silently understating
COGS. When a cheap row invariant isolates the placeholder rows (`field = 0
AND meaningful_field > 0`, idempotent, cannot match real values), run the
repair UPDATE on EVERY boot un-gated, and write the marker only for
diagnostics/evidence.

**Always**: invariant-restricted UPDATEs > marker gates for self-healing
value repairs; keep the marker as evidence, not as the gate.

## Reviewer workflowScript pitfalls (🟡 Minor)

`runs.run(key, { resume })` requires a non-empty `task` follow-up — an empty
or placeholder resume makes the whole workflow script fail after the child
already completed. For fan-out, prefer one `await runs.all([{key, agent,
task}, ...])` with fully-specified tasks; read the ordered array by index.
If a workflow still fails, the completed children's outputs are retrievable
via `subagent({ action: "status", id })` — the work is not lost, only the
script's return value.

## Quantity drafts: bind the string, not the number (🟡 Minor)

A controlled `value={String(quantity)}` input snaps back when cleared because
`Number("") === 0` fails the `>= 1` guard. Bind the raw draft string to the
input and parse to the effective quantity (`0` when invalid) at every
consumption point (totals + submit); keep the draft untouched by the input so
empty stays visibly empty. Mirror the RPC's quantity cap client-side so an
oversized draft fails as a field error, not an opaque server error.