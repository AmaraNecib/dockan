# #249 — replace the regex scanner with a TypeScript AST walk

- Tier: **High-assurance** (recorded, unchanged from #244). Justification: the
  scanner is the guard for the money/stock readers; a gate it fails to detect can
  record a numeric value the owner never saw (failure modes 1-3: stock/avg-cost,
  totals, debt direction). This diff changes the guard itself, so it can violate
  the same failure modes the guard exists to prevent.
- Base: `origin/fix-244-blankness-ratchet` @ `ad8445f` (PR #246 head). #246 is
  **not** merged; `git merge-base origin/develop HEAD` == `746ff93` (#238/#243).
- Authority: commit only. This lane does **not** push, open a PR, merge or write
  `.agents/wisdom/`.
- Specification: the issue brief
  `.scratch/sessions/crew/briefs/issue-249-ast-walk.md` (owner-approved
  replacement, round 4 of #244).

## Problem

Four rounds of regex fixes each found a new *lexing* failure (line layout, inner
scope, `${}` as text, normalised keys, appended calls, comment separators, nested
templates), and round 4 introduced two new escapes while fixing three. Every one
is a rule a parser applies for free. The approach cannot converge.

## The seam (unchanged)

`apps/web/src/tests/blankness-gates.ts` keeps the same interface, so the ratchet,
`CLASSIFIED` and every #244 fixture keep their meaning:

- `srcRoot`, `BlanknessGate { file; line; signature }`
- `findBlanknessGates(source, file): BlanknessGate[]`
- `numericReaderFiles(): string[]` — **byte-for-byte unchanged**
- `scanNumericDraftReaders(): BlanknessGate[]` — unchanged
- every **signature string** unchanged (`file::<canonical gate text>`).

Replaced behind that seam: `scanSource`, the six inline matchers, `DECL`/
`collectDeclarations`/`breaksStatement`, `normalisesWholeValue`/`withoutSubscripts`,
and the `CHAIN` vocabulary — by `ts.createSourceFile()` + one recursive walk over
`CallExpression` / `BinaryExpression` / declarations.

## Detection (same vocabulary, parser-exact)

A **gate** is a comparison (`===`, `!==`, `==`, `!=`) whose blank operand is

- the empty string literal `""`, and whose other operand is a raw `.trim()` call
  (inline) or an identifier bound by a visible raw-trim declaration (two-step); or
- the numeric literal `0`, and whose other operand is `.trim().length` (inline)
  or an identifier's `.length` bound by a visible raw-trim declaration.

A `.trim()` receiver is **normalised** (skipped, not a raw gate) iff the receiver
is exactly a call to `normalizeArabicIndicDigits` / `draftBlank`, optionally
wrapped in parens. Because the AST receiver *is* the whole value, this replaces
`normalisesWholeValue` + `withoutSubscripts` with one exact rule:
`normalizeArabicIndicDigits(prefix).concat(draft)` is raw (the receiver is the
`.concat` call), `drafts[normalizeArabicIndicDigits(id)]` is raw (the receiver is
an element access), `normalizeArabicIndicDigits(drafts[id])` is normalised.

Receiver text and declaration scope come from the AST: `collapse(node.getText())`
for the signature, and "innermost preceding declaration whose scope contains the
comparison" for two-step visibility (an inner declaration cannot mask an outer
one). Signatures are unchanged, so `gate-set-diff` must report `ADDED []` /
`REMOVED []` at 32 gates.

## Fail closed

One recursive `ts.forEachChild` walk visits **every** node, so a `.trim()` call
cannot be skipped by a lexing desync. Every raw `.trim()` call is then classified
by its position:

- operand of a handled comparison → the gate above;
- anywhere else that is a *value use* (argument, initializer, property value,
  non-blank comparison, `??` operand) → not a gate, named as such;
- in a **test position the registry does not handle** → `BlanknessScanError`
  (a loud refusal, never silence). That covers truthiness (`!x.trim()`,
  `if (x.trim())`, `x.trim() ? a : b`, `a && x.trim()`), relational
  `.trim()`/`.trim().length` (`> 0`, `>= 1`), and an empty-template operand
  (`` ` ` ``).

The walk also sees regex literals, strings and templates as parser nodes, so a
regex holding `"`, `` ` ``, `//` or `/*` no longer desyncs the scan and no longer
hides a later gate; and gate text inside a string/template *text* is no longer
reported as a phantom gate.

## Ceilings (stated, with reasons)

Kept outside the walk, each a one-line reason:

- **Truthiness / relational tests on a raw trim or its `.length`** are
  *refused*, not detected (see above). Catching them would widen the gate
  vocabulary beyond `CLASSIFIED` (round 1: a trivial `.length` truthiness miss was
  found and fixed to a refusal).
- **Assignment-formed bindings** (`let t; t = d.trim()`), **destructuring**, and
  a **computed `.trim` property** (`d["trim"]()`) are not gate sources: they need
  dataflow or a property-name match the ratchet's vocabulary does not name.
- **`switch (t) { case "": }`** after a raw trim is not a comparison.
- **`Boolean(x.trim())`** is an explicit call, so its argument is a value use, not
  a test; the walk does not inspect call semantics.
- A **file that does not parse** is recovered by TS rather than refused:
  `parseDiagnostics` is a private field not inspected here. Production files parse
  clean.
- The scope rule is syntactic (no type checker): a parameter or `catch` binding
  shadowing a raw-trim local can still be attributed to the local (pinned as a
  ceiling). A `var` is hoisted to its function scope, so a closed block no longer
  hides it.
- The **refusal has a wide blast radius by design**: one legitimate
  `x.trim() || fallback` in any scanned file hard-fails the whole ratchet. That is
  the loud direction of fail-closed; a false refusal is reviewed, a silent miss is
  not.

## Planned tests (failing-first against the regex scanner)
`.scratch/reviews/249/ad8445f-before.log` records the regex scanner per shape.
Genuinely red before: non-ASCII binding, appended-normaliser inline, call /
`as` / paren / non-null receiver, double trim, `var` binding, second declarator,
regex literal with `/*` or `//`, string/template-text phantom gates, and the
three fail-closed refusals. Already caught by round 4 and kept as pins: comments
in any position, nested templates, inner-scope masking, appended-call two-step.

New fixtures in `apps/web/src/lib/blankness-ratchet.test.ts`, one per shape, plus
the fail-closed refusals. The existing 32 fixtures are re-run unchanged.

## Evidence plan

| proof | script | log |
| --- | --- | --- |
| shape table before/after | `.scratch/reviews/249/scanner-shapes-249.ts` | `ad8445f-before.log`, `<sha>-after.log` |
| gate set did not move | `.scratch/reviews/244/gate-set-diff.sh ad8445f` | `<sha>-gate-set-diff.log` |
| ratchet red/green | `bun test src/lib/blankness-ratchet.test.ts` | `<sha>-ratchet-first-red.log`, `<sha>-ratchet-green.log` |
| AST deletion proof | `.scratch/reviews/249/ast-branch-pin-proof.sh` | `<sha>-ast-branch-pin-proof.log` |
| mutation proof | `.scratch/reviews/244/390da2d-mutation-proof.sh` | `<sha>-mutation-proof.log` |
| guard Phase 1 / 2 | typecheck, lint, test / e2e | `<sha>-guard-phase1.log`, `<sha>-guard-phase2.log` |

## Implementation risks

- **Signature drift** in a canonical form → `gate-set-diff` catches it.
- **Over- or under-detection in production** from the receiver/scope rules →
  `gate-set-diff` and the ratchet's `CLASSIFIED` assertions catch it.
- **A fail-closed refusal firing on legitimate production code** → the 19 scoped
  files are walked by `scanNumericDraftReaders()` in the ratchet, so any refusal
  fails the suite loudly instead of shipping.

## Fixture deviation (documented)

The `#244` private-field fixture source was `this.#/* gap */draft.trim() === ""`
— a comment *inside* a private name. That is a syntax error (TS reports three
parse diagnostics; the regex scanner tolerated it by string surgery). Porting it
to valid syntax `this.#draft./* gap */trim() === ""` keeps the same receiver, the
same signature and the same intent (a private-field receiver stays whole; a
comment before `.trim()` is trivia). Every other `#244` fixture is byte-identical.

## Review round 1 (independent lenses at `353089e`)

Four read-only sub-agents: debate critic + defender, test-audit (edge/coverage/
quality) and code-review (Standards + Spec). Evidence:
`.scratch/reviews/249/353089e-{debate,test-audit,code-review}.md`.

- **Blocker (critic 8, code-review Spec worst), fixed in `53ed964`.** A bare
  `.trim().length` in a truthiness position (`if (x.trim().length)`,
  `!x.trim().length`, `x.trim().length ? a : b`, two-step `t.length`) returned
  `[]` with no throw: `classifyTrimUse` returned early on any `.length`, but the
  comparison walk only owns the `=== 0` / relational forms. Every raw
  `.trim().length` (inline or a binding's) now routes through the same
  test-position refusal, with a red-first fixture.
- **Note (critic 4), fixed.** `nearestScope` returned the nearest `Block`, so a
  `var` inside a closed block was hidden. A `var` now scopes to its function.
- **Test-audit pins added (A-):** `draftBlank` normaliser, CRLF line number,
  empty/comment-only source, single-quoted blank, the lexical-shadowing ceiling,
  and the `.length` truthiness refusal.
- **Deferred/statement-only:** the `Boolean(x.trim())` and parse-diagnostics
  ceilings above; the Standards judgement calls (Duplicated `unwrap`/
  `transparentParent` loops, the ~210-line `findBlanknessGates`, the
  `classifyTrimUse` dispatch chain). All are readability, not behaviour; the
  dispatch chain was the direct place the fixed blocker lived, and the new
  `.length` branch is now pinned by deletion.
- **Dismissed:** the defender's "ship it" on the seam (confirmed: `CLASSIFIED`
  byte-identical, gate-set-diff empty).

## Evidence

All at `53ed964`: `-after.log` + `ad8445f-before.log` (shape table),
`-gate-set-diff.log` (ADDED []/REMOVED [] at 32), `-ast-branch-pin-proof.log`
(14/14 branches), `-mutation-proof.log`, `-ratchet-green.log`,
`353089e-ratchet-first-red.log`, `-guard-phase1*.log`, and the review evidence.
