# Ticket 01 — Test audit (Standard tier)

Seam under test: StorePort against sqlite `:memory:` (spec's seam 2). 14 tests, 46 assertions, all passing.

Checks from the test-audit checklist:

- edge cases covered: UNPAID/PAID/PARTIAL derived status filters, date-window filter returning zero rows, missing-row reads return undefined, FK violation on a bad category id rejects
- meaningful assertions: values are worked literals, not recomputed from the code (average-cost example, debt sums 1500/25000, INV numbering)
- failure and empty states: empty invoice query returns `{ items: [], totalCount: 0 }`; low-stock list only when threshold met; seed runs once; backup opens standalone
- persistence-specific: WAL checkpoint before copy, camelCase entity roundtrip, enum literal typing (SALE/PURCHASE, CASH/BANK), same-second activity ordering by insertion rowid
- not covered here, by design: UI rendering and invoice use-case math land with tickets 03-07 (seam 1 tests come with the use-case module).