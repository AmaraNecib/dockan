# #244 round 4 — three more scanner escapes, two proof-harness holes, and the approach question

- Tier: **High-assurance** (recorded, unchanged from round 1). Justification: the
  ratchet is the guard for the money/stock readers — a gate that slips through it
  unclassified can record a numeric value the owner never saw (failure modes 1-3:
  stock/avg-cost, totals, debt direction). This diff changes the guard itself, so
  it can violate the same failure modes the guard exists to prevent.
- Round-4 delta base: `1af565f` (= `origin/fix-244-blankness-ratchet`, the PR #246
  head — round 3's evidence commit). Merge-base with `origin/develop`:
  `746ff933753a0b409e96365080c91e3ef6efb5b6` (#238 squash for #243).
- Authority: commit only. This lane does not push, open a PR, merge or write
  `.agents/wisdom/`.
- Specification: the Greptile comment on PR **#246**, findings **1-5** (6-13 are
  the round-1..3 list and already fixed; not reworked here). Read in full before
  touching code. Round-3 design: `.scratch/implementation/244-round2-design.md`.

## Why this is the whole point of the PR

The ratchet's value is that a new raw-`.trim()` gate turns CI red. Findings 1-3
each let a gate through **unclassified** — the ratchet still *looks* green. So each
fix needs a **failing-first** fixture: escaping before, caught after (evidence:
`round4-before.log`, `<sha>-ratchet-first-red.log`). Findings 4-5 are holes in the
proof harnesses that could report a green proof that proved nothing.

## The five fixes

### 1. An appended call escapes the normaliser check (`apps/web/src/tests/blankness-gates.ts`)

`NORMALISED_VALUE = /^(?:normalizeArabicIndicDigits|draftBlank)\s*\(.*\)$/` does not
require the normaliser to wrap the *whole* value: greedy `.*` consumed the trailing
`.concat(draft)` in
`const trimmed = normalizeArabicIndicDigits(prefix).concat(draft).trim()`, so the
declaration looked normalised and the following `trimmed === ""` produced nothing.

Fix: replace the regex with `normalisesWholeValue()`. It matches the normaliser
call's opener, walks to the **matching** closing parenthesis by depth (skipping
quoted text, so a `)` in an argument does not close it early) and requires the
value to end there. A trailing `.concat(...)` therefore makes the declaration raw
again. `draftBlankish(...)` never matches (the call needs `(`), and a normaliser
that is only an argument of another call still does not match. Provenance:
`normalisesWholeValue(withoutSubscripts(rhs))` — the subscript half (round 3) is
unchanged.

### 2. A block comment joins tokens when removed (`blankness-gates.ts`, `scanSource`)

Comments were removed with **no separator**, so `const/* note */trimmed = …`
became `consttrimmed = …`, `DECL` lost the declaration, and the gate that used it
produced nothing.

Fix: a comment is a **token separator**, but only where a separator is needed.
Emitting one space where a block comment closes between two word characters keeps
`const` and `trimmed` distinct; the space is emitted only at that boundary (two
word characters), so anywhere else the comment is dropped exactly as before and a
chain it interrupted (`draft./* note */trim()`) still reads as `draft.trim()` and
is still matched. (An always-a-space version regressed that chain — caught in the
round-4 self-review, pinned by the `insideChain` fixture.) The canonical
signature collapses whitespace, so no existing signature changes (verified:
`gate-set-diff` ADDED/REMOVED both empty).

### 3. `breaksStatement` treats backticks as flat quotes (`blankness-gates.ts`)

For ``const trimmed = `${flag ? `;` : draft}`.trim()``, the inner backtick closed
the single `quote` state, the `;` read as a statement break, and the declaration
was discarded — losing a gate whose false branch trims the raw draft.

Fix: `breaksStatement` now uses the same nested-region model as `scanSource` — a
frame stack of `code` / `quote` / `template`, where `${` pushes a code frame and
its matching `}` pops it. A `;` in a nested template's TEXT is text, not a break.
The bracket-depth semantics for `(`/`[`/`{` and the newline + statement-keyword
rule are unchanged.

### 4. `scope-shrink-proof.sh` accepts a runner error (`.scratch/reviews/244/scope-shrink-proof.sh`)

The script accepted any nonzero mutated run as a detection and could print
`PASSED` when the runner errored on the mutated run and was green after restore.

