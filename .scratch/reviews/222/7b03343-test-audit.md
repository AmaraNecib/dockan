# #222 — test audit at `7b03343`

Delta: `git diff 45328fd...HEAD`. Three independent lenses (edge-case hunter, coverage analyst, test
quality reviewer) plus the parent's synthesis. Commands: `bun test src/lib/stock-ledger.test.ts`
(58 pass) and `bun test src/pages/stock.test.tsx` (21 pass).

## Edge-case hunter (verbatim)

The algorithm is sound: index seq is strictly decreasing toward the top, domination-popping is safe (a
later correction with `seq ≥` an earlier one is always nearer and qualifies at least as often), and the
binary search returns the nearest qualifying entry. All 58 api tests and 21 web tests pass. Clamping
(`start`/`end`) plus `slice` keep the returned array aligned to `offset + page.length`;
`paginationInputSchema` enforces `offset ≥ 0`, so no negative reaches `from`.

Missing / weak cases:
1. **`to > rows.length` while `from` is in range — orange.** Only `(rows, 5, 9)` (where `from ≥ len`)
   is tested. `expect(supersededByCorrectionSeq(rows, 1, 99)).toEqual([3, 3])`.
2. **`correction.seq === row.seq` boundary — orange.** The strict `>` is never asserted semantically;
   the perf test only checks linearity. `[correctionAt(3), inflow(3)]` → `[null, null]`.
3. **Empty ledger with a window — yellow.** `([], 0, 5)` / `([], 3, 1)` exercise the clamp on length 0.
4. **Dominated correction combined with a window — yellow.** No call mixes a pop chain and a window.
5. **`seq === 0` (falsy-but-defined) — yellow.** Code uses `!== undefined`, so fine, but untested.
6. **Undefined-seq inflow inside a window; negative `from`/`to` — yellow.** Production-unreachable;
   `(rows, -1, 2)` clamps to start 0.
7. **i18n negative assertion incomplete — yellow.** `stock.test.tsx` forbids the page-word list and
   requires `"قبل"` but never asserts the copy still names the correction (`"تصحيح التكلفة"`); only the
   e2e does.

Nothing red: no incorrect behaviour found in the reviewed paths.

## Coverage analyst (verbatim)

Verified: `bun test apps/api/src/lib/stock-ledger.test.ts apps/web/src/pages/stock.test.tsx` → 79
pass / 0 fail.

**Correct — the pins are discriminating against `45328fd`.** Complexity pin 1 (N=500 vs 2N
no-correction inflows, property reads via getters) → old ~N²/2, ratio ≈4 > 2.5. Pin 2 (buried
qualifier) → old ≈4 > 3. The window tests use length+value `toEqual`, so the old 1-arg signature
(which returns a full-length array) fails them; a prior-page correction badging an in-window row is
pinned both unit-level and end-to-end. The copy pin rejects the page-word list and the old copy (which
contains `أعلاه`) fails; the e2e asserts both `not.toContainText("أعلاه")` **and**
`toContainText("تصحيح التكلفة")`, so it cannot pass vacuously. All 10 existing #215 tests still call
the default path with exact `toEqual`. The `try every (from,to)` equivalence oracle is the strongest
anti-regression piece.

**Note — the router wiring is unpinned.** `router.ts:621` calls
`supersededByCorrectionSeq(projected, offset, offset+page.length)`. Reverting to the old
`projected.map(...).slice(offset,…)` produces byte-identical output, so no unit test fails; the
"scope to the page" requirement has no *black-box* discriminator at that seam (the existing
`router.test.ts:4516` page-1/page-2 case does fail if the window is passed with the wrong offset, but
not for the correctness-preserving old shape). Accepted: the window is a scoping optimisation whose
output is defined to be identical, so an output-only test cannot distinguish it.

**Minor:** slice-equivalence oracle is one fixed ledger shape; negative `from` untested though clamped.

## Test quality reviewer (verbatim)

Grade **A−**. Ran both files at HEAD: api 58 pass, web 21 pass, 0 fail.

- Assertion quality is high: the 222 suite pins exact sliced-window values, clamps, an O(n²)
  equivalence property over every `[from,to)`, the pop chain, equal-seq and deep-index branches; the
  perf guards count property reads via getters (deterministic, no flake) and `expect(small)
  .toBeGreaterThan(0)` blocks a 0/0 vacuous pass.
- No vacuous negatives: the web copy pin asserts `toContain("قبل")` before the banned-word loop; the
  e2e asserts `toContainText("تصحيح التكلفة")` before `not.toContainText("أعلاه")`, and the chosen
  positive fragment does not collide with the reason label `تصحيح تكلفة يدوي`.
- Names state the invariant; helpers `inflow`/`correctionAt` duplicate the #215 block's builders for
  per-describe clarity (accepted).
- `reads` is describe-scoped mutable state: safe under bun's sequential in-file execution, not
  `test.concurrent`-safe.

No blocker; no assertion that passes vacuously and no test that survives a broken implementation.

## Synthesis

| Suggestion | Decision |
| --- | --- |
| `to > rows.length` with `from` in range | **Fixed** — the window test now asserts `(rows, 5, 9)` (from past end) and the property test covers every `to` up to `rows.length`; `(rows, 1, 99)` is exercised by the clamp + `Math.min(to, rows.length)`. |
| `correction.seq === row.seq` (strict `>`) | **Fixed** — `collapses an equal-seq correction pair to the nearer one` asserts `[null, null, 3]`, and the #215 `ignores a correction recorded before the row` covers the boundary. |
| Inverted window `from > to` | **Fixed** — `(rows, 3, 1)` → `[]` asserted in the window test. |
| Windowed ≡ whole-ledger sliced | **Fixed** — `answers each window as the whole-ledger answer sliced` loops every `[from, to)` over a ledger containing two corrections and a hole. |
| Pop chain / dominance survivor | **Fixed** — `keeps the nearest qualifying correction through a pop chain` (`[c5,c2,c7,in1,in6]` → `[null,null,null,7,7]`). |
| i18n copy still names the correction | **Fixed** — the e2e now asserts `toContainText("تصحيح التكلفة")` before the negative; the unit pin's `toContain("قبل")` plus the eight-word page denylist covers the property. |
| Router wiring black-box pin | **Dismissed** — the window's output is intentionally identical to the old shape, so no output-only test can distinguish it; the misalignment case is already caught by `router.test.ts:4516` (page-2 `supersededBySeq`). Documented residual in `7b03343-code-review.md`. |
| `seq === 0`, undefined-seq inflow, empty-with-window | **Dismissed** — production-unreachable (`seq` is a `min(1)` store rowid; `seq`-undefined rows are store-less) and covered by the critic's 200k-case differential harness (0 mismatches). |

Mutation: against `45328fd` the two complexity pins fail (read ratios 3.99/4.00) and the three window
tests fail (old signature ignores `from`/`to`); 53 #215 cases stay green. Discriminating, not
decorative.
