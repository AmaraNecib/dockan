# Wisdom — 2026-10-16 · Affected-only CI: an under-selecting gate is the failure mode

Issue #226 narrowed the PR jobs by changed path: e2e runs mapped specs, the
Windows `rust` job runs only for crate-affecting diffs, and the push-to-develop
run stays full. The interesting failures are all "the gate ran too little",
never "the gate was slow".

## A path gate must cover every input the skipped job's build script fingerprints
`rust` was gated on `apps/desktop/**`. But `apps/desktop/src-tauri/build.rs`
compiles the api sidecar and declares
`cargo:rerun-if-changed=../../api/src`, `../../../packages/contracts/src`,
`../../../bun.lock`, `../../../tsconfig.base.json` and the root `package.json`.
An api-or-contracts-only PR therefore skipped the crate build at exactly the
moment `build.rs` would have re-run it, and a sidecar compile break would first
surface at tag time.

**Always**: before gating a job by path, read its build script / bundler config
/ task graph and gate on the *declared inputs*, not on the job's own directory.
A `rerun-if-changed` list is a ready-made gate list.

## A component imported by two pages cannot carry a one-page feature rule
The first map gave `components/catalog/**` the items specs. It is imported by
`items.tsx`, `sale.tsx` *and* `purchase.tsx`, so a change there under-selected:
only the items suite ran. `components/parties/**` had the same shape.

**Always**: for every feature-scoped component, grep its importers first. More
than one page means either a critical (full-suite) classification or a rule that
lists the union. `apps/web/src/components/app/**`, `ui/**` and `lib/**` are
critical for this reason; `catalog` and `parties` joined them.

## An unknown diff must fail *towards running*, at every layer
The shell computes a `*` sentinel when the base is unknown (new branch, zeroed
`before`, manual dispatch), and the selector turns an unmapped path into `full`.
Both directions are needed: the rust `grep -E` must treat `*` as rust=true, and
the `e2e`/`rust` `if:` must run when the `changes` job *fails* and leaves the
output empty. `needs: changes` alone skips the dependents on failure, which is
the wrong direction for a coverage gate.

**Always**: use `if: ${{ !cancelled() && needs.changes.outputs.rust != 'false' }}`
(empty means run), and test the `*` sentinel explicitly. And note that `grep -E`
in a YAML `run:` is untested logic: have the workflow test extract the real
pattern from the step and assert one positive and one negative path (JS `RegExp`
is only an approximation of ERE, so keep the pattern hand-escaped).

## Skip a suite by path and a required check can never be green
A trigger-level `paths:` filter or a job-level `if:` makes the job report
"skipped". If the owner later marks that check required, the PR waits forever on
a check that will not run. This repo has no required checks today, so the gate is
safe; the assumption is written next to it in `docs/ci.md` and the workflow guard
(`apps/desktop/scripts/ci-workflow.test.ts`) keeps the trigger unfiltered.

**Always**: pair a path gate with a sentence stating the branch-protection
assumption, and if the check must become required, add a small always-running
shim that reports the real result.

## Let the drift guard see uncommitted files
`scripts/e2e-selection.test.ts` fails when a spec on disk is unreachable from
every feature rule, when a rule names a spec that does not exist, or when a
pattern matches nothing. It lists files with
`git ls-files --cached --others --exclude-standard`: `--cached` is the committed
tree, `--others` makes a new pattern pass before it is committed, and
`--exclude-standard` keeps `node_modules`/`target`/`dist` from making a broad
glob look maintained. Plain `git ls-files` would fail the guard pre-commit.

**Always**: a checked-in map needs a drift guard that runs in the cheap job, and
the guard's file listing must match the phase it runs in (pre-commit vs CI).
