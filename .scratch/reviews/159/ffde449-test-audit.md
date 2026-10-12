# Test audit — #159 + #160 + #166

**Tier:** Standard
**Base:** `0b4ec68` (`origin/develop`)
**Reviewed code:** `79ccbf4` (round 1 at `fc10dc8`)
**Gate artifact for HEAD:** `ffde449` (diff `79ccbf4..ffde449` = one wisdom doc)

Run as the `test-audit` skill's three lenses (edge-case hunter, coverage
analyst, quality reviewer) plus a round-2 verification after the fixes.

## Scope

Added/changed tests:

- `apps/web/src/components/ui/success-card.test.tsx`
- `apps/web/src/lib/cell-ltr.test.ts`
- `apps/web/src/pages/sale.test.tsx`, `purchase.test.tsx`, `invoice.test.tsx`, `invoice-returns.test.tsx`
- `apps/web/src/components/receipt-view.test.tsx`
- `tests/e2e/completion-screens.spec.ts`, `tests/e2e/purchase-intake.spec.ts`, `tests/e2e/invoice-payments.spec.ts`

## Round-1 findings and dispositions

| # | Lens | Finding | Disposition |
| --- | --- | --- | --- |
| 1 | edge | `detail={null}` / `""` renders an empty styled `<p>` | **Fixed** — `SuccessCard` gates through `hasDetail()` (`!== undefined/null/false/""`); the test loops all four values and asserts exactly one `<p>` |
| 2 | edge | `cell-ltr` scan misses single-quoted / JSX-expression `dir` | **Fixed** — regex matches `"ltr"`, `'ltr'`, `{"ltr"}`, `{'ltr'}` |
| 3 | edge/coverage | `cell-ltr` per-file check was a substring, not per-cell | **Fixed** — exact per-file counts pinned (party-detail ×2; invoice/parties/activity/print-sheet ×1) |
| 4 | edge/coverage | no paid-in-full (remaining 0) case | **Fixed** — sale test asserts no `sale-saved-debt` and one `<p>` |
| 5 | edge | return card with `debtOffset > 0` never exercised | **Fixed** — all-debt return record asserts the «خُصم من الدَّين» line |
| 6 | edge/coverage | #160 tokens asserted on only three fields | **Fixed** — return quantity + custom cash, sale line quantity, purchase quantity + cost now asserted |
| 7 | edge | purchase card had no unit coverage and no e2e | **Fixed** — unit: open-by-id, panel-below-DOM, form restore; e2e: `purchase-intake.spec.ts` opens the saved purchase by id |
| 8 | edge | `pmt-saved-detail` never asserted | **Fixed** — amount + `دج` asserted |
| 9 | coverage | no `دج`-not-`DA` assertion | **Fixed** — payment and return cards assert `دج` and not `DA` |
| 10 | quality | weak raw-color assertion (root className only) | **Fixed** — scans the card's whole `outerHTML` |
| 11 | quality | `receipt-view` isolation test could pass on a broken class | **Fixed** — asserts the quantity `<td>` uses `cell-ltr`, whose CSS `cell-ltr.test.ts` pins |
| 12 | quality/standards | router `Link` stub copied into four test files | **Fixed** — one `src/tests/router-mock.tsx` helper |

No finding required removing a test; no test was asserted-only-for-coverage.

## Round-2 verification (at `79ccbf4`)

Independent reviewer re-read the HEAD code and re-ran the suite:

- `cd apps/web && bun test --max-concurrency=2` → **642 pass / 0 fail**, 3756 assertions, 50 files.
- All round-1 fixes verified present; no missing `await`; async helpers are act-wrapped.
- Grades: `success-card` A- · `cell-ltr` B+ · `sale` A- · `purchase` A- · `invoice-returns` A- · `invoice` A- · `router-mock` B.

## Residual notes (accepted, no blocker)

- `cell-ltr.test.ts` counts the literal `cell-ltr` anywhere in the five files and
  the scan's `[^>]*?` cannot see past a `>` in a JSX attribute. No such cell
  exists; the per-file count is the backstop and the wisdom doc records the trap.
- The success-card raw-color check cannot catch named Tailwind palette
  utilities; `shadcn/no-raw-colors` (oxlint, error) is the static guard.
- `dark:bg-input/30` is asserted on `inputClass` fields; the return
  quantity/cash fields were already themed with `bg-card` + `border-input` +
  the same focus ring, so only those tokens are asserted there.
- #160's raw inputs inside `components/vault/*` are out of scope (lane #167).

## Commands

```
bun run test            # turbo test: api + web, 642 pass / 0 fail
bun run test:e2e        # 47 passed (isolated ports, default .e2e-data)
bun run lint            # 0 errors
bun run typecheck       # 3 successful
```
