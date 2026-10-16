# #210 — Debate evidence

- Base: `a52084d1de0bda7fd3cb25ec5da5c778f04200ae` (origin/develop)
- HEAD: `849f565c49ac665a421d2e5abdf0b0a9404e7a3b`
- Diff: `git diff a52084d...HEAD`
- Method: critic + defender sub-agents, read-only, over the full diff plus the
  design doc. Rounds 1 and 2 ran 7 agents each (debate, test-audit, code-review
  axes); round 3 verified the test-only delta. Findings below are dispositioned,
  not just listed.

## Blocker / must-fix

**Critic 7 — supplier-return preview vs submit reader split.**
`supplier-return-panel.tsx` previewed the shared quantity map with
`parseLooseNumber` while `parseReturnQuantities` submitted with
`parseWholeAmount`: `1e3` previewed 1000 and `1.5` previewed fractional money,
both of which submit refuses. **Fixed** in `d0f1ae8`: the preview now reads
`parseWholeAmount(draft) ?? 0`, the same reader as submit. Round 2 traced every
draft (`1e3`, `5.5`, `abc`, `-5`, `0`, `٥`, `۵`) and confirmed preview and submit
agree; a panel test pins refused-draft → 0 and the Arabic value → the submitted
quantity. Round 3 proved the pin is discriminating (it returns 400000/600 on the
pre-revert code, so it fails without the fix).

## Fixed (review round 1 / 2)

| Finding | Fix |
|---|---|
| Docstring "**Every** money reader" over-claimed repo-wide (`amount-parse.ts`) | scoped to "every money reader **in this module**" |
| Panel imported a parser from the UI-component barrel | imports `parseWholeAmount` from `@/lib/amount-parse` |
| `select-driver.findOption` treated `""` aria-controls as a scope, not unscoped | empty string handled as unscoped |
| Bidi/edge pins missing (mixed script, padded loose read, sign, ceiling) | pinned in `amount-parse.test.ts` |
| Mixed-script loose grammar unpinned (`١e٣` composes `1e3`) | pinned (`١e٣`→1000, `٠x١٠`→16; strict reader still null) |
| Free-standing Arabic quantity untested | panel test types `٥`, submits, asserts `quantity: 5` |
| Refused-draft preview test was a false positive (`toContain("0")` matched 400000) | rewritten to extract the exact preview number; round 3 proved it fails on the old reader |

## Deferred (documented, follow-up issues)

- **#225** — readers still ASCII-only: `nextUnitCost` (purchase unit cost),
  `lib/numeric-input.ts` (`parseWholeNumber`/`parseSignedWholeNumber`), sale
  quick-add cost/sell, `invoice.tsx` customer-return quantities, the
  free-standing supplier-return *amount*. Each is its own money review. None
  reads a draft a #210-widened reader also reads, so none is self-inconsistent.
- **#227** — bidi formatting marks (RLM/LRM) on a pasted Arabic-Indic number
  defeat the digits-only test; `parseWholeAmount("\u200f٥")` is null. Stripping
  non-digit formatting marks affects every reader including ASCII, so it is its
  own change with its own ASCII-identity pin.

## Dismissed (considered, not actioned)

- **Same-page reader split** (discount `parseLooseNumber` vs payment
  `parseGroupedAmount`). Pre-existing and deliberate: the loose readers preserve
  the historical `Number` grammar (`1e3`, `0x10`, `12.5`, `""`), and swapping in
  the grouped reader would change which ASCII drafts are accepted — the exact
  tightening `.agents/wisdom/2026-10-15-extraction-must-not-tighten-money-readers.md`
  forbids.
- **Arabic decimal separator `٫` (U+066B)** not normalised in the loose readers
  (`"12.5"` reads 12.5, `"١٢٫٥"` reads NaN). The normaliser maps digits only by
  design (pinned risk in the design doc); the strict readers reject the ASCII
  decimal too, and validation refuses the fractional draft, so no money moves.
- **`parseGroupedAmount` normalises twice** (it calls `parseWholeAmount`).
  Idempotent and cheap; no behaviour change.
- **`parseLooseNumber` barrel re-export** (`amount-percentage-input.tsx`) has no
  external consumer after the panel import moved. Kept for symmetry with the
  sibling readers the barrel already re-exports; removing one name buys nothing.
- **`parseLooseNumber` docstring pins `0x10`→16** as accepted. That is the
  historical `Number` behaviour the wisdom doc requires preserving literally.
- **e2e quick-add setup duplication** in `sale-checkout.spec.ts`. Test-cleanup
  only, out of scope.
- **`previewAmount()` depends on `Amount` rendering ungrouped.** Verified true
  today (`amount.tsx` renders the raw value; grouping would come from
  `formatPrintAmount`, which it does not use). Noted; if `Amount` adopts
  grouping, a data attribute on the preview is the robust fix.
