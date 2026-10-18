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

## A job-level skip is a green required check; only a trigger filter strands one
A job skipped by a job-level `if:` still reports a check run, with conclusion
`skipped`. GitHub counts `successful`, `skipped` and `neutral` as satisfying a
required status check (`github/docs`: *About protected branches* — "Required
status checks must have a `successful`, `skipped`, or `neutral` status";
*Troubleshooting required status checks* — "Successful check statuses are
`success`, `skipped`, and `neutral`"). So a path-gated job can be made required
without a reporting shim. A workflow excluded by a trigger-level `paths:` filter
is different: it creates no check run at all, so a required check stays pending
forever. The first draft of #226 claimed both needed a shim; Greptile caught it
and the claim was removed (#231).

**Always**: gate a job with an `if:` on a `changes` output, never a trigger
`paths:` filter, and say that the skipped job still reports a green check.

## Rename detection hides the side of a path gate that matters
`git diff --name-only` reports only the *destination* of a detected rename. A
file moved out of `apps/desktop/src-tauri/**` therefore listed its ungated
destination, the `rust` grep saw no crate path, and the job that must compile
the crate it just lost was skipped. `git diff --no-renames` lists the move as a
delete plus an add, so both sides appear and either direction opens the gate.
The guard test builds a throwaway repo, `git mv`s a crate file out and back, and
asserts the plain `--name-only` output omits the old path (#231).

**Always**: collect a gate's changed-file list with `--no-renames`, and test the
rename direction that removes a gated file, not only the one that adds it.

## A label is not a trigger until `pull_request.types` lists `labeled`
The `e2e:full` escape hatch read the PR label but the trigger only fired on the
three defaults (`opened`, `synchronize`, `reopened`), so adding the label to an
already-open PR started nothing. Specifying `types:` also *replaces* the
defaults, so all four must be listed (#231).

**Always**: when a workflow reads `github.event.pull_request.labels`, pin the
trigger `types:` to include `labeled` and assert the whole list in the guard.

## A skip explanation must live in the job that always runs
`if: e2e_mode != 'skip'` is exactly the condition that skips the e2e job, so a
scope summary written inside that job never publishes the reason nothing ran.
The summary belongs in `changes`, which always runs (use `if: always()` so it
still fires when the decision itself fails) (#231).

**Always**: write the run summary in the always-running decision job, never in
a consumer that the decision can skip.

## A self-guard cannot protect the wiring that runs it
The `bun run test` → `bun test ./scripts/` assertion lived inside the scripts
suite: removing the scripts command from `package.json` also stopped the
assertion from running, so the guard disabled itself. It now lives in
`apps/desktop/scripts/ci-workflow.test.ts`, reached through `turbo test` (#231).

**Always**: put a wiring assertion in a suite the wire does not run, and note
that nesting a guard inside its own trigger only proves the two are broken
together.

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

## A page that hosts a shared panel is not safe with a hand-written spec list
Three Greptile rounds in a row found the same class of miss: the map named the
specs a page's *own* rule reached and missed the specs mapped to other features
that drive a shared surface *through* that page. Round 1: `invoice.tsx` renders
`ReturnsPanel`, which `returns.spec.ts` drives, and `purchase.tsx` hosts the form
`learnability.spec.ts` pins. Round 2: `debts.tsx` hosts the supplier-credit totals
`supplier-adjustment.spec.ts` asserts, `activity.tsx` hosts the backup-filename
render `backups.spec.ts` pins, and `sale.tsx` hosts the item picker
`items-flow.spec.ts` and the party picker `customer-name-variants.spec.ts` drive.
Each round patched the named rows and the next round found more.

**Always**: do not widen one row at a time; promote the page. A page becomes
`always_full` when it is imported by another page, or renders a component tree
already marked critical (`components/catalog/**`, `components/parties/**`) that
another feature's spec drives. #231 promoted `stock`, `items`, `sale`, `purchase`,
`parties` and `party-detail`. Recorded cost: those pages always run the full
suite. Accepted, because the gate's invariant is that a miss costs minutes, never
coverage.

## Widen first, then promote — and keep the widened rule reachable
When a policy supersedes a hand fix, do both: widen the known rows for the
record, then promote. The trap is leaving the widened rule dead after a
promotion. The round-3 map keeps the rule for the page's unit-test sibling, and
the test asserts both the page (`full`) and the rule (the exact spec list). The
selector CLI output for each row was captured before (`b7c0bd9`) and after,
because "the auditor could see them fail" is what makes a regression case worth
having.

**Always**: when a policy supersedes a hand fix, keep the hand fix reachable and
mutation-visible, and capture the selector's before/after for the rows the brief
names. Do not use `toContain` on a list whose whole point is that it must not
silently change — pin the exact list.

## "Additional build", not "moved build": Cargo still needs `apps/web/dist`
`docs/ci.md` said the production `vite build` was "moved into `checks`". It was
not: `rust` runs the same build at its own step because `build.rs` hard-fails
without `apps/web/dist`, and Cargo needs it before it starts. The misleading
wording invites a cleanup that deletes a build the crate requires. A second copy
of the same claim lived in the `ci.yml` comment and a third in
`ci-workflow.test.ts`.

**Always**: when a job gains a build another job also needs, say "additional" and
name the consumer that still requires it; correct every copy (docs, source
comment, guard test), not only the doc.
