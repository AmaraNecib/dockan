# ef32177 — SPEC axis review (#244 round 4, PR #246)

Diff: `git diff 1af565f...HEAD` — 8 files, +619/-46. Spec: brief `fix-244-round4.md` (Greptile #246 findings 1-5; 6-13 not reworked).

## (a) Finding-by-finding

**1. Appended drafts escape detection — SATISFIED.**
Spec: "`NORMALISED_VALUE` does not require the normaliser to wrap the *whole* value… Match the normaliser's own closing parenthesis and reject trailing operations."
`synthetic.ts` test *"does not skip a raw gate when the normaliser does not wrap the whole value"* (`blankness-ratchet.test.ts:550-586`) asserts the `.concat(draft)` gate is caught; `ef32177-ratchet-first-red.log` shows it `fail` on the old scanner (`Received + []`), `round4-before.log` shows `appended draft escapes (finding 1) => [] (ESCAPES)`, `ef32177-ratchet-green.log` shows `32 pass`. Fix = `normalisesWholeValue()` (`blankness-gates.ts:229-250`): depth-matched closing paren, value must end there. Two positive controls included (whole-value skip; `")"` inside a string argument).

**2. Block comments join tokens — SATISFIED.**
Spec: "Preserve a separator; add a fixture with no surrounding spaces."
Fixture `const/* note */trimmed = draft.trim();` (no spaces) in the same-named test (`:588-604`); first-red and before-log both prove it escaped. Fix `fusesTokens`/`isWordCharacter` (`:133-137`) emits a space only between two word chars. Round-4 self-review regression is pinned: `insideChain` (`draft./* gap */trim()`) and `privateField` (`this.#/* gap */draft`) both stay matchable — the `#` boundary matters.

**3. Nested templates — SATISFIED.**
Spec: "`breaksStatement` still treats backticks as flat quotes, so a nested template can mis-scope the region."
Test *"does not read a `;` inside a nested template as a statement break"* (`:630-649`); first-red shows it `fail` before, before-log `[] (ESCAPES)`. Fix = `BreakFrame` stack (`code`/`quote`/`template`) with `${` push / `}` pop in `breaksStatement` (`:140-203`).

**4. Scope proof accepts runner errors — SATISFIED.**
Spec: "Require a green baseline and the expected failing assertion."
`scope-shrink-proof.sh` now runs a baseline (`baseline ratchet exit code: 0`), then requires `grep -qE '\(fail\).*names only files inside the scanned scope'`. `ef32177-scope-shrink-proof.log`: shrink → exit 1 with that assertion. Demanded failing-first demo present: `scope-shrink-guard-demo.sh` + log — CASE A old script `exit 0 … PASSED` with a crash and no assertion; CASE B new script `exit 1 … a crashed runner is not a detection`.

**5. Probe collisions — SATISFIED.**
Spec: "make them unique per run." `scanner-shapes.sh`/`gate-set-diff.sh` now use `$$-$RANDOM`, refuse an existing path, trap removes only their own files. `concurrent-probe-demo.sh` + log: CASE A old fixed path deleted a saved probe; CASE B two concurrent runs `0, 0`, saved probe byte-identical, no leftover. `ef32177-gate-set-diff.log` still `ADDED [] / REMOVED []`, 32 gates — the separator change did not move canonical signatures.

## (b) Scope creep
None material. All 8 files map to findings 1-5, their evidence, or guards. Extra `insideChain`/`privateField` fixtures and the KNOWN CEILING rewrite are regression/honesty guards for the separator change, not new work. Minor: the design doc points to "`<sha>-code-review.md` for the full argument", a file this diff does not add (forward reference).

## (c) Implemented-but-wrong
None found. Documented precision limits of the new fix are real and in the safe direction: `normalisesWholeValue` tracks quotes flat and `withoutSubscripts` strips `[`/`]` inside a string, so two *correctly* normalised values over-report (ceiling comment, `blankness-gates.ts:78-96`). The ceiling states both are over-report, never a hidden raw gate — correct, since a `true` from `normalisesWholeValue` is required to skip. No test pins these two over-reports; they are documentation-only.

## (d) Mandated approach answer
Design doc (`244-round4-design.md`, "The approach question"): **"the approach is the problem"**.
- **Concrete** — names the four passes to delete (`scanSource`, six inline matchers, `collectDeclarations`, `breaksStatement`), the AST node types (`CallExpression`, `BinaryExpression`, declaring scope), and what stays (`numericReaderFiles()`, `CLASSIFIED`).
- **Evidence-backed** — the four-round leak list (layout, inner vars, `${}` as text, normalised keys, appended calls, comment separators, nested templates), each with a `*-ratchet-first-red.log`; plus the KNOWN CEILING enumeration.
- **Plan** — one PR, port every fixture on the same signatures, then delete the regex branches and the branch-pin proof.
- **What would be lost** — offset stability for `gate-set-diff` (claimed recoverable: AST ranges are still source-anchored) and the synthetic matcher self-tests (claimed writable as "does the walk find this node"). Both are assertions, not demonstrated — no spike.
- **Falsifiability preserved** — same `CLASSIFIED` set, same failing-first fixtures rewritten against AST detection.

Verdict: the answer is concrete, plan-bearing and states the losses; the two loss-mitigations are asserted rather than evidenced.

Residual risk: `NormalisesWholeValue` shares the regex-literal blind spot (ceiling, unsafe direction) — explicitly deferred, not dismissed.
