# #183 code-review evidence (review-fix round 2, test file)

- Issue: #183, names-only supplier lookup for the opening-balance conflict check
- Reviewed head: `cbd2337c71efdb9bb999941f922e7e39b22299c7`
- Diff: `git diff 80fdd94...cbd2337` (test-only, `apps/web/src/pages/supplier-opening-balance.test.tsx`)
- Axes: Standards and Spec, run as two parallel read-only sub-agents

## Standards

Standards sources: `AGENTS.md` (repo root, search-scope rule only), `.agents/skills/tdd/SKILL.md`, and the Fowler smell baseline from `.agents/skills/code-review/SKILL.md`. There is no `CODING_STANDARDS.md` or `CONTRIBUTING.md`.

No documented-standard violation. All findings are baseline smells, judgement calls, and none block.

- Duplicated Code, `requestSubmit()` block repeated 6 times. The file already has `clickOn` and `typeIntoRow` helpers that hide exactly this `host.querySelector(...)` walk. A `submitForm()` helper would centralise the "bypass disabled" intent. The sub-agent called this a judgement call, not new drift. Deferred.
- Primitive Obsession, `invalidateQueries({ queryKey: ["suppliersAccountSummaries"] })` and `["suppliersListNames"]` use raw literals that duplicate the mock's own `queryKey` and the page's. The file already exports `DEBTS_BY_PARTY_QUERY_KEY` for this reason. Deferred.
- Repeated prose: the "empty-batch check cannot mask" rationale appears in four tests and two comments. Intent is useful, wording is a little repeated. Accepted.
- No Mysterious Name, Speculative Generality, Shotgun Surgery, Divergent Change, Feature Envy, Data Clumps, Repeated Switches, Middle Man, or Refused Bequest found. New setup stays within the existing `accountsShouldFail` / `namesShouldFail` / `rejectUnconfirmed` flags.

Worst Standards item: the duplicated `requestSubmit()` block, a style nit.

## Spec

Spec sources: issue #183 and the round-2 review-fix directive (fill a valid typed-name row before `requestSubmit()` in both read-failure tests; sweep every "nothing was sent" assertion for the same vacuity).

Correct:

- Both read-failure tests now fill a valid typed row on `s-2` (`accountEntryCount: 0`, so `typedNameConflict` and `needsConfirmation` are false and `totalRows === 1`), then fail the read and `requestSubmit()`. Deleting either `listFailed` check makes `captured` non-null, so the assertion bites. The fill-before-fail ordering is required because the error state removes the table.
- The sweep converted four more `blockedReason`-driven tests to `requestSubmit()` (invalid amount, decimal, incomplete inline supplier, fold conflict) and retargeted the confirmation-masked tests to no-entry `s-2` rows. All now fail when their guard is removed.
- The round-5 fold retarget to `s-2` stays consistent with the #183 acceptance that two outgoing rows folding to one name are blocked.

Partial:

- The sweep leaves three `clickOn(<disabled button>)` sites: over-200, double-post, and confirm-save. The first two are now fixed; both the spec sub-agent and the quality reviewer accept the confirm-save case as defensible, since `save(true)` cannot be reached while the control is disabled and the `disabled` assertion carries the user-visible guard. Recorded in `cbd2337-test-audit.md`.

Scope creep: none. The extra edits are the requested sweep.

Worst Spec item: the acknowledged confirm-save exception, unreachable through the UI rather than unfixed.

## Summary

Standards: 1 style nit (deferred), 0 hard violations. Spec: 1 partial (confirm-save, documented), 0 blockers. No cross-axis winner.
