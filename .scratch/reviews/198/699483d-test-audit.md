# Test audit — #198 at `699483d`

**Method:** `test-audit` skill — three independent read-only sub-agents (edge
case hunter, coverage analyst, test quality reviewer) against
`git diff 21dbc13...HEAD`, the changed tests, and the changed source.

## Edge case hunter

Already covered (not re-added): the full Arabic-Indic quantity table (both
ranges, whitespace, cap after normalize, digits-only rejection, mixed script,
subtotal), the override-reader asymmetry, the `firstCommitError` forward-order
matrix, override-before-quantity, first-offender, purchase-shaped input, the
override-vs-payment page and E2E tests, both cap boundaries, purchase
multi-line, and the `initialPaid` payload pins.

| # | finding | risk | disposition |
|---|---|---|---|
| M1 | The reversed multi-line permutation (line 1 quantity beats line 2 override) was not asserted; a column-major regression would pass. | 🟠 | **Fixed** — added to the `firstCommitError` tests |
| M2 | No browser-level Arabic-Indic quantity fill. | 🟡 | **Deferred** — page payload pin + lib table is proportionate; the input is a text field with `inputMode`, so browsers do not reject the digits |
| M3 | No purchase-side Arabic-Indic payload pin. | 🟡 | **Fixed** — a purchase page test pins `٥` → 5 |
| M4 | Extended-range cap/overflow variants. | 🟡 | **Recorded** — verified correct; lib table covers the ASCII half and both ranges |
| M5 | The `if (!paid.ok) throw` guard was untested dead code. | 🟡 | **Fixed later** — now `resolvedInitialPaid`, with its ok and throw paths unit-tested |
| M6 | Page-level empty-cart/party copy never asserted. | 🟡 | **Recorded** — lib tests pin the messages; no reachable path swaps them |
| M7 | `CommitChecks` slot combinations only tested at the extremes. | 🟡 | **Recorded** — no caller uses the mixed combinations |

Verdict: no 🔴. M1 was the one worth-fixing gap; M2/M3 were cheap confidence
buys (M3 taken).

## Coverage analyst

Every issue ask and every design-doc money-math pin has a test, at the layer
that matters:

- Ask 1 (one order): `firstCommitError` unit matrix; both page call sites.
- Ask 2 (gaps): override-vs-payment at page **and** browser level; quantity
  boundary on both pages plus the lib table; multi-line on both pages plus the
  lib order test.
- Ask 3 (Arabic-Indic): normalizer table, quantity table, page payload pin,
  scope asymmetry pins.

| # | finding | disposition |
|---|---|---|
| C1 | Design §5 misdescribed the override test (negative vs fractional). | **Fixed** |
| C2 | No page/E2E test for the negative-amount override + typed payment. | **Dismissed** — `nonNegativeOr` makes a negative override fall back to the default price, so it can never drive the total below the payment; the fractional case is the reachable shadowing scenario |
| C3 | `firstCommitError` slot combinations partially untested. | **Recorded** (same as M7) |
| C4 | Design §5 implied `purchase-intake.spec.ts` covered ordering; it covers the #146 drift. | **Fixed** — doc reworded |
| C5 | No E2E Arabic-Indic coverage. | **Recorded** (same as M2) |

## Quality reviewer — grade A−

New tests are revert-discriminating: the `firstCommitError` fixtures make all
later checks fail at once so a reordered helper returns a different sentinel;
the sale override test proves its premise (999 payment survives a 13 total)
before asserting the message; cap/payload tests use `lastInvoiceInput?.lines`
equality; the Arabic-Indic table has strong negative space.

| # | finding | disposition |
|---|---|---|
| Q1 | `toContain("13")` could match `1300`; use the numeric helper. | **Fixed** — `totalAmount(host)).toBe(13)` |
| Q2 | Sale helper duplication across the two describes. | **Fixed** — helpers hoisted to module scope |
| Q3 | `pass`/`fail` vs `valid`/`invalid` fixture naming. | **Recorded** — readable in context |
| Q4 | Purchase multi-line title overclaimed "first unusable line". | **Fixed** — retitled |
| Q5 | Describe placement drift (purchase #198 tests live in the #146 describe). | **Recorded** — they exercise the same quantity-draft contract |
| Q6 | Near-vacuous extra assertions. | **Dismissed** — cheap documentation of the definitional link |
| Q7 | Async-pattern asymmetry (sale clicks in `act`, purchase awaits 20 ms). | **Dismissed** — matches existing per-file practice |
