# Test audit — receipt printing

- **base SHA:** `706a498`
- **reviewed HEAD:** `cfe34da` (findings applied; audit ran on `cea2502`, fixes committed as `cfe34da` and re-gated)
- **gate:** 3 parallel review agents (edge case hunter, coverage analyst, quality reviewer)

## What was audited

- `apps/web/src/lib/receipt.test.ts` (projection seam)
- `apps/web/src/components/receipt-view.test.tsx` (print-only view render)
- `tests/e2e/receipts.spec.ts` (invoice print button → receipt document)

## Coverage vs acceptance criteria

| Acceptance criterion | Coverage | Verdict |
| --- | --- | --- |
| Print button on invoice screen → print-only view | e2e (click `invoice-print` → `receipt-page`) | SATISFIED |
| Receipt: store identity, date, number, lines, totals, paid/remaining, payments | unit (11 cases) + view (12 cases) + e2e content assertions | SATISFIED (triple-layered) |
| Any printer via OS dialog; Arabic RTL | RTL: view tests assert `dir="rtl"` root + `ltr` spans (date/number/phone/timestamp). The OS dialog itself is headless-hostile; the e2e asserts the print route document and documents why — the same `window.print()` opens WebView2's system dialog in the desktop shell | PARTIAL by design (documented) |
| Dependency-light, window.print() on a dedicated route | by inspection: no new packages, no Rust changes; diff confined to `apps/web` + `tests/e2e` | SATISFIED |

## Findings + dispositions

1. 🟠 Auto-print could double-fire: manual "طباعة الآن" during the 300 ms settle window did not arm the once-gate. **Fixed** — gate keyed by invoiceId and armed by both the timer and the manual button.
2. 🟠 Per-instance ref could suppress a later invoice's auto-print on a same-route param change. **Fixed** — gate keyed by `invoiceId`.
3. 🟡 Pending state rendered the connection-error copy. **Fixed** — neutral loading message (`expensesLoading`) with `receipt-loading` testid.
4. 🟡 No print pagination CSS; long receipts could split rows/detail rows mid-cell. **Fixed** — `@media print` `break-inside: avoid` scoped to receipt rows + `.receipt-totals` block.
5. 🟡 `??` guards vs empty strings: `counterpartyName`/`storePhone` are schema-validated (`trim().min(1)` / empty→null at the boundary), so empty strings cannot reach the receipt from real data. **No action** (documented; schema enforces).
6. 🟡 Auto-print timing untested. The exactly-once contract is enforced in code by the ref gate; unit-testing the router page would need router/query mocking the repo does not do for pages — covered by e2e at the route level, dialog behavior manual in the desktop shell. **Documented**, no action.
7. Review granularity: view tests gained a zero-discount branch, an explicit `receipt-party` cell assertion, an invoice-kind label assertion, and `beforeEach` isolation. `host` dead-init removed.
8. e2e canonical-phone assertion (`066 12 34 56 7` → `+213661234567`) is now documented as api-boundary normalization.

## Verdict

No red-grade gaps after fixes. 22 unit claims → now 24 assertions across 12 view cases + 12 projection cases (85 web tests total, 0 fail); e2e 17/17 green under the standard gate. Residual risks (auto-dialog behavior, one receipt shape in e2e) are documented and layered.