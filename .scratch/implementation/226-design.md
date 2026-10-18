# Design: #226 — affected-only e2e on PR, and gate rust on the diff

**Tier:** Standard (CI / workflow / test / docs).
**Base:** `origin/develop` @ `a52084d` (the lane branch is cut from it).
**Authority:** lane commits, does NOT push and does NOT merge.

## Problem

PR CI runs all three jobs on every PR. Measured 2026-10-01 → 2026-10-16 (billed
minutes = wall × runner multiplier): `rust test, clippy` 1,057.5 (46%, on
`windows-latest` at 2x), `playwright e2e` 931.8 (40%), `checks` 312.8 (14%).
This is a latency change, not a minute-budget change: the repo is public and
minutes are unbounded. The merge-to-`develop` run must stay whole — it is the
only run that sees the exact merged tree.

## Interface

`scripts/e2e-selection.ts`:

```ts
export type Scope =
  | { mode: "full";     specs: string[]; reason: string }
  | { mode: "affected"; specs: string[]; reason: string }
  | { mode: "skip";     specs: string[]; reason: string };

export function globToRegExp(pattern: string): RegExp;
export function loadMap(path?: string): Map;
export function selectSpecs(changed: string[], map?: Map): Scope;
```

`selectSpecs` is pure. Precedence, per file: **critical → feature → skip →
fail closed**; an empty list is `full`. The CLI
(`bun scripts/e2e-selection.ts changed.txt`) prints `mode=`/`specs=`/`reason=`
for the `changes` CI job.

`tests/e2e-selection.map.json` is the checked-in artifact:
`always_full[]` (critical), `skip_e2e[]` (inert), `features[]`
(`{ match[], specs[] }`).

## Workflow shape

- New `changes` job (ubuntu, ~10 s): fetch-depth 0, diff
  `merge-base(base, head)..head`, run the selector, and compute a `rust`
  output with one `grep -E`.
- `checks`: unchanged, plus a production `vite build`. The web build used to
  ride along in the `rust` job; gating rust off web-only diffs would otherwise
  drop the only PR-time production build (the e2e job runs `vite dev`, and
  `turbo test` only builds workspace dependencies).
- `e2e`: `needs: changes`, `if: e2e_mode != 'skip'`, expands `E2E_SPECS` into
  `bun run test:e2e $E2E_SPECS`.
- `rust`: `needs: changes`, `if: rust != 'false'`. Still `windows-latest`.
  `rust` is true for the crate, its scripts, and the sidecar inputs `build.rs`
  fingerprints (`apps/api/src/**`, `apps/api/{package,tsconfig}.json`,
  `packages/contracts/**`, `bun.lock`, `tsconfig.base.json`, the root
  `package.json`, `rust-toolchain.toml`, `.cargo/**`).
- Triggers: `pull_request`/`push`/`workflow_dispatch`, **no**
  trigger-level `paths`/`paths-ignore`. A trigger filter would delete `checks`
  on a docs-only PR and trap a required status check; the `changes` job decides
  scope per suite instead.

## Tests

- `scripts/e2e-selection.test.ts` (runs in `bun test ./scripts/`, which
  `bun run test` already ends with): drift guard — every spec on disk is
  reachable by a feature rule, every named spec exists, every pattern still
  matches a tracked/new file, plus classification cases.
- `apps/desktop/scripts/ci-workflow.test.ts` (#154) must be updated: it
  currently pins "no job-level `if:` on rust" and the exact e2e pipeline
  `bun run test:e2e 2>&1 | tee …`. The new design gates rust by path and adds
  `$E2E_SPECS`. The #197 evidence guarantees and the crate-dir/toolchain/OS
  assertions are preserved; a new assertion pins the rust detector to the
  crate paths.
- One real spec end to end: `bun run test:e2e tests/e2e/expense-reports.spec.ts`.

## Risks

- **Map staleness.** Fail-closed: a path that matches nothing forces `full`; a
  spec on disk that no rule names fails the drift guard. Residual: a *wrong*
  feature rule (a path that reaches more screens than it claims). Mitigation:
  shared chrome, primitives, hooks, lib and the whole API are critical, not
  feature rules.
- **`docs/ci.md` predates this change** and argues the rust job has no path
  filter. Extended, not replaced; the branch-protection caveat is restated.
- **Production web build** is re-homed into `checks`; that is the one gate the
  rust job used to provide for free.
