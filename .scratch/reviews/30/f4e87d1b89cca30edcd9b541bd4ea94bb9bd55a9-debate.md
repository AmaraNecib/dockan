# Debate — Sale checkout (issue #30, PR #42): full review trail (final)

- **Issue:** #30 · **PR:** #42 (`feat/30-sale-checkout`) · **Base:** `origin/develop` af394f4
- **Head reviewed:** f4e87d1b89cca30edcd9b541bd4ea94bb9bd55a9
- **Tier:** High-assurance (invoice/stock money math, FIFO cost, oversell rollback)

Adversarial reviewers read the base→head diff, issue, design doc, ADR-0001..0004,
and wisdom. Every finding was classified and fixed or deferred; the lane then
re-reviewed after Greptile (2 findings) and two follow-up code-review rounds
(4/5 confidence each). All follow-up findings were confirmed valid and fixed
with regressions.

## Findings classified

| # | Severity | Finding | Verdict | Resolution |
|---|----------|---------|---------|------------|
| 1 | 8 | Legacy stock without ledger | **False alarm** | Ticket-27 setup backfills opening movements; verified. |
| 2 | 7 | Oversell read-then-write race | **Dismissed** | Single-process (ADR-0001); BEGIN IMMEDIATE → follow-up. |
| 3 | 6 | costAtSale rounding drift | **Dismissed (designed)** | Whole-DZD mandate; ADR-0005; exact COGS → follow-up. |
| 4 | 5 | Backdated invoiceDate vs movement timestamps | **Deferred** | Follow-up. |
| 5 | 4 | Cart quantity cannot be cleared | **Deferred** | Follow-up. |
| 6–13 | 1–4 | −0 display; override/price contract conflicts; heuristic dedupe; dead zod checks; ADR-0002 staleness; comment placement; fractional comment; dead i18n key | **Fixed / dismissed** | See earlier commits and evidence. |

## Greptile finding 1 (fixed): stale pricing snapshot
`invoicesCreate` resolves items via `tx` inside the single serialized unit;
pricing/FIFO/persistence share one committed snapshot. Identical
ITEM_NOT_FOUND / PAID_EXCEEDS_TOTAL semantics pinned by the 56-test router suite.

## Greptile finding 2 + two review rounds (fixed): migration backfill

The markerless-backfill healing of legacy rows must never touch modern rows.
Final predicate (row-INVARIANT based, kind-agnostic):

- `invoice_lines.default_unit_price` healed only when
  `default = 0 AND unit > 0 AND discount_allocated = 0 AND net_total = 0`;
- `net_total` healed only when `net = 0 AND allocated = 0 AND total > 0`;
- `invoices.subtotal_amount` healed only when the read-time normalize shape
  holds (`subtotal = 0 AND total > 0 AND discount_type IS NULL AND
  discount_amount = 0`).

Soundness: pre-#30 DBs hold only PURCHASE lines (SALE was a stub) whose
unitPrice is the cost basis and whose discount columns carry new-column
defaults — exactly the invariant shape. Post-#30 lines can never match:
undiscounted ⇒ net = gross − 0 > 0; discounted ⇒ allocated > 0; free unit (0)
excluded by unit > 0 — including the quoted case (zero default, negotiated
higher price, no discount) and the zero-cost PURCHASE-with-explicit-price
corner. Marker (`migration.saleColumnsV1`) + DDL + backfill are one SQLite
transaction; interrupted upgrades re-run until the marker lands; reruns and
markerless completed DBs are no-ops.

## Follow-ups (documented, not filed)

1. `BEGIN IMMEDIATE` / conditional stock UPDATE for cross-process sale safety.
2. Exact per-line COGS column for profit reconciliation.
3. `invoiceDate`-driven movement timestamps.
4. Cart quantity string-draft state.