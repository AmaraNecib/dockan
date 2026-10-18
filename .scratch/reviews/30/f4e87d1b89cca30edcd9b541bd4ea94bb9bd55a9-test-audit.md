# Test audit — Sale checkout (issue #30, PR #42): final

- **Head reviewed:** f4e87d1b89cca30edcd9b541bd4ea94bb9bd55a9

## Acceptance-criteria paper trail

All six criteria covered at unit / wire / E2E / reconciliation layers (see
previous evidence rounds; suite retained in full at this HEAD).

## Migration regressions (final state, deterministic, all green)

1. **Interrupted migration heals:** DB with post-ALTER columns, legacy values,
   no marker → setup() backfills (default/net/subtotal heal), writes marker.
2. **Markerless DB with modern zero-default sale lines — byte-identical:
   raw `SELECT *` of three modern rows compared before/after setup():**
   (a) undiscounted zero-default negotiated sale line (default 0, unit 700,
   net 700 — the exact quoted case) unchanged; (b) fully-discounted
   zero-default sale line (allocated 700, net 0) unchanged; (c) modern
   PURCHASE line with zero cost basis bought at explicit unit 700 unchanged.
   Legacy-shaped interrupted line in the same DB still heals (default→200,
   net→200, subtotal→200); marker written; second setup() no-op.

## Other retained coverage

SALE_CREATED activity; discounted-total payment boundary; 100% discount;
duplicate same-item lines FIFO; live-cache-vs-FIFO split; contract rejection
paths; empty-override free-line bug (unit + E2E); Greptile stale-pricing
structural guarantee (56 router tests pin error parity).

## Residual (documented)

Legacy-with-stock SALE wire test waits on a legacy-DB fixture; cart quantity
string-draft; UI-unbounded quantity (server rejects > 1e6); E2E setup re-run is
suite-wide convention.

## Quality grade

Coverage **A**; suite **B+**. Gates at HEAD: typecheck 0, lint 0, 173 API + 17
web unit tests 0 fail, 10/10 worker-1 E2E.