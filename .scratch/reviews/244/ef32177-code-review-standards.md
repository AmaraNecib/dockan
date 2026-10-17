# #244 round 4 — Standards-axis review (head `ef32177`, base `1af565f`)

Axis: repo standards + Fowler baseline. Scope: `apps/web/**` (`.scratch/**` non-reviewable for tier).
No file other than this report was written; full suite not run.

## (a) Documented repo-standard violations

No apps/web violation of AGENTS.md or `docs/engineering-workflow.md` found. Checked and clean:

- Tier recorded with justification: `244-round4-design.md:4-10` names **High-assurance** and the
  failure modes (workflow: "records its chosen tier and a one-line justification in its design doc"). OK.
- Commit-only authority honoured: diff touches no `.agents/wisdom/**`, no `.github/**`, no push/PR.
- Source-only policy: `git status --short` lists only untracked `.scratch` logs; no build artifacts staged.

**Note (`.scratch`, non-tier): evidence naming.** Workflow: *"Evidence filenames must contain the
exact reviewed HEAD SHA."* The two newly committed scripts `concurrent-probe-demo.sh` and
`scope-shrink-guard-demo.sh` carry no SHA (`ef32177-*.log` outputs do). Harmless for shared scripts,
but it is the one literal rule the new files do not satisfy.

## (b) Fowler baseline smells

**1. Duplicated Code — three hand-rolled lexers, one knowingly lagging. Blocker-adjacent.**
`apps/web/src/tests/blankness-gates.ts`:

- `scanSource` region stack — lines ~300+ (`code`/`template`/`line`/`block`/`quote`);
- `breaksStatement` frame stack — lines 153-206 (`BreakFrame`: `code`/`quote`/`template`);
- `normalisesWholeValue` flat walk — lines 232-254 (`let quote: "'" | '"' | "`" | null`).

The docstring admits it in its own words (`blankness-gates.ts:83-85`): *"`normalisesWholeValue`
tracks quotes flat (the bug round 4 fixed in `breaksStatement`)"*. So the diff fixes a nested-template
bug in one copy and leaves a second copy with the same bug, then documents the leak instead of
extracting the shared walk. This is also **Divergent Change**: any future lexing correction must be
made in three places, and round 4 is already evidence that one gets missed.

**2. Mysterious Name — `normalisesWholeValue(receiver)` (`:232`) against its call site.**
The parameter is named `receiver` but the only caller passes `withoutSubscripts(declaration.rhs)`
(`:561`) — a right-hand-side expression, not a receiver. `withoutSubscripts(receiver)` (`:265`) repeats
the mismatch. Name it `value`/`rhs`.

**3. Mysterious predicate branch.** `isWordCharacter` (`:134`) is
`/[\w$]/.test(char) || char.charCodeAt(0) > 127`; the docstring above it explains `#` but never
explains the `>127` clause (Arabic-letter boundaries). An unexplained branch in a scanner is a future
regression site.

**4. Comments over structure (mild).** The added KNOWN CEILING prose (`:83-97`) is ~15 lines of
new mechanism described in a doc comment; it is accurate, but it is the fourth round of prose patching
a lexer — the design doc itself concludes *"the approach is the problem"* (`244-round4-design.md`).
Accept and merge-worthy, but the comment is the smell's symptom.

## Stale-reference check (prior critical finding)

`grep -rn NORMALISED_VALUE` over the repo: gone from `blankness-gates.ts`. Remaining hits are
`.scratch/implementation/244-design.md:201` (unchanged, non-reviewable) and
**`apps/web/src/lib/blankness-ratchet.test.ts:552`** — *"BEFORE the fix this returned []: `NORMALISED_VALUE`'s
`.*` consumed the trailing `.concat(draft)`"*. This is in a **changed file** and names an identifier
that no longer exists. It is prefixed "BEFORE the fix", so it reads as history, not a live claim —
hence a Note, not a Blocker. If the standard is "no comment may cite a deleted identifier", this is
the last one; a one-word cue (`the deleted `NORMALISED_VALUE``) clears it.

## KNOWN CEILING honesty — verified, honest

- *"`normalisesWholeValue` tracks quotes flat"* — true: single `quote` variable (`:236`), inner backtick
  closes the outer template, so `normalizeArabicIndicDigits(`${a ? `)` : b}`).trim()` returns `false`
  and is over-reported. Direction is safe (raw gate not hidden). ✓
- *"`withoutSubscripts` strips a `[`/`]` inside a string argument"* — true: the loop (`:266-275`) is
  quote-blind. ✓
- *"Regex literals are not parsed … in `breaksStatement` and `normalisesWholeValue` as well as
  `scanSource`"* — true: neither new function handles `/`; only `'`, `"`, `` ` ``. ✓
- No unstated new ceiling found in the `fusesTokens` rule: `out`-relative left char makes
  `const/*c*//*c*/trimmed` fuse correctly, and `\n` preservation covers line comments.

## Verdict

No Blocker. Correctness of the three fixes is out of this axis (Spec axis holds it). Ship-worthy
with two cheap edits: name `normalisesWholeValue`'s parameter for what it holds, and either extract
one shared region-walker or annotate `normalisesWholeValue` as a knowingly-divergent copy with a
follow-up pointer. Next: `edit apps/web/src/tests/blankness-gates.ts` (rename param) or reply "leave it".
