# #244 round 3 — debate (critic + defender)

Reviewed code: **`9219369`** — the round-3 head when the two lenses ran. The
fixes that came out of the whole lens round are committed in **`b0f2c64`**; every
finding below is dispositioned and each fix carries a failing-first fixture.
Neither reviewer had a shell: every claim is a `path:line` citation or a labelled
hand-trace of the code on disk (`2026-10-14-readonly-reviewer-can-fabricate-shell-output.md`).

## Critic — findings

Score 1-10, 10 = must-fix blocker. No blocker; two majors.

| # | Sev | Location | Finding |
|---|-----|----------|---------|
| 1 | major (6) | `apps/web/src/tests/blankness-gates.ts:284` | `scanSource` popped the `${}` code region on **any** `}`, not the interpolation's own. An inner `{...}` (object literal, arrow body) ended the region early, so the rest of the template was read as TEXT again — comments survived and `breaksStatement` scoping was lost. The PR's own finding-1 shape recurs behind a nested brace. |
| 2 | major (5) | `blankness-gates.ts:148` | `NORMALISED` fired on a normaliser call anywhere in the subscript-stripped receiver, so `f(normalizeArabicIndicDigits(id)).trim()` was skipped although the trimmed value is whatever `f` returns. The docstring claimed "only when the trimmed VALUE comes from the normaliser" — overclaimed. |
| 3 | minor (4) | `.scratch/reviews/244/390da2d-mutation-proof.sh:92` | The detection grep named only `has every converted gate absent`; a revert whose only failing assertion is the sibling `classifies every DETECTED gate` would print a false PROBLEM and fail closed on a legitimate detection. |
| 4 | minor (4) | `branch-pin-proof.sh:76`, mutation-proof grep | `(fail)` matching is format dependent (a future ANSI/CI formatter could break the crash guard). |
| 5 | minor (4) | both harnesses | Whole-file reverts prove "the file's conversion is caught", not "each gate is caught" — chain-level, not unit-level (`2026-10-16-latent-shape-mutation-proof.md`). |
| 6 | nit (3) | `blankness-gates.ts:436` | `numericReaderFiles()` matches a literal `from "…/amount-parse"`; a barrel/re-export import is not scanned, so "a new reader is scanned" is not guaranteed. Pre-existing. |
| 7 | nit (3) | mutation-proof filename | The historical `390da2d-` name is documented in its header but invites confusion. |

## Defender — defences

Accepted, with confidence scores as given.

- **One `scanSource` pass (9/10)** — the two passes cannot drift, which is the
  class of bug finding 1 was; template TEXT stays verbatim, the safe direction.
- **`withoutSubscripts` (9/10)** — strips `[...]` before the normaliser test;
  pins both the true positive and the precision boundary.
- **Green-baseline requirement (9/10)** — closes the silent-pass hole finding 3
  names; `proof-baseline-guard-demo.sh` shows old-vs-new.
- **Reload-and-reopen e2e (8/10)** — tests the stored contract, not a local save.
  The defender marked the server round-trip unverified; the
  `b0f2c64-e2e-discrimination.log` (old spec passes on a 5→7 mutant, new spec
  fails `Expected "5" / Received "7"`) closes it.

## Disposition

| # | Decision | Artifact |
|---|----------|----------|
| 1 | **Fixed** | `scanSource` regions now carry the index of their own `${` and pop only when that brace closes. Fixture `keeps the code region open across an inner brace inside \`${}\`` — red on the 92f40d0 scanner (`b0f2c64-ratchet-first-red.log`, 5 failed / 24 passed). |
| 2 | **Fixed** | `NORMALISED_VALUE` is anchored to the call that wraps the value. Fixture asserts `parseIdentity(normalizeArabicIndicDigits(id)).trim()` is a gate while a normaliser over the value is still skipped. |
| 3 | **Fixed** | The mutation proof accepts either ratchet assertion; it still refuses a crash (no `(fail)` line at all). |
| 4 | **Dismissed** | Every run redirects to a file (`> "$OUT"`), so bun never colourises; the accepted format is the one recorded in the logs. Not a live risk. |
| 5 | **Documented** | Stated as a ceiling, not hidden: per-gate ablation is out of scope for a whole-file revert. |
| 6 | **Documented ceiling** | Unchanged from earlier rounds; named in the scanner's `numericReaderFiles` doc. |
| 7 | **Dismissed** | The header states the tool/log relationship explicitly. |

## Residual ceilings (stated, not silent)

Regex literals (a regex holding a quote or `/*` can mis-scope and HIDE later
gates — the unsafe direction, a deferred follow-up); template TEXT is still
scanned as code (a deliberate no-change from round 2, now a *deferred
improvement* rather than a ceiling, because blanking the TEXT is safe once `${}`
is code — the old justification was invalidated by this very fix and the comment
was corrected); `numericReaderFiles` import shape; whole-file mutation
granularity.

## Lessons applied

- `.agents/wisdom/2026-10-16-latent-shape-mutation-proof.md` — a proof that cannot
  fail is not a proof; drove findings 3 and 5.
- `.agents/wisdom/2026-10-14-readonly-reviewer-can-fabricate-shell-output.md` —
  no-shell boundary and `path:line` citations.
- `.agents/wisdom/2026-10-14-git-stash-pathspec-pops-unrelated-stash.md` —
  honoured by the harnesses (mktemp + byte backup + EXIT trap), not re-derived.
