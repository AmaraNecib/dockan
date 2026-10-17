# #244 round 5 — the round-4 JSX regression, and a probe that destroys edits

- Tier: **High-assurance** (recorded, unchanged). Justification: the scanner IS
  the ratchet that guards the money/stock readers — a gate it misses can record a
  numeric value the owner never saw (failure modes 1-3). This diff changes the
  guard itself, so it can violate the same failure modes the guard exists to
  prevent.
- Base: `origin/fix-244-blankness-ratchet` = `ad8445f` (PR #246 head). Merge-base
  with `origin/develop`: `746ff933753a0b409e96365080c91e3ef6efb5b6`.
- Spec: the Greptile comment on PR #246, **findings 1 and 2 only** (3-13 are the
  earlier rounds re-listed and already fixed; not reworked).
- Scope is deliberately tiny: **#249 replaces this whole scanner with a
  TypeScript AST walk.** Every extra line here is a line #249 must delete.

## Finding 1 — JSX child text inside a template expression was read as code

Round 4 gave `breaksStatement` the nested `code`/`quote`/`template` frame stack so
a `;` in nested template TEXT is not a statement break. The frame stack treats
`${...}` as code, so the `)` in a JSX child (`` `${flag ? <span>)</span> : draft}` ``)
hit the "close at bracket depth 0 ends the right-hand side" branch, the
declaration was discarded, and a raw gate escaped unclassified. Verified against
the real scanner before touching anything: round 3 (`1af565f`) caught it, round 4
(`ef32177`) returned `[]` (`.scratch/reviews/244/0371a74-round5-before.log`). The
Greptile example is not garbled; it reproduces as written.

Fix: an unmatched `)`/`]` at bracket depth 0 **inside a template interpolation**
cannot be code, so `breaksStatement` skips it as text (`else if (frames.length ===
1) return true;`). At the top level (and outside a template) a close still ends the
right-hand side, so every round-2..4 matcher is unchanged — `gate-set-diff`
ADDED `[]` / REMOVED `[]`.

Boundary, stated in the KNOWN CEILING rather than implied: JSX inside `${...}` is
handled only for the unmatched-closer half. A `}` or a quote in JSX child text is
still read as code, because telling a JSX `}` from the interpolation's own `}`
needs the tag walk an AST gives for free. Fixtures pin the three recorded results
(`)` fixed, `]` fixed, `}` already caught) and nothing more.

## Finding 2 — the probe instructions destroyed uncommitted edits

`round4-before-probe.ts` carried repro steps that overwrote
`apps/web/src/tests/blankness-gates.ts` and restored it with `git checkout --`.
Anyone following them with uncommitted scanner edits lost them — the third variant
of one lesson in this PR's history (round 3's mutation proof did it; a lane did it
to itself in round 4 with a dropped restore).

Fix, structural and not "careful": the probe now extracts the pre-fix scanners
(`1af565f`, `ef32177`) with `git show … :target` into a **private temp directory**,
imports them from there, and never opens the target for writing. It hashes the
real file before and after and exits 1 on any change.
`probe-safety-demo.sh` is the failing-first demonstration in a throwaway repo: the
old sequence destroys a marker edit, the new probe leaves a marker edit on a
**copy** byte-identical (via `ROUND4_PROBE_TARGET`) and asserts the real scanner's
sha256 is unchanged, so the demo cannot write the worktree at all.

## Files touched (and why nothing else could wait)

| file | why |
| --- | --- |
| `apps/web/src/tests/blankness-gates.ts` | the guard + the honest-boundary docstring |
| `apps/web/src/lib/blankness-ratchet.test.ts` | the required fixture (failing-first) |
| `.scratch/reviews/244/round4-before-probe.ts` | finding 2's fix |
| `.scratch/reviews/244/probe-safety-demo.sh` | finding 2's evidence |

No other source file. The test edit is required by the brief ("add the reported
case as a fixture"); the scratch files are the finding-2 deliverable and its
evidence.

## Evidence plan

| proof | command | log |
| --- | --- | --- |
| failing-first / regression table | `bun run .scratch/reviews/244/round4-before-probe.ts` | `0371a74-round5-before.log` |
| probe destroys / preserves | `bash .scratch/reviews/244/probe-safety-demo.sh` | `0371a74-probe-safety-demo.log` |
| gate set unchanged | `bash .scratch/reviews/244/gate-set-diff.sh` | `0371a74-gate-set-diff.log` |
| ratchet green | `cd apps/web && bun test src/lib/blankness-ratchet.test.ts` | `0371a74-ratchet-green.log` |
| guard Phase 1 | `bun run typecheck`, `bun run lint` | `0371a74-guard-phase1.log` |

The full `bun run test` suite is unavailable in this lane: the harness heavy-run
hook resolves `e2e-slot.sh` in a foreign project path
(`D:/projects/tuari_react_hono/.scratch/scripts/e2e-slot.sh`) and blocks the run
even with a slot held. The narrowed run is the affected suite — only
`blankness-ratchet.test.ts` imports the scanner.

## Risks

- The guard could be read as "JSX support". It is not; the ceiling says exactly
  what is handled and why the rest waits for #249.
- A `}` in JSX child text still closes the interpolation early in `scanSource`.
  The recorded fixture shows the gate is still caught either way; the pathological
  hiding shape is not claimed and not fixed here.
