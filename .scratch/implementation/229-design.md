# #229 — close the 2 Greptile findings on the Arabic-Indic money PR (design)

- Tier: **Standard** (test-only delta).
- Base: `origin/fix-210-arabic-indic-money` @ `fc439cdf02ec6da112fd25271d839f133578ecd0`
  (the PR #229 head). Merge-base with `origin/develop` is `1ea76b5`.
- Authority: commit only. This lane does **not** push and does **not** merge.
- Scope: `apps/web/src/components/parties/supplier-return-panel.test.tsx` (test +
  fixture) and the `229` review evidence. **No production change.** If a finding
  needed one, this lane stops and reports a blocker.

## Problem

Both Greptile findings on #229 are test-quality defects: the tests pass whether or
not the behaviour they claim to pin is present.

1. **`supplier-return-panel.test.tsx` (~179-182)** — the Arabic preview test swaps
   `٥` for ASCII `5` before `submit()`. It previews an Arabic draft and saves an
   ASCII one, so it would still pass if saving an invoice-linked return stopped
   accepting Arabic digits entirely.
2. **same file (~34)** — the shared invoice fixture was changed to
   `unitPrice: 400`, removing the zero-value case from the existing "free line"
   test. A change that wrongly disabled zero-value returns would no longer fail.

The failure mode is a pin that passes against the broken code: it converts an
untested path into a tested-looking one.

## Approach (two fixtures, one shared draft)

Keep **two** invoice lines in the `invoicesGet` mock instead of one shared,
mutated fixture:

- `l1` — `unitPrice: 0, netTotal: 0`: the zero-price "free line", kept for the
  zero-value return pin.
- `l2` — `unitPrice: 400, netTotal: 2000`: the priced line, used by every #210
  preview pin so a miscounted quantity shows up in the money.

The existing zero-value test types on `l1` and additionally asserts the preview
is `0`, so it pins both "value is zero" and "submit still enabled".

The Arabic preview test types `٥` on `l2`, asserts the preview is `2000`, then
submits **the same `٥` draft** and asserts the saved quantity is `5`. One draft,
previewed and saved.

The refused-draft test moves to `l2` as well: on `l1` everything previews `0`, so
it would pass against the loose `Number()` reader it exists to reject. On `l2`,
`1e3`/`1.5` render `0` only under the strict reader (the loose reader renders
`400000`/`600`).

## Interfaces / dependencies

None. Test file and `.scratch/` evidence only; no exported API, no component,
no router, no store changed.

## Planned tests

No new test cases are added; the two existing #210 pins are made
discriminating and the pre-existing zero-value pin is restored to a zero-value
fixture.

## Risk

- Adding `l2` must not perturb the other `l1` tests. Only lines with a non-empty
  quantity draft are submitted (`parseReturnQuantities` skips empty), so
  `submits exactly the selected line` still emits `[l1]`.
- The mutation proof is manual and local-only: mutate the source, observe the
  failure, revert. The tree must be verified clean of mutation markers before
  commit.

## Deliberately out of scope

- `#225` (remaining ASCII-only readers) and `#227` (pasted bidi marks) are
  separate tickets and are not pulled in.
- No production source change: a finding that needs one is a blocker, not a
  widened diff.
