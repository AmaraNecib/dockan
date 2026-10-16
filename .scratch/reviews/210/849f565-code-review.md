# #210 — Code-review evidence (standards + spec)

- Base: `a52084d1de0bda7fd3cb25ec5da5c778f04200ae`
- HEAD: `849f565c49ac665a421d2e5abdf0b0a9404e7a3b`
- Method: two independent axes (Standards, Spec), run in separate sub-agents per
  round so neither masks the other; round 3 re-checked the test-only delta.

## Standards axis

**Documented standards — no hard violations.**

- `.agents/wisdom/2026-10-15-extraction-must-not-tighten-money-readers.md`
  ("port the old predicate literally, including its generous cases, and pin
  those cases"): satisfied. `parseLooseNumber` is `Number()` after a
  digit-only replace; `1e3`, `0x10`, `12.5`, `"" → 0` are pinned, and the two
  page call sites swap `Number(x)` for it 1:1.
- `.agents/wisdom/2026-10-15-extraction-ordering-guard.md` (make the helper's
  scope explicit): the `normalizeArabicIndicDigits` docstring is scoped to
  "every money reader in this module"; the still-ASCII readers are enumerated
  in the design doc and tracked as #225.
- `AGENTS.md` merge/lane rules are parent-owned and not exercised by the diff.

**Baseline smells — judgement calls, all dispositioned:**

- *Speculative Generality* — the `parseLooseNumber` re-export in the UI-component
  barrel has no external consumer after the panel import moved to the lib.
  Dismissed: the barrel already re-exports the sibling readers; the surface stays
  symmetric.
- *Divergent import source* — resolved by the same move (panel now imports from
  `@/lib/amount-parse`).
- *Duplicated Code (tests)* — the ASCII↔Arabic digit-set helper is restated per
  test file. Accepted: the ticket asks each reader to carry its own pin.

## Spec axis (#210)

**In-scope requirements: complete.**

- sale override — `saleUnitPrice` → `nonNegativeOr` → `parseLooseNumber`,
  `saleOverrideInvalid`, and the submitted `priceOverride.value`;
- sale discount — `nonNegativeOr`/`discountAmountFor`, page `discountInvalid`,
  submitted `discount.value`;
- `parseWholePercentage` (initial payment / settle panels);
- `parseWholeAmount` (supplier-return quantities), plus the invoice-linked
  preview that reads the same draft — now through the same reader as submit.

**Scope creep:** none that changes a value. `select-driver.ts` is test-only; the
new `parseLooseNumber` export is the minimal way to widen the loose readers
without tightening ASCII.

**Implemented-but-wrong:** none found in three rounds.

**Documented caveat (not silent):** issue #210's literal acceptance says "every
numeric input". Three reader families remain ASCII-only and are listed in the
design doc's "Deliberately out of scope" section and filed as **#225**; bidi
formatting marks on paste are **#227**. This lane does not claim #210's literal
"every input" is done.

## Round-3 delta

Test-only (`supplier-return-panel.test.tsx`, `amount-parse.test.ts`, design doc).
No production path touched; no standard or spec implication.
