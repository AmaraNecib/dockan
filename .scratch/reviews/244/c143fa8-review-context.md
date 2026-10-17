# #244 round 2 — review context (shared by all lenses), HEAD `c143fa8`

READ-ONLY review. Do not create, edit or delete any file. Base every claim on
files you read; cite `file:line`. If you cannot run a command, do not invent its
output.

Reviewed delta: `git diff 5fbe0f0...c143fa8` (5fbe0f0 = PR #246 head, the round-1
commit; c143fa8 = this lane's fifth commit). Five commits:
`ad884d1` (the four findings), `f30581c` (three more escapes + evidence gaps),
`f827d28` (four matcher gaps the second lens round found), `ba5a0b0` (every
matcher branch pinned; `?.length`; the reversed parenthesised gate), `c143fa8`
(a type-annotated declaration; `?.`/`?.[`/`#` chain receivers).

Files in the delta:

- `apps/web/src/tests/blankness-gates.ts` — the scanner (rewritten)
- `apps/web/src/lib/blankness-ratchet.test.ts` — the ratchet + scanner self-tests
- `.scratch/reviews/244/390da2d-mutation-proof.sh` — the mutation-proof tool (fixed)
- `.scratch/reviews/244/mutation-proof-guard-demo.sh` — proves that fix
- `.scratch/reviews/244/scope-shrink-proof.sh`, `gate-set-diff.sh`,
  `scanner-shapes.sh`, `branch-pin-proof.sh` — the round-2 proof tools
- `.scratch/implementation/244-round2-design.md` — the design + honest ceiling
- `.scratch/reviews/244/c143fa8-*.log` — evidence (`-ratchet-first-red`,
  `-ratchet-green`, `-mutation-proof`, `-guard-demo`, `-scope-shrink-proof`,
  `-guard-phase1`, `-branch-pin-proof`)

## What the PR does

The ratchet fails CI when a raw `.trim()` blankness gate on a numeric draft in
`apps/web/src` is not classified in `CLASSIFIED`. Scope (`numericReaderFiles`) =
every non-test `src/**/*.{ts,tsx}` importing `amount-parse`/`numeric-input`, plus
those two modules. Signatures are `file::<canonical gate text>`. Verdicts: `raw`
(must stay present) / `draftBlank` (converted; must be absent). Production set:
32 raw + 14 converted-absent = 46 classified keys.

## The four Greptile findings round 2 must close

1. **Line layout hid checks** — `draft.trim()` and `=== ""` split across two lines
   returned no gates; and after `const trimmed = draft.trim()`, the line
   `name.trim() === "" || trimmed === ""` reported only the inline check because
   `if (inline) continue` skipped the rest of the line.
2. **An inner variable hid an outer check** — the two-step lookup took the last
   earlier same-name declaration anywhere in the file, so a nested
   `trimmed = normalizeArabicIndicDigits(draft).trim()` masked an outer raw
   `trimmed === ""`.
3. **The mutation-proof script discarded local edits** — `git diff "$BASE" -- f`
   folded uncommitted edits into the reversed patch; `git checkout -- f` then
   restored the INDEX version. Never `git stash`.
4. **The two-step matchers had no self-tests** — the reversed example tested
   `INLINE_REV`, not the reversed alternative in `USE`; deleting that branch left
   the suite green.

The brief's rule for this round: every fix needs a **failing-first**
demonstration (escaping before, caught after). A branch with no test that fails
without it is edited, not fixed. The report must state which of the four the
matcher cannot handle, as a *stated ceiling*, not an omission.

## What changed after the FOUR earlier lens rounds

Seven lenses ran at each of `ad884d1`, `f30581c`, `f827d28` and `ba5a0b0`; their
findings were verified individually. Real but non-blocking ones are fixed in
`f30581c`, `f827d28`, `ba5a0b0` and `c143fa8` (twelve scanner escapes/over-reaches, a
scope-coverage assertion, evidence tooling, docstring honesty, and a
branch-pin proof that deletes each of the 10 matcher branches in turn and
requires the suite to redden). Two findings were false; several were dismissed as
*stated ceilings*, and the ceiling text grew each round until every shape that
`scanner-shapes.sh` returns `[]` for is named in it. `.scratch/implementation/244-round2-design.md`
§"Beyond the four findings" and §"Review round 2 — findings verified, then fixed
or dismissed" records that triage. The code is frozen except for a genuinely reproducible escape that is neither caught nor named in the ceiling. **Your job is the final state**: verify the
fixes hold, and hunt for what is still open. Do not re-report a dismissed finding
without a counterexample to the dismissal reason.

The brief is the specification: `D:/projects/mani-project/.scratch/sessions/crew/briefs/fix-244-round2.md`.
Designs: `.scratch/implementation/244-design.md` (round 1),
`.scratch/implementation/244-round2-design.md` (this round).
