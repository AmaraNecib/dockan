# Debate evidence — #184 rebase round 2 (PR #190)

- PR base: `origin/develop` @ `21dbc13`; previous merge-base `f757211`;
  pre-rebase head `fbc30ee`; rebased final code `7bca6a6`; certified head
  `81a337d` (this evidence's header SHA).
- Tier: **High-assurance** (opening-balance money math). One critic + one
  defender focused on the rebase resolution: did the merge drop or weaken either
  side's tests? Round-4 debate findings carry forward for the unchanged code.

## Critic findings

| # | Score | Finding | Disposition |
|---|-------|---------|-------------|
| R1 | 5 | The conflict is in a money-path test file, so a lazy resolution could silently drop either develop's batching (reintroducing the #193 load blow-up) or this branch's new-tab coverage (reopening the round-4 bug). | **Verified both survive, not assumed**: the merged file carries develop's `fillAmounts`/`BATCH_LIMIT_TEST_TIMEOUT_MS` on both batch-limit tests *and* all seven round-4 new-tab cases; both sets ran green in the same unit run. The file diff against the pre-rebase branch file is exactly develop's additions. |
| R2 | 4 | Keeping two fill helpers (`fillAmounts` and a branch-local one) would drift and double the maintenance of the React-props reach. | **Fixed by construction**: only develop's `fillAmounts` remains; this branch had none of its own, and its two batch-limit tests now call develop's. |
| R3 | 3 | Dropping `modifiedClickOn` could leave a call site dangling (a rebase would then not typecheck). | **Verified**: `modifiedClickOn` has zero references; `76ac83e` had already replaced it with `clickOn`/`dispatchClickOn`, and `tsc --noEmit` is green. |
| R4 | 3 | `BATCH_LIMIT_TEST_TIMEOUT_MS = 60_000` is a timeout, so a future author could raise it instead of restoring the batched path. | **Accepted, mitigated**: the constant keeps develop's "fix the cost — do not raise it" docstring, and the fills run in ~1.2 s, over 40x under the budget. |
| R5 | 2 | A rebase can change test counts without anyone noticing a deletion. | **Verified**: web is 986 pass / 0 fail, the same count as the pre-rebase round-4 run; no test file lost. |

Critic also checked: the auto-merged `supplier-opening-balance.tsx` (the page)
is unchanged by the merge resolution; no develop commit touched it, so none of
the round-4 guard behaviour was affected.

## Defender (confidence)

- Keeping develop's helper and this branch's tests is the union the brief asks
  for, with no vote dropped — 9/10.
- One fill helper (develop's) is the right call; it is the load-proof one and
  this branch never had a competing helper — 9/10.
- The file-level `diff` against the pre-rebase branch is the honest proof of
  "nothing of ours was lost" — 8/10.
- Round-4 predicate/guard design still stands unchanged — 8/10.

Defender's honest caveat (agreed): the merge changes only test code, so passing
tests prove the *tests* survived; the product code was already reviewed and is
byte-unchanged, so this round does not re-litigate it.

## Synthesis

No in-scope defect. The single conflict was resolved as a union: develop's
load-proof `fillAmounts`/named budget kept, this branch's round-4 helpers and
seven new-tab cases kept, `modifiedClickOn` dropped as already superseded by the
branch's own `76ac83e`. Both proof sets pass. No deferred work, no follow-up.
