# #244 round 2 — the ratchet can be evaded; close the four evasions

- Tier: **High-assurance** (recorded, unchanged from round 1). Justification: the
  ratchet is the guard for the money/stock readers — a gate that slips through it
  unclassified can record a numeric value the owner never saw (failure modes 1-3:
  stock/avg-cost, totals, debt direction). The diff changes the guard itself, so
  it can violate the same failure modes the guard exists to prevent. Tier follows
  the failure mode, not the diff size (`docs/engineering-workflow.md`).
- Base for the reviewed delta: `5fbe0f0` (= `origin/fix-244-blankness-ratchet`,
  the PR #246 head, which is `HEAD`). Merge-base with `origin/develop`:
  `746ff933753a0b409e96365080c91e3ef6efb5b6` (#238 squash for #243).
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
`PAREN_FWD`, `INLINE_REV`, `INLINE_LEN`, then the two-step `USE`), so
`"" === draft.trim()`'s reversed inline match claims its span before `USE` can
read `"" === draft` out of the middle of it — and `trimmed === ""` on a line that
also holds an inline gate is no longer swallowed. Line numbers are recovered from
the match offset (`1 + newlines before offset`), so the reported line stays the
gate's own line.

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
  `const`/`let` chains. A declaration used before its block opens (TDZ-illegal
  anyway) is the boundary.
- Regex literals are not parsed, so an unbalanced `{`/`}` inside a regex literal
  can shift the scope chain (round 1 already declined regex-literal parsing).
  Balanced braces (the normal case, e.g. `/\d{1,3}/`) are neutral.
- A `.trim()` on the result of a call (`parseAmount(x).trim()`) is still outside
  the matched forms, so a declaration whose right-hand side is a call followed by
  `.trim()` is only seen through the call-chain text it contains.

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

- **Scope model wrong → a gate silently drops out of the ratchet.** Mitigated by
  asserting the production gate set stays at 33 raw gates + the classified
  converted-absent set; a drop shows up as a red `keeps every gate marked raw`
  assertion, not as silence.
- **Whole-text matching creates a false positive** (a gate reported that is not
  one). The safe direction for a ratchet (forces classification), and the
  production scan is compared gate-by-gate before/after.
- **`blankness-gates.ts` is itself a non-test source file** in `apps/web/src`; it
  does not import a reader, so it is outside the scanned scope and cannot
  self-report.
