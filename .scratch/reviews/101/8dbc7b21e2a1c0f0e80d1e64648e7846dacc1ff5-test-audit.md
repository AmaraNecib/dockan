# #101 test audit — head `8dbc7b21e2a1c0f0e80d1e64648e7846dacc1ff5`

Tier: Standard. Base: `0b4d5a16c793cb775288fd576cddc3dcc62b7d24`.
Diff: `git diff 0b4d5a1...8dbc7b2`.

Three fresh sub-agents (edge-case hunter, coverage analyst, quality reviewer)
audited the diff in parallel. A first round ran at `6c706d7`; the fixes it found
landed in `241e40a` and `8dbc7b2`. The reports below are the second round at the
final head.

## Gate evidence (run at this SHA)

- `bun run lint` → ex 0 (`$ oxlint`, no findings, shadcn rules enabled).
- `bun run typecheck` → ex 0 (3/3 packages).
- `bun run test` → ex 0: 258 pass / 0 fail, 799 expect() calls, 27 files.
- `DOKAN_PORT=4717 DOKAN_WEB_PORT=5573 bun run test:e2e` → ex 0: 26 passed (1.6m).

## Edge-case hunter

Confirmed covered after the fixes: the `value=""` option (override back to
default `sale.test.tsx`, no-discount `sale.test.tsx`), the same-value
re-selection guard (`sale.tsx` guard + test), and `chooseSelectOption` asserting
the popup closes (`tests/e2e/select-helpers.ts`).

Remaining gaps it named and their disposition:

| Gap | Risk | Disposition |
| --- | --- | --- |
| quick-category Select had no unit open/select/close test | HIGH | Fixed in `8dbc7b2`: `sale.test.tsx` "opens the themed quick-add category select, selects, and closes" + value propagation. |
| discount type-switch semantics untested | MEDIUM | Deferred — pre-existing semantics unchanged; e2e sale-checkout exercises both discount modes. |
| reports CUSTOM → non-CUSTOM transition untested | MEDIUM | Partly covered: the e2e asserts a non-CUSTOM preset hides the custom bounds; switching away from CUSTOM is a plain state reset with no side effect. |
| keyboard path untested | LOW | Fixed in `8dbc7b2`: `reports.test.tsx` "closes the themed preset select on Escape without changing the value". |
| `visibleOptions()` dead helper | LOW | Fixed in `8dbc7b2`: removed. |

## Coverage analyst

Per acceptance criterion:

1. Four controls open/select/close — now automated for all four (unit for
   reports, discount, override, quick-category; e2e close assertion in the
   shared helper).
2. E2E via `tests/e2e/select-helpers.ts` — all four driven through
   `chooseSelectOption`, which now asserts `toBeHidden()` after commit.
3. Light + dark — was the largest gap (no dark render test). Fixed: the token
   contrast guard (`apps/web/src/lib/a11y-contrast.test.ts`) now asserts the new
   `--success`, `--warning`, `--success-foreground` and
   `--destructive-foreground` tokens meet 4.5:1 in **both** `:root` and `.dark`,
   including the `/10` and `/20` tints. Visual confirmation was also captured
   with light/dark screenshots during the work (popover bg `oklch(1 …)` vs
   `oklch(0.205 …)`, text inverted).
4. Same values/handlers/data-testids — preserved; `[name="discountType"]` and
   quick-category value propagation are asserted; `report-range-preset` moved to
   the trigger.
5. No raw palette/hex in scope — enforced by `shadcn/no-raw-colors`; survivors
   documented in the design doc §6.

Grade: B → the three residual gaps above are closed or explicitly deferred.

## Quality reviewer

Grade: B (round 1) → the remaining notes were duplication of the driver's event
sequence with `components/ui/select.test.tsx`, weak-null handling, and fixed
sleeps. The dead `visibleOptions()` export was removed; the event-sequence
duplication is inherent to the primitive test and left as-is (both suites green).

## Verdict

No blockers. All HIGH items fixed and re-verified. Deferred items are
behaviour-preserving and documented.
