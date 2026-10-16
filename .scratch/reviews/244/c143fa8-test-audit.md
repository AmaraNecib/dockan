# #244 round 2 — test audit (edge cases, coverage, quality) at `c143fa8`

Three read-only test-audit children per round (five rounds), run by this lane.
Findings were verified against the code; the fixed ones are in the source
commits, the dismissed ones are recorded in the design doc. The edge-case lens
ran the scanner with `bun -e` and reported observed output only.

## Edge cases

Every shape that the lenses could produce and that returns `[]` is either an
intended negative (not a gate) or named in the ceiling. The observed table lives
in `c143fa8-scanner-shapes.log` (33 shapes); the summary:

| shape | observed | verdict |
| --- | --- | --- |
| comparison split across lines (both orders, `.length` too) | caught | fixed (finding 1) |
| inline gate + two-step gate on one line | both caught | fixed (finding 1) |
| declaration split across lines | caught | fixed (finding 1 class) |
| inner normalised declaration masks an outer raw check | caught | fixed (finding 2) |
| reversed two-step `.length === 0`, forward and optional-chained | caught | fixed |
| formatter-broken chain (`draft\n  .trim()`, `draft.trim()\n  .length`) | caught | fixed |
| bracketed right-hand side (`parse({ raw: draft }).trim()`, `` `${draft}`.trim() ``) | caught | fixed |
| reversed / generalised parenthesised nullish gate | caught | fixed |
| type-annotated declaration (`const t: string = draft.trim()`) | caught | fixed |
| `box?.value`, `drafts?.[id]`, `this.#draft` receivers | caught, whole receiver in the signature | fixed |
| loose equality, NBSP/ideographic space, JSX attribute, nested arrow/IIFE, `as` cast | caught | — |
| truthiness, relational `.length`, template blank operand | not caught | stated ceiling |
| `var`, deferred `let` assignment, alias, second declarator, destructuring | not caught | stated ceiling |
| `switch (t) { case "" }`, `draft.trim ().trim()`, doubly-nested `((a ?? b) ?? c)`, zero-width space | not caught | stated ceiling (design doc ceiling list) |
| call receiver inline (`f().trim() === ""`) | not caught; the two-step `const t = f().trim()` is | stated ceiling |
| property read `box.trimmed === ""` / `"" === trimmed.suffix` | not reported | intended negative (precision) |
| normalised declaration (`normalizeArabicIndicDigits(draft).trim()`) | not reported | intended negative |

Residual risks the lenses named: a regex literal can hide later gates (unsafe,
deferred); a `draftBlank` "must be absent" check is signature-based, so a
converted gate re-introduced in an *uncaught* form stays green — that is the
stated ceiling, not a new hole.

## Coverage — every fix has a fixture that failed before it

`c143fa8-ratchet-first-red.log`, 18 red fixtures in five sections, each section run
against the then-committed scanner:

| # | fix | discriminating fixture | red at |
| --- | --- | --- | --- |
| F1 | line layout (whole-source matching, span claim) | split comparison; inline+two-step line; split declaration | §1 (round-1 scanner `5fbe0f0`) |
| F2 | scope-restricted declaration lookup | inner normalised declaration masking an outer raw gate | §1 |
| F3 | mutation proof discarding edits | guard-demo CASE A (unfixed tool destroys the edit) | `-guard-demo.log` |
| F4 | two-step self-tests | forward + reversed two-step + normalised-declaration negative | §1 |
| E1 | reversed `.length` | `0 === draft.trim().length` | §2 (`ad884d1`) |
| E2 | normaliser-as-substring receiver | `draftBlankish.trim() === ""` | §2 |
| E3 | property-read precision (forward) | `box.trimmed === ""` must report nothing | §2 |
| E4 | formatter-broken chain | `draft\n  .trim()` and `draft.trim()\n  .length` | §3 (`f30581c`) |
| E5 | bracketed right-hand side | object argument and template argument | §3 |
| E6 | two-step `.length` | forward and reversed | §3 |
| E7 | property-read precision (reversed) | `"" === trimmed.suffix` | §3 |
| E8 | `?.length` | `trimmed?.length === 0`, `draft?.trim()?.length === 0` | §4 (`f827d28`) |
| E9 | reversed parenthesised gate | `"" !== (drafts[id] ?? "").trim()` and a non-literal fallback | §4 |
| E10 | typed declaration | `const trimmed: string = draft.trim()` | §5 (`ba5a0b0`) |
| E11 | `?.`/`?.[`/`#` receivers | `box?.value`, `drafts?.[id]`, `this.#draft` | §5 |
| E12 | (the `USE_LEN_REV` branch pin) | forward + reversed two-step `.length` fixture keeps the branch necessary | `-branch-pin-proof.log` |

Branch pins (`c143fa8-branch-pin-proof.log`): each of the 10 matcher branches is
deleted in turn and the suite must redden — INLINE_FWD 8 failures, PAREN_FWD 2,
PAREN_REV 2, INLINE_REV 2, INLINE_LEN 3, INLINE_LEN_REV 2, USE_FWD 6,
USE_LEN_FWD 2, USE_REV 2, USE_LEN_REV 2 — then the scanner is restored
byte-identical and the suite is green.

Other confirmations from the logs: mutation proof 11/11 files red with the
converted-gate-absent assertion (none vacuous); guard demo A/B/C; scope-shrink
red then byte-identical green; gate-set-diff 32 gates, `ADDED []` / `REMOVED []`
at five reference SHAs; ratchet green 24/24.

## Quality

- The three `CLASSIFIED` assertions discriminate: adding a raw gate reddens
  "unclassified"; converting one reddens "converted gate absent" (the mutation
  proof reddens it 11 times); removing a raw verdict reddens "raw verdict
  present".
- The synthetic fixtures pin exact canonical signatures; the four absence-only
  fixtures are precision tests (they can only catch an over-reach) and the
  production assertions carry the non-vacuity.
- No tautologies, no dead branches (branch-pin proof), no duplicate keys.
- Named limits kept honest: the test docstring says DETECTED and names the
  deliberate-prune limit; the "raw verdict present" test names its own invariant.
- Cosmetic notes not acted on: the `line` assertion on one fixture is an
  implementation detail (it pins the failure message's line, deliberately); three
  fixtures pin `draft.trim().length === 0`, which is harmless padding; the
  non-vacuous bounds (`sources > 10`, `gates > 20`) are loose but the scope
  assertion and the 32 raw entries carry the real weight.
