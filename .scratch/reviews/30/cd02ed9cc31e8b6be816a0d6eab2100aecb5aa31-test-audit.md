# Test audit — Sale checkout (issue #30, PR #42)

- **Head reviewed:** cd02ed9cc31e8b6be816a0d6eab2100aecb5aa31
- **Auditors:** edge-case hunter, coverage analyst, quality reviewer (parallel sub-agents) + lane synthesis.
- **Suites at audit time:** API 171 pass / 0 fail, web 17 pass / 0 fail, E2E 10 pass (worker-1).

## Acceptance-criteria paper trail

| Criterion | Unit | Router/wire | E2E | Reconciliation |
|---|---|---|---|---|
| 1 scan/search/picker/unknown-explicit | — | — | ticket30 (unknown→dialog; exact rescan; picker) | — |
| 2 oversell block + inline create-with-stock | ledger STOCK_NEGATIVE | rollback ×2; create-with-stock history | oversell error, cart kept | stock after sale asserted |
| 3 actual line price + default/actual snapshots | calc. amount/percentage | "persists amount and percentage negotiated prices…" | 900 / 80% | legacy backfill store test |
| 4 discount after overrides, nonnegative | rounding + cap tests | amount/percentage after overrides; zero re-read | 2700→2600; 400→360 | `PAID_EXCEEDS_TOTAL` SALE case (new) |
| 5 internal allocation shown once | largest-remainder | Σ reconciliation on wire | — | invoicesGet re-read |
| 6 full-flow coverage | FIFO layers | FIFO snapshot + cache split (new) | full journey | — |

## Gaps found and closed by this lane

- **SALE_CREATED activity never asserted** → added to the base SALE test (type, `ref`, summary).
- **SALE paid-exceeds-total with discount boundary untested** (only PURCHASE had it) → new test: 250 > total 200 rejected; 200 == total accepted with remaining 0.
- **Duplicated same-item lines in one invoice untested** (per-line ledger re-read is the trickiest loop) → new test: two lines over 5×100+5×200 assert `costAtSale` [100, 133], stock 3, two SALE movements.
- **100%-percentage discount untested** (only AMOUNT cap was) → new test asserts value 100, discountAmount = subtotal, zero totals through a re-read.
- **Live-cache-vs-FIFO split untested across consecutive sales** → new test: sale2 costs 200 from remaining layers while `items.costPrice` stays 150 (ADR-0002).
- **Contract rejection path (override conflicts, PURCHASE-only, DISCOUNT_ONLY_SALE) untested** → new test.
- **Empty override value → free line** (see verdict below) → `overrideInputInvalid` unit tests (5 cases, 15 expects) + an E2E regression step (save rejected, error shown, cart intact, subtotal 3000).

## Residual gaps (documented, fixed or deferred)

- **Fixed pre-existing flake:** `backups.test.ts` "creates today's file once" failed once wall-clock reached 2026-08-25 — the manual-export test left a real-today copy in the shared fixture; it now deletes its own file. Deterministic on any date.
- **Deferred (unchanged):** PRE-PR items without ledger history are covered by the ticket-27 setup backfill (already tested: "backfills exactly one opening movement…"). The migration store test covers invoice columns only; a legacy-with-stock SALE wire test would need a legacy DB fixture — follow-up.
- **Deferred:** empty cart-quantity draft state; upper bound 1e6 added to `quantity` schema but UI still unbounded (server rejects).
- **Dismissed:** E2E first-time-setup re-run is the suite-wide convention (login/ticket03/12/13/27/28 all do it) — not ticket-30-specific. Scanner duplicate-window timing trick is shared machinery, documented in the config.

## Quality grade

Coverage: **A** (every criterion multi-layer). Suite quality: **B+** — no missing awaits,
exact assertions, real atomicity proofs (before/after snapshots); E2E is timing-heavy by
nature of the wedge scanner, mitigated by `VITE_SCAN_DUPLICATE_WINDOW_MS`.