Fix, the same standard the mutation and branch-pin proofs already use:
- require a **green baseline** before the mutation;
- require the **expected failing assertion**
  (`(fail) … keeps every raw verdict present in the source`) in the mutated
  output, read **before** the restored run overwrites it (separate `mktemp` output
  files, not one shared `$OUT`).

Failing-first demo: `.scratch/reviews/244/scope-shrink-guard-demo.sh` runs the old
and new script against a throwaway repo whose shrink makes the ratchet **crash**
(no failing test). Old → exit 0, "PASSED"; new → exit 1, "without the expected
failing assertion". The expected assertion is the scope one,
`(fail) … names only files inside the scanned scope`. Evidence log:
`<sha>-scope-shrink-guard-demo.log`.

### 5. Probe files can collide (`.scratch/reviews/244/gate-set-diff.sh`, `scanner-shapes.sh`)

Both scripts wrote fixed probe paths under `apps/web/src/tests/` and deleted them
on exit: a saved probe could be overwritten/deleted, and two concurrent runs could
clobber each other.

Fix: the probe module names are unique per run (`$$-$RANDOM`), the script refuses
to run if the path already exists, and the `EXIT` trap removes only files this
invocation created. `gate-set-diff.sh` substitutes the unique old-module name into
the probe's import via `sed`. Pinned by
`.scratch/reviews/244/concurrent-probe-demo.sh`, which runs `scanner-shapes.sh`
and `gate-set-diff.sh` CONCURRENTLY and asserts both pass and neither probe path
survives.

## Evidence plan

| proof | script | log |
| --- | --- | --- |
| failing-first shapes | `apps/web/src/tests/__round4-probe.ts` (removed after) | `round4-before.log` |
| ratchet first-red / green | `bun test src/lib/blankness-ratchet.test.ts` with the old/new scanner | `<sha>-ratchet-first-red.log`, `<sha>-ratchet-green.log` |
| observed shape table | `scanner-shapes.sh` | `<sha>-scanner-shapes.log` |
| gate-set unchanged | `gate-set-diff.sh` | `<sha>-gate-set-diff.log` |
| scope shrink reddens | `scope-shrink-proof.sh` | `<sha>-scope-shrink-proof.log` |
| scope-shrink guard demo | `scope-shrink-guard-demo.sh` | `<sha>-scope-shrink-guard-demo.log` |
| unique probe paths | `concurrent-probe-demo.sh` | `<sha>-concurrent-probe-demo.log` |
| mutation + branch-pin + baseline guard | round-3 scripts, re-run on this HEAD | `<sha>-*.log` |
| guard Phase 1 / 2 | typecheck, lint, test / e2e | `<sha>-guard-phase1.log`, `<sha>-guard-phase2.log` |

## The approach question (answer, not code)

Asked by the brief: is regex still the right tool, or is the hand-rolled lexer the
problem? Answer, with evidence: **the approach is the problem** — this is the
fourth round and each round found real leaks the previous fix missed. See
`<sha>-code-review.md` for the full argument; the short form:

- Rounds 1-4 found, in order: line layout, inner variables, `${}` as text,
  normalised keys, appended calls, comment separators, nested templates. Every
  one is a lexing rule a real parser applies by construction.
- An AST walk (`ts.createSourceFile()` + child walk) gets comments, strings,
  templates, regex-vs-division, ASI and scope for free, and it fails *closed*:
  a shape it does not understand is a node it reports, not a blind spot.
- The remaining regex leak surface is **not** small or enumerable: the KNOWN
  CEILING comment already lists ~15 shapes, and finding 3 showed even the
  sub-lexer (`breaksStatement`) has the same class of bug.
- What would be lost: offset stability for `gate-set-diff` (an AST gives ranges,
  so the signature is still source-anchored — recoverable), and the synthetic
  matcher self-tests (they would move from "does this regex fire" to "does the
  walk find this node" — still writable). The ratchet's falsifiability is
  preserved by keeping the same `CLASSIFIED` set and the same failing-first
  fixtures, now written against AST detection.
- Plan (owner decision, not this lane): one PR that replaces the two regex passes
  (`scanSource` + the six inline matchers + `collectDeclarations`/`breaksStatement`)
  with `ts.createSourceFile` + a walk over `CallExpression` (`.trim()`),
  `BinaryExpression` (`=== ""`, `.length === 0`) and the enclosing declaration
  scope; keep `numericReaderFiles()` and `CLASSIFIED` unchanged; port every
  existing fixture to the new scanner on the same signatures; then delete the
  regex matcher branches and their branch-pin proof.
