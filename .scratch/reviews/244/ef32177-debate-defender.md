# Defense of `1af565f...ef32177` (#244 / PR #246, findings 1–5)

Verdict: all five fixes are real, failing-first, and the two review-round corrections removed
new escapes rather than papering over them. No blocker found.

## 1. Appended call no longer escapes (finding 1) — confidence 9/10

`NORMALISED_VALUE` is gone; `normalisesWholeValue()` (`blankness-gates.ts:232`) matches the
normaliser opener, walks to the **matching** close by depth, and requires nothing after it.
Critic's "hand-rolled depth walk" complaint is fair but the alternative is worse: keeping
`.*` is strictly less precise, and an AST walk is a PR the brief explicitly defers.
Failing-first is proven: `ef32177-ratchet-first-red.log` (line 561) shows `[]` before,
`ef32177-ratchet-green.log` shows the gate with the full
`normalizeArabicIndicDigits(prefix).concat(draft).trim()` signature. Precision controls (whole
value still `[]`, `)` inside a string argument still `[]`) are in
`blankness-ratchet.test.ts:566-585`. `scanner-shapes.log` line
`appended normalised prefix => …concat(draft).trim()]` is independent confirmation.

## 2. Block comment as separator (finding 2) — confidence 8/10

The first cut ("always a space") was a genuine new escape; the self-review caught it and the
final rule at `blankness-gates.ts:134-136` + `:332` emits a space **only** where two word
characters would fuse. Evidence: red-before at `ratchet-first-red.log` (line 590), green
after; `insideChain` (`blankness-ratchet.test.ts:609-622`) and the private-field fixture
(`:622-634`) pin the two shapes an always-a-space rule would have broken. Sparse insertion is
the defensible choice: it keeps `out` offsets and brace pairs aligned with `source` for every
other character, so nothing downstream that counts depth shifts.

## 3. Nested templates in `breaksStatement` (finding 3) — confidence 9/10

The frame stack (`blankness-gates.ts:148-196`) mirrors `scanSource`'s model, so a `` ; `` in
template TEXT is text. Red-before at `ratchet-first-red.log` (line 648), green after;
`scanner-shapes.log` `nested template => …[`${flag ? `;` : draft}`.trim()] @L2`. The
`(`/`[`/`{` depth semantics and the `\n`+keyword rule are unchanged, which is why 29
pre-existing tests still pass unchanged (`ef32177-ratchet-green.log`).

## 4. Scope proof no longer accepts a runner error (finding 4) — confidence 9/10

`scope-shrink-proof.sh` now demands a green baseline **and** the scope assertion itself,
read from separate `mktemp` files before the restore overwrites it.
`ef32177-scope-shrink-guard-demo.log` is the strongest artifact in the set: CASE A shows the
old script printing `PASSED` on a crashed shrink ("a proof that proves nothing"), CASE B shows
the new script exit 1 with `without the expected failing assertion`. `scope-shrink-proof.log`
shows the healthy path: baseline 0 → mutated 1 on `names only files inside the scanned scope`
→ restored 0.

## 5. Unique probe paths (finding 5) — confidence 8/10

`concurrent-probe-demo.sh:20-46` is failing-first: CASE A shows the old fixed path **deleting**
a saved probe; CASE B runs two `scanner-shapes.sh` concurrently, asserts both exit 0, asserts
the saved probe's sha256 is unchanged, and asserts no `__scanner-shapes.*` leftover. The
refuse-if-exists guard plus an EXIT trap installed before creation is the standard fix; nothing
in the design rests on a weaker check.

## The two review-round corrections

- **Round-4 self-review** (`3a1a1ae`): conditional separator, above. Real regression found and
  fixed before review — evidence that the fixture discipline works.
- **Round-2 review** (`ef32177`): `#` removed from the fusion set (`:134`), so
  `this.#/* gap */draft.trim() === ""` stays `this.#draft.trim() === ""` instead of being
  re-attributed to an invented `draft` receiver — pinned at `blankness-ratchet.test.ts:622`.
  Same commit corrected the stale `NORMALISED_VALUE` citation in the `withoutSubscripts`
  docstring (`:257-264`) and extended the ceiling note to `normalisesWholeValue`.

## Unsupported / weakly supported claims (name them)

1. **`<sha>-guard-phase2.log` does not exist for `ef32177`** (only `ef32177-guard-phase1.log`).
   The design doc's evidence table (`244-round4-design.md:115`) claims a Phase-2 e2e log at this
   HEAD. Phase-2 (e2e) coverage at `ef32177` is therefore **unproven**.
2. **`<sha>-code-review.md` does not exist for `ef32177`**; the design doc (`:122`) points at it
   for "the full argument" on the approach question. The short form in the doc stands alone;
   the cited file is missing.
3. **The design doc never mentions the round-2 `#`/private-field correction** — the commit
   message and code comments do. The doc is honest about the code, one revision behind on the
   correction list.

Residual risks: `normalisesWholeValue` tracks quotes flat and `withoutSubscripts` strips `[`/`]`
in strings — both documented as **over-report** (safe direction) in the ceiling note
(`:78-93`), and `ratchet-green.log` shows the real reader surface unchanged (32/32,
`gate-set-diff` ADDED/REMOVED both empty). The regex-literal ceiling remains open by design,
not by omission.
