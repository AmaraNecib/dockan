# Test audit — #257 round 3, commit e3094de (base da5f336)

**Diff:** `tests/e2e/purchase-inline-product.spec.ts` two assertions `toContainText("INV-")` → `toContainText(/SUP-\d+/)` (:94, :182); `tests/e2e/supplier-adjustment.spec.ts:101` one SAFETY comment `INV-` → `SUP-`. Read-only audit (git/sed/grep only). No tests run (budget).

## Lens 1 — EDGE CASE HUNTER

Purchase numbers are minted only at `router.ts:1324` via `allocateInvoiceNumber("PURCHASE")` → `SUP` (`document-number.ts:8-12`). Edges this spec leaves untested:

- **>9999 rollover** — `formatDocumentNumber` pads to 4 but does not cap (`document-number.ts:36`), so the 10 001st purchase is `SUP-10001`. `/SUP-\d+/` matches it; the shape is fine. Unit-pinned at `drizzle-store.test.ts:1593` (`INV-10000`). **yellow** — e2e never needs it.
- **Legacy `INV-` row on a purchase** — unreachable through this UI (new purchases always get `SUP`); ordering handled by `documentNumberSequence`. **yellow**.
- **Return path RTN-vs-RET** — customer returns use `RET` (`router.ts:1573`, unit-pinned `router.test.ts:3316`), supplier returns use `PRT` (SQL `drizzle-store.ts:2192`). No e2e asserts a `RET-` prefix on a customer return via the UI. Wrong shape here would be invisible end-to-end. **orange**, but out of this file's scope.

The in-scope concern — prefix-less or wrong-prefix purchase number — is closed by the regex (see Lens 2).

## Lens 2 — COVERAGE ANALYST

- **Criterion "must fail if the prefix is lost":** met. `0002` (no prefix) → no `SUP-` → fails. `SUP-` bare → `\d+` needs ≥1 digit → fails.
- **Criterion "must fail on wrong prefix":** met. `INV-0002` on a purchase → no `SUP-` match → fails. Correct reason, not "some text appeared".
- **Duplicate coverage:** `SUP-` on `purchase-saved-number` is also asserted at `00-onboarding.spec.ts:186`, `96-returns-supplier-action.spec.ts:80`, and `supplier-adjustment.spec.ts:100` (string, weaker). Redundant but harmless; the two in-file assertions cover distinct scenarios (inline create vs zero-cost create).

## Lens 3 — QUALITY REVIEWER

Names are behavior-first English; every assertion awaited; regex is the right tool; `Date.now()` stamp isolates rows; shared-DB sequencing risk is read-only (shape, not absolute number), consistent with the design's stated risk. Setup (~30 lines) is duplicated across the two tests — extractable but idiomatic for e2e. The new comment is accurate; the corrected supplier-adjustment comment now matches its code. **Grade: A-**.

## Synthesis

| Finding | Lens | Risk | Action |
|---|---|---|---|
| Customer-return `RET-` shape has no e2e assertion | Edge | orange | Defer — out of this file; unit-pinned |
| >9999 → `SUP-10001` shape unasserted in e2e | Edge | yellow | Acceptable — regex matches; unit-pinned |
| Legacy `INV-` purchase row display | Edge | yellow | Acceptable — UI-unreachable |
| Regex fails for the right reason (prefix-less / wrong prefix) | Coverage | — | Good |
| Purchase `SUP-` asserted in 4 specs | Coverage | yellow | Acceptable — harmless redundancy |
| Setup duplication in the two tests | Quality | yellow | Acceptable — idiomatic e2e |

**Verdict:** the fix is correct and the assertion is non-vacuous. No blocker.
