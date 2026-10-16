# #244 round 2 — the ratchet can be evaded; close the four evasions

- Tier: **High-assurance** (recorded, unchanged from round 1). Justification: the
  ratchet is the guard for the money/stock readers — a gate that slips through it
  unclassified can record a numeric value the owner never saw (failure modes 1-3:
  stock/avg-cost, totals, debt direction). The diff changes the guard itself, so
  it can violate the same failure modes the guard exists to prevent. Tier follows
  the failure mode, not the diff size (`docs/engineering-workflow.md`).
- Round-2 delta base: `5fbe0f0` (= `origin/fix-244-blankness-ratchet`, the PR #246
  head — the round-1 commit). This lane's commits sit on top of it. Merge-base
  with `origin/develop`: `746ff933753a0b409e96365080c91e3ef6efb5b6` (#238 squash for
  #243).
- Authority: commit only. This lane does not push, open a PR, merge or write
  `.agents/wisdom/`.
- Specification: the Greptile comment on PR #246 (four findings) — read in full
  before touching code. Round 1's design is `.scratch/implementation/244-design.md`.

## Why this is the whole point of the PR

The ratchet's value is that a new raw-`.trim()` gate turns CI red. All four
findings let a gate through **unclassified** — the ratchet still *looks* green.
So every fix here needs a **failing-first** demonstration: the gate escapes
before, and is caught after. A scanner branch with no test that fails without it
is edited, not fixed.

## The four fixes

### 1. Line layout hides checks (`apps/web/src/tests/blankness-gates.ts`)

Two escapes, one cause: matching line-by-line and `continue`-ing a whole line
once anything on it matched.

- `draft.trim()` on one line and `=== ""` on the next returned no gate.
- `name.trim() === "" || trimmed === ""` reported only the inline check: the
  `if (inline) continue` skipped the rest of the line.

Fix: strip comments, then run every matcher over the **whole source text**, and
accept a match only when its `[start, end)` span does not overlap an
already-accepted span. Inline forms win the priority order (`INLINE_FWD`,
`PAREN_FWD`, `INLINE_REV`, `INLINE_LEN`, `INLINE_LEN_REV`, then the two-step
`USE_FWD`/`USE_LEN_FWD`/`USE_REV`/`USE_LEN_REV`), so `"" === draft.trim()`'s
reversed inline match claims its span before a two-step matcher can read
`"" === draft` out of the middle of it — and `trimmed === ""` on a line that also
holds an inline gate is no longer swallowed. Line numbers are recovered from the
match offset (`1 + newlines before offset`), so the reported line stays the gate's
own line.

The declaration scan (`DECL`) also moves to the whole text and its right-hand
side may cross a line break (`const trimmed =\n draft.trim();`), stopping at a
statement break (`;`, `}`, or a new line that opens a new statement). That closes
the sibling escape "write the declaration on two lines" that the line-by-line
version also missed. It is **not** one of the four findings; it is the same
defect class and it is cheap to close, so it is closed and tested.

### 2. An inner variable hides an outer check (`blankness-gates.ts:154-158`)

The lookup took the last earlier declaration **with the same name anywhere in the
file**. A normalised declaration in a nested block therefore masked an outer raw
`trimmed === ""`.

Fix: give each declaration and each comparison a **scope chain** (the brace pairs
that enclose its offset, computed on the comment-stripped text) and only accept a
declaration whose chain is a prefix of the comparison's chain. The innermost
visible declaration wins. Object-literal braces add depth but never break
ancestry, so they are harmless; JSX `{}` and template `${}` are balanced.

### 3. The mutation proof discards local edits (`.scratch/reviews/244/390da2d-mutation-proof.sh`)

`git diff "$BASE" -- "$f"` folded uncommitted edits into the reversed patch, and
`git checkout -- "$f"` then restored the **index** version, destroying them.

Fix, in the cited file:

- **Refuse to start** when any listed file is dirty (`git status --porcelain -- "$f"`).
- **Preserve and restore exact bytes**: back every listed file up to a
  `mktemp -d` copy before mutating, and restore from the copy in an `EXIT` trap —
  independent of git's index.
- `mktemp` for the patch file instead of a fixed `/tmp/mut.patch` (a shared path
  two lanes can clobber).
- Check `git apply -R` succeeded, and fail loudly if it did not.

**Never `git stash`** (`.agents/wisdom/2026-10-14-git-stash-pathspec-pops-unrelated-stash.md`):
`git stash push -- <path>` with nothing to stash pops an unrelated stash.

The file keeps its `390da2d-` name (it is the tool the finding cites, and its logs
are separate artifacts) but is now safe to rerun; the round-2 run is logged as
`<round2-sha>-mutation-proof.log`.

### 4. Two-step matchers lack self-tests (`blankness-ratchet.test.ts`)

Added synthetic fixtures, in both directions, each of which must fail against the
unfixed scanner:

- forward two-step `const trimmed = draft.trim(); … trimmed === ""`,
- reversed two-step `const trimmed = draft.trim(); … "" === trimmed`,
- a **normalised** two-step declaration that must produce **no** gate,
- the split-across-lines inline gate,
- the inline-plus-two-step line,
- the inner-scope-masks-outer raw gate.

The reversed `USE` canonical text now keeps its operand order
(`"" === trimmed [draft.trim()]`), matching the inline forms, so the two branches
are distinguishable in `CLASSIFIED` and in evidence instead of collapsing onto one
signature. No production gate is reversed, so `CLASSIFIED` does not change shape
for it.

## Deliberate ceiling (stated, not implied)

The matcher stays **syntactic**. The round-1 ceiling stands: a bare truthiness
gate (`if (!d.trim())`), a call-expression receiver (`f().trim()`), and a numeric
gate in a file that does not import a reader are not caught. Added in round 2:

- `var` hoisting / function-scope visibility is not modelled — only brace-scope
  `const`/`let` declared at the declaration site, so a comparison of a `var`,
  parameter, `catch` or post-`let`-assignment binding can be attributed to a
  same-named visible declaration (false positive), and a value assigned after a
  bare `let t; t = d.trim()` is not seen at all (false negative). An ASI-ambiguous
  `const t = foo` above `bar.trim()` attributes that `.trim()` to `t` (false
  positive with invented receiver text).
- Regex literals are not parsed, so a regex holding a quote (e.g. `/['"]/`) or a
  `/*` can mis-scope the file or **hide every later gate in it** (the unsafe
  direction), and a comment after such a regex can be read as code (false
  positive). Round 1 declined regex-literal parsing; round 2 states the severity
  honestly and leaves it a **deferred follow-up**, because a half-lexer that
  mis-reads division as a regex would create a new false negative.
- A `.trim()` on the result of a call (`parseAmount(x).trim()`) is outside the
  matched forms **inline** (`f().trim() === ""`); a two-step
  `const t = f().trim()` **is** caught.
- A relational `.length` test (`d.trim().length > 0`, `>= 1`) is not matched; only
  the equality/inequality against `0` is (both operand orders, inline and two-step).
- The blank operand must be a `""`/`''` literal; an empty template literal operand
  is not matched.
- A string or template literal whose **text** looks like a gate is scanned as
  code (false positive). Blanking string bodies was **rejected**: it would also
  hide a real gate inside a template `${}` expression, which is the unsafe
  direction for a ratchet. A false positive only forces a `CLASSIFIED` line.

None of the four findings is in this ceiling; each of the four is fixed and
pinned by a test that fails without the fix.

## Planned tests / evidence

- `apps/web/src/lib/blankness-ratchet.test.ts` — the six fixtures above, plus the
  existing production ratchet (unclassified / raw-present / converted-absent).
- Failing-first logs: `.scratch/reviews/244/<sha>-ratchet-first-red.log` (new
  fixtures red on the unfixed scanner) and `-ratchet-green.log`.
- Mutation proof: per converted file, revert to the raw form and red the ratchet;
  `.scratch/reviews/244/<sha>-mutation-proof.{sh,log}`. Plus a standing
  demonstration that the script's new guard refuses a dirty listed file and
  preserves exact bytes (temp-repo demo, logged).
- Guard Phase 1/2: `bun run typecheck`, `bun run lint`, `bun run test`.
- Review lenses (independent sub-agents): debate, test-audit, code-review —
  `.scratch/reviews/244/<sha>-{debate,test-audit,code-review}.md`.

## Implementation risks

- **Scope model wrong → a gate silently drops out of the ratchet.** Two guards:
  a red assertion when a `CLASSIFIED` signature's file leaves `numericReaderFiles()`,
  and `.scratch/reviews/244/scope-shrink-proof.sh`, which narrows the surface and
  shows the ratchet reddens (then restores exact bytes). The production set is
  **32 raw gates + 14 converted-absent entries = 46 classified keys**, compared
  gate-by-gate before and after the rewrite (`ADDED []` / `REMOVED []`).
- **Whole-text matching creates a false positive** (a gate reported that is not
  one). The safe direction for a ratchet (forces classification), and the
  production scan is compared gate-by-gate before/after.
- **`blankness-gates.ts` is itself a non-test source file** in `apps/web/src`; it
  does not import a reader, so it is outside the scanned scope and cannot
  self-report.

## Beyond the four findings (closed in this round)

Escapes and over-reaches of the same class were found by the round-2 review lenses
and closed here, each with a failing-first fixture (red before, green after):

- **Reversed `.length`** (`0 === draft.trim().length`) — an evasion: the reversed
  inline `=== ""` form was matched but the reversed `.length` form was not, an
  asymmetry of exactly the kind finding 4 names.
- **A receiver name that merely contains a normaliser name** — the inline
  normaliser guard used a substring match, so `draftBlankish.trim() === ""` was
  silently skipped. The normaliser is now matched as a **call** and the inline
  check is gone: an inline receiver is a member chain, so it can never be a call.
- **A property read attributed to a local** (`other.trimmed === ""`, and the
  reversed `"" === trimmed.suffix`) — a false positive; closed with
  `(?<![\w$.])` on the forward and `(?!\s*\.)` on the reversed two-step matcher.
- **A `.trim()` chain the formatter broke across lines** (`draft\n  .trim() === ""`,
  `draft.trim()\n  .length === 0`) — the chain matchers now allow whitespace inside
  the chain; the canonical text still collapses it away.
- **A declaration whose right-hand side holds a bracketed group**
  (`parse({ raw: draft }).trim()`, `` `${draft}`.trim() ``) — the statement-break
  check was a regex over `;`/`}`, so any `}` in an argument hid the declaration.
  Replaced by a bracket-depth scan: only a `;`, a closing bracket at depth 0, or a
  new statement ends the right-hand side.
- **The two-step `.length` gate** (`const t = draft.trim(); t.length === 0`, either
  operand order) — matched now, keyed on `.length` so ordinary numeric
  comparisons against `0` are not swept in.

## Review round 2 — findings verified, then fixed or dismissed

Seven read-only lenses at `ad884d1` (debate critic + defender, test-audit
edge/coverage/quality, code-review standards + spec). Every finding was verified
against the code before acting:

- **Fixed:** the three extras above; the scope-coverage assertion
  (`numericReaderFiles()` shrinking was invisible for `draftBlank`-only files,
  which falsified this doc's own earlier mitigation claim); the gate count in this
  doc (32 raw, not 33); the stale "`5fbe0f0` is `HEAD`" wording; the guard demo's
  `git show HEAD:` lookup (it must pin `5fbe0f0`, or Case A is a false FAIL at any
  later HEAD, since the fix is itself committed) and its Case C (the throwaway
  repo now carries a real ratchet test, so the log shows a genuine `(fail)` on
  every revert).
- **Dismissed — false:** "the inline normaliser guard is dead code" (it is
  reachable, and wrongly skipped substring-named receivers — fixed anyway), and
  "a duplicate `CLASSIFIED` key silently drops a classification" (46 keys, 46
  verdict lines; the 47th `verdict:` match was the interface field — the real
  defect was only the doc's count).
- **Dismissed — valid but out of round:** scanning a string/template literal's
  text as code (false positive). Blanking string bodies would hide a real gate
  inside a template `${}` expression, so it is stated in the ceiling instead.
- **Honest note:** the guard demo earned its keep — it caught a stale loop index
  in the fixed script's restore step (`cp -p "$BACKUP_DIR/$i" "$f"` while `$f`
  came from a different loop), which would have restored every file from the last
  backup. The script now iterates `"${!FILES[@]}"` and proves byte-exact restore.

## Result

One source commit plus an evidence commit. The scanner rewrite, the three extra
closes and the ratchet fixtures are in the source commit; the logs named
`<sha>-*` in `.scratch/reviews/244/` are the evidence at that SHA.

## Evidence at this round's head SHA

- `<sha>-ratchet-first-red.log` — the 8 new fixtures red on the round-1 scanner
  (5 for the four findings, 3 for the extras).
- `<sha>-ratchet-green.log` — 16/16, 32 production gates classified.
- `<sha>-mutation-proof.log` (tool: `.scratch/reviews/244/390da2d-mutation-proof.sh`,
  the path Greptile cited) — 11 converted files reverted, each reddens the ratchet,
  exact bytes restored (exit 0).
- `<sha>-guard-demo.log` — finding 3: the unfixed script destroys a local edit,
  the fixed script refuses and preserves it, and a clean run restores
  byte-identical while reddening on every revert.
- `<sha>-scope-shrink-proof.log` (tool: `.scratch/reviews/244/scope-shrink-proof.sh`)
  — a narrowed scanned surface reddens, then the scanner is restored
  byte-identical and green.
- `<sha>-gate-set-diff.log` — the production gate set is compared gate-by-gate
  between the reference SHA and the rewrite: 32 gates, `ADDED []`, `REMOVED []`.
- `<sha>-scanner-shapes.log` — the scanner's observed result for 20 attack shapes
  (the ones the lenses tried), so "caught" vs "stated ceiling" is inspectable.
- `<sha>-guard-phase1.log`, `<sha>-guard-phase2.log` — the named gate commands
  and their exit codes.
- `<sha>-{debate,test-audit,code-review}.md` — the seven lens reports, plus
  `<sha>-review-context.md`, the shared brief they read.
