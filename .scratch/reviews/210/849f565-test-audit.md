# #210 — Test-audit evidence

- Base: `a52084d1de0bda7fd3cb25ec5da5c778f04200ae`
- HEAD: `849f565c49ac665a421d2e5abdf0b0a9404e7a3b`
- Method: 3 independent auditors (edge-case hunter, coverage analyst, quality
  reviewer) per round, then a round-3 delta re-verification. Each finding was
  reproduced against the code before acting.

## Final grades (round 2, re-verified round 3)

| Test file | Grade | Note |
|---|---|---|
| `apps/web/src/lib/amount-parse.test.ts` | A | both scripts, ASCII-unchanged, safe-integer ceiling, mixed-script, loose grammar |
| `apps/web/src/lib/invoice-draft.test.ts` | A | #198 asymmetry pin replaced; bill+validate agree |
| `apps/web/src/components/ui/amount-percentage-input.test.tsx` | A− | over-100 clamp fallback for `«١٥٠»` |
| `apps/web/src/components/parties/supplier-return-draft.test.ts` | A | reader accepts `٥`/`۵`, rejects `٥٫٥`, equals ASCII |
| `apps/web/src/components/parties/supplier-return-panel.test.tsx` | A− (was B) | preview == submit pinned; false-positive assertion fixed |
| `apps/web/src/pages/sale.test.tsx` | A | preview total and captured payload in one test |
| `apps/web/src/tests/select-driver.ts` | A | listbox-scoped option lookup |
| `tests/e2e/sale-checkout.spec.ts` | A | real browser Arabic quantity/override/discount |

## Findings actioned

1. **Blocker (coverage + quality) — the refused-draft preview test passed on the
   unfixed code.** `expect(textContent).toContain("0")` also matched `400000`
   (the value the old loose reader produced for `1e3`) and `600` (`1.5`).
   **Fixed** at `849f565`: `previewAmount()` extracts the exact preview number;
   round 3 proved it returns 400000/600 on the pre-fix reader, so the test now
   fails without the fix.
2. **Gap — the supplier-return preview had no test** even though the design's
   own risk table names it. **Fixed** with a panel test that types `٥`, asserts
   the preview value, submits, and asserts the same quantity.
3. **Gap — free-standing supplier-return quantity accepted Arabic in code but
   was never driven.** **Fixed** with a free-standing test (`٥` → `quantity: 5`).
4. **Gap — mixed-script loose grammar unpinned.** **Fixed**: `١e٣`→1000,
   `٠x١٠`→16, with `parseWholeAmount("١e٣") === null` showing the strict readers
   still reject it.
5. **Yellow — Extended Arabic-Indic exercised only at unit level.** Accepted:
   the normaliser is shared and unit-pinned for `۵`/`۸`; an integration run would
   add browser cost without new signal.
6. **Yellow — Arabic safe-integer overflow, sign, padded whitespace, zero
   untested.** **Fixed** in the round-1 hardening and re-verified in round 3.

## Deferred

- Free-standing supplier-return **amount** is still ASCII-only and untested —
  issue **#225**.
- RLM/LRM bidi marks on paste — issue **#227**.

## Verification

- Round 2 auditors ran the touched suites: 106 pass / 0 fail.
- Round 3 auditor ran the five touched test files: 106 pass / 0 fail, 439
  assertions.
- Full `bun run test` at `849f565`: green (web 1065+ tests, api/contracts/desktop,
  scripts).
