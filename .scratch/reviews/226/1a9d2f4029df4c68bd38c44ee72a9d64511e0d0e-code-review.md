# #226 — Code review evidence (Standards + Spec axes)

- Reviewed head: `1a9d2f4029df4c68bd38c44ee72a9d64511e0d0e`
- Feature base: `a52084d1de0bda7fd3cb25ec5da5c778f04200ae` (`origin/develop` merge-base)
- Branch: `ci-e2e-selection`
- Tier: Standard (CI / workflow / test / docs)
- Spec: the #226 brief (`.scratch/.../briefs/ci-e2e-selection.md` plus the
  correction that `docs/ci.md` had to be extended, not created).
- Rounds run as separate sub-agents: r1 at `7716f74` (5 reviewers), r2 at
  `38b76a2` (5 reviewers), r3 verification at `1a9d2f4` (2 reviewers). The
  test-audit lenses live in the sibling `-test-audit.md`.

## Spec axis

Requirements confirmed present: fail-closed selector (`critical -> feature ->
skip -> full`; empty or blank diff, unmapped path, critical path and any
`tests/e2e/**` touch all force `full`); `push: develop` stays full;
`e2e:full` is the only overrule and it is a recorded PR label; rust stays on
`windows-latest` and is gated by path. The map covers all 28 specs on
`origin/develop` (orphan and missing-spec guards both green). `docs/ci.md` was
extended, not replaced.

Findings and disposition:

| Round | Finding | Disposition |
|---|---|---|
| r1 | rust gate missed the `build.rs` sidecar inputs (`apps/api`, `packages/contracts`, `bun.lock`, root `tsconfig`/`package.json`); an api/contracts/lock PR skipped the crate build build.rs itself re-runs | Fixed in `38b76a2`; regex + test pin every `rerun-if-changed` input |
| r1 | `components/catalog/**` and `components/parties/**` were one-page feature rules although `sale.tsx` and `purchase.tsx` also import them | Fixed: both critical (`full`); `invoice-header` rule unions `purchase-intake.spec.ts` |
| r1 | `workflow_dispatch` had a `skip`/`affected` input, an unrecorded scope override contradicting the one-overrule story | Fixed: no dispatch input; dispatch runs full |
| r1 | `docs/ci.md` "skipped only when nothing can reach a browser" contradicted the dispatch bullet | Fixed with the input removal |
| r1 | required evidence files absent | This file and the sibling |
| r2 | `docs/ci.md` said `apps/api/**` while the regex matched only the api sources and their package/tsconfig | Fixed in `1a9d2f4`; docs list is now a one-to-one match with the regex, plus `rust-toolchain.toml`/`.cargo/**` |
| r2 | the `mode === "full"` cases could pass on an unmapped path | Fixed: the critical component/lib cases assert `reason` contains "critical path" |
| r3 | four remaining `mode === "full"` assertions still assert mode only | Accepted: the drift guard owns the map, and the paths (`tests/e2e/**`, a synthetic `always_full`) are critical by construction; the outcome is still `full` either way, so this is a weak-assertion nit, not a fail-open |
| r3 | `features: []` passes vacuously; a non-object feature entry throws a `TypeError`, not the `loadMap` message | Accepted: both still fail closed (everything unmapped -> `full`) |

No missing requirement, no scope creep beyond the #154 workflow guard update
(which the brief's invariant 4 forces) and the re-homed `vite build` gate in
`checks`.

## Standards axis

Hard violations: none. `AGENTS.md`, `docs/engineering-workflow.md` and the
source-only change policy are respected.

Judgement calls, with disposition:

- **unslop: em dashes and "harness" jargon** (r1). Fixed in `38b76a2`; the
  r2 Standards pass reported no em dashes added and the map comment reworded.
- **Shotgun surgery: the rust path list lives in the workflow regex, the docs
  prose and the design note.** Mitigated: the workflow test extracts and tests
  the real regex instead of copying it, so the regex is the single source of
  truth and docs are the described contract.
- **Feature envy: the test extracts the grep pattern from the YAML run text.**
  Kept deliberately. `workflow-utils` owns the workflow parser, but the shell
  pattern has no other owner; extracting it makes a tightened regex fail the
  guard instead of silently dropping rust coverage. This is a documented
  trade-off, not an accident.
- **Duplicated `$comment` filtering** (in `commented()` and inline in the test).
  Accepted, minor; the test's filter is three lines.
- **Repeated `sed -n 's/^mode=//p'` lines** in the scope step. Accepted: shell
  glue whose output contract is pinned by the CLI test.
- **Primitive obsession: `mode` is a bare string across the TS/shell boundary.**
  Accepted: the CLI stdout contract (`mode=`/`specs=`/`reason=`) is tested at
  both the unit and subprocess level.
- **Speculative generality: `loadMap(path)`.** Resolved: the malformed-map test
  uses the parameter.

## Verdict

**Spec: pass. Standards: pass, with the documented judgement calls above.**
No blocker. The r3 verification reviewer confirmed every r1/r2 fix and reported
no new defect.
