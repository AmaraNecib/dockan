# Design: #231 — close the 6 Greptile findings on the CI selection PR (#226)

**Tier:** Standard — CI workflow, selection logic, map and guard tests; no money,
auth, backup or schema path. Standard gates (guard 1 → quality check → test-audit
→ code-review → guard 2) apply; debate is not required.

**Base:** `origin/develop` @ `1ea76b5` (the PR branch was cut from the older
`a52084d`; this round rebases the existing #226 work onto current develop).

**Authority:** lane commits, does NOT push and does NOT merge.

## Problem

PR #231 (`ci-e2e-selection`, closes #226) was reviewed by Greptile at 2/5 with
six findings, all failure modes of the changed-path gates:

1. Affected checks are missing — the map under-selects for `invoice.tsx`
   (omits `returns.spec.ts`), `purchase.tsx` (omits the short-window cases in
   `learnability.spec.ts`) and `vault-gate.tsx` (shared startup, mapped only to
   `vault.spec.ts`).
2. Moved files skip Rust checks — `git diff --name-only` reports only the
   destination of a rename, so a file moved out of `src-tauri/**` writes
   `rust=false`.
3. `e2e:full` starts no run — the `pull_request` trigger does not subscribe to
   `labeled`, so adding the label to an open PR triggers nothing.
4. Skipped checks have no explanation — the scope summary is written inside the
   `e2e` job, which is exactly the job a `skip` decision skips.
5. Required-check guidance is wrong — a job skipped by a job-level `if:` reports
   a `skipped` check, which GitHub treats as a successful required status. The
   "reporting shim" requirement is false.
6. The wiring guard can disable itself — the "`bun run test` runs the scripts
   suite" assertion lives in the scripts suite it protects.

## Interfaces

No production API change. The changed seams are:

- `scripts/e2e-selection.ts` — unchanged (`selectSpecs` stays pure).
- `tests/e2e-selection.map.json` — widened: `returns.spec.ts` joins the invoice
  rule, `learnability.spec.ts` joins the purchase rule,
  `apps/web/src/components/vault/vault-gate.tsx` becomes `always_full`, and the
  two #209 specs (`phone-identity.spec.ts`, `rpc-helpers.spec.ts`) join the
  parties rule.
- `.github/workflows/ci.yml` — `pull_request.types` gains `labeled`; the diff
  gains `--no-renames`; the scope summary moves into the `changes` job.
- `apps/desktop/scripts/ci-workflow.test.ts` — the workflow guard grows the
  label-trigger, rename and summary assertions, plus the relocated wiring guard.
- `docs/ci.md` (+ the #226 wisdom file) — corrected required-check guidance and
  the new map rows.

## Dependencies

None new. The rename fix uses `git diff --no-renames`; the label fix uses the
already-supported `pull_request` `types:` list. No model judgement is added.

## Planned tests

- `scripts/e2e-selection.test.ts`: regression cases for each widened row
  (`invoice.tsx` → includes `returns.spec.ts`; `purchase.tsx` → includes
  `learnability.spec.ts`; `vault-gate.tsx` → `full`/critical path). The drift
  guard already fails until the two #209 specs are reachable.
- `apps/desktop/scripts/ci-workflow.test.ts`: `--no-renames` is present and a
  real git repo proves a rename in either direction is listed (plain
  `--name-only` would hide the gate side); the trigger lists `labeled` while
  keeping the other PR events; executing the decision step with a `labeled` PR
  event reaches `full`; the relocated root-`test`-script wiring guard.
- Manual: the selector CLI across every case in the #226 evidence, plus a rename
  into the rust gate.

## Risks

- **Broadening the map is a coverage decision, not a cost one.** Widening rows
  can only run more specs; the drift guard catches the opposite direction. The
  one new `always_full` row (`vault-gate.tsx`) is a cost decision — it is shared
  startup chrome — and is recorded in `docs/ci.md`.
- **`labeled` re-runs CI on every label change.** Accepted: GitHub offers no
  label filter on the trigger, and correctness of the escape hatch beats the
  extra run. The decision step still narrows non-`e2e:full` label events.
- **`--no-renames` lists a rename as delete+add.** That only ever over-runs the
  gates; it cannot under-run them.
