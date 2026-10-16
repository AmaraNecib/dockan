# #226 — Test audit evidence

- Audited head: `1a9d2f4029df4c68bd38c44ee72a9d64511e0d0e`
- Feature base: `a52084d1de0bda7fd3cb25ec5da5c778f04200ae`
- Tier: Standard
- Suites: `scripts/e2e-selection.test.ts` (27 tests) and
  `apps/desktop/scripts/ci-workflow.test.ts` (20 tests). Both run inside
  `bun run test` (`turbo test` then `bun test ./scripts/`).
- Lenses run as separate sub-agents at r1 (`7716f74`), r2 (`38b76a2`) and an
  r3 verification at `1a9d2f4`: edge-case hunter, coverage analyst, quality
  reviewer.

## Focus of the audit

The change adds a checked-in path -> spec map and a drift guard, plus a
workflow-path gate for the rust job. The risk that matters is an
**under-selecting** map or gate, so the audit targeted fail-closed behaviour,
precedence, and whether each test can fail for the right reason.

## Edge case hunter

Closed across rounds: the `*` unknown-diff sentinel must gate rust ON; the
`apps/desktop/docs/**` negative case; a feature rule with empty `specs` must not
fail open (now rejected in `loadMap`, not only asserted in the test); a
malformed map throws; blank/whitespace diffs; literal-dot and `?` glob edges;
`critical > feature` exercised on a synthetic overlapping map; duplicate spec
dedup; the CLI's `full`/`skip` empty-specs shapes.

Accepted residuals:

- The shell `Decide the scope` branch order is asserted by substring, not
  executed. Running it would need the `${{ }}` context substituted; the
  selector's decision function is covered directly, and the shell is the thin
  glue that feeds it. A `grep -qE '...' changed.txt` anchor and the
  `!cancelled()` fail-closed conditions are pinned. Documented as a limitation.
- `features: []` is vacuously accepted (everything unmapped -> `full`); a
  non-object feature entry throws a `TypeError` rather than the `loadMap`
  message. Both still fail closed.

## Coverage analyst

Every brief acceptance criterion maps to a test or a command:

- fail-closed: unmapped path, empty diff, blank diff, critical path,
  `tests/e2e/**` edit, `critical > feature`, `critical > skip`, feature > skip.
- classifications: docs-only, one feature, two features (union + dedup),
  a feature-scoped component, a cross-page component -> full, `.github`-only,
  `apps/desktop`-only, an unlisted unit test -> skip.
- drift guard: every spec reachable, every named spec exists, every pattern
  matches a tracked-or-new file, malformed map throws.
- rust gate: stays `windows-latest`; the `if:` rejects `push`-keyed and empty
  conditions; the detector is extracted from the workflow and asserts every
  `build.rs` `rerun-if-changed` input plus the `*` sentinel.
- wiring: `bun run test` still runs `bun test ./scripts/`; the YAML parses via
  `Bun.YAML.parse`; the shell keeps the zero-SHA sentinel, `merge-base`, the
  `e2e:full` label, `merge to develop`, no `inputs:`, and `!cancelled()` on the
  e2e job.
- 28 specs on disk, 28 named, 0 orphans, 0 missing (also confirmed by the Spec
  reviewer).

## Quality reviewer

Grades after the r2 additions: `scripts/e2e-selection.test.ts` **A**,
`apps/desktop/scripts/ci-workflow.test.ts` **A** (r1 was A-/B+). Isolation is
sound: CLI tests use `mkdtempSync`/`rmSync` in a `finally`, the module-level
`git ls-files` is read-only, and both files run in well under a second.
Assertions are meaningful (exact `specs` equality, `reason` checks, mutation
fixtures for `pipesSuiteToTee`), and the dedup/reason cases fail for the right
reason.

Residual note (accepted): four `mode === "full"` assertions still assert mode
only. The drift guard owns the map, so a disarmed map fails the drift tests
first; the affected paths are critical by construction. No fix applied.

## Verdict

Tests are adequate for the change and fail closed. No blocker. The accepted
residuals are weak-assertion/brittleness nits, not coverage holes.
