# Code-review evidence — #184 review-fix round 1 (PR #190, two axes)

- Delta base: `9697611`; code head `179eaf1`; evidence head `e1c9fbf`
- Tier: **High-assurance**
- Roles: Standards (`reviewer`) + Spec (`oracle`); two passes (`0f0a6a9`, `a207283`).

## Standards axis

Sources: `AGENTS.md`, `CONTEXT.md`, `docs/engineering-workflow.md`,
`docs/adr/0009-supplier-account-ledger.md`, `docs/adr/0011-supplier-adjustment-dedup-key.md`,
plus the Fowler smell baseline.

- **Hard violations: none.** No type assertions, raw colours, skipped tests, or
  lockfile/tooling drift. Evidence filenames carry their reviewed SHA; `.scratch/**`
  placement matches the workflow.
- Smells fixed: the lookup-ready guard and the resolve tuple were duplicated three
  times → one `useMemo` returning `{ input, key }`; the attempt bump appeared in
  four shapes → one `invalidateAttempt()`; the `invalidateAttempt(); setX()` pair is
  open-coded in the handlers but kept explicit and readable (judgement call).
- Residual notes: `confirmStale`/`resolveKey` must stay in sync with any future
  lookup field; the `opening-balance-done` button navigates without an invalidate
  (no attempt can be in flight then). Both documented, not blocking.

## Spec axis

| Brief requirement | Status |
|---|---|
| Cancel a pending attempt when leaving (generation guard) | ✅ `attemptRef` + `leave()` + back-link `onClick` + unmount cleanup |
| Ignore lookup results that arrive after the page closes | ✅ post-await attempt check, `mountedRef` on late state |
| **Do not** block Cancel if the lookup can hang | ✅ Cancel disabled only on `submitting \|\| bulk.isPending` |
| Close+clear the confirmation + destination snapshot when the typed lookup fields change | ✅ `resolveKey`-tagged snapshot + effect close/clear + `confirmStale` |
| Test proving no write on Cancel | ✅ unit (`mutationCalls === 0`) + E2E (no POST) |
| Test proving the edited batch can save | ✅ unit + E2E (both accounts land) |
| Re-run debate + test-audit + code-review at the new SHA | ✅ this evidence |

Spec findings and resolutions:

1. **"Resolve the edited row again" is lazy** (next submit, not eager). **Accepted** —
   the edited batch saves; the destination is only needed at submit/confirm.
2. **Beyond-brief hardening** (`invalidateAttempt` on every field/row edit, the
   empty-batch guard, `confirmStale`, the refusal re-align by lookup key) is within
   the brief's critic mandate ("every path that writes after leave / every stale
   value after a field edit") and closes the reviewer-found EDGE-1/EDGE-2.
3. **Doc drift** in the design doc's "Added tests" count → corrected.

Two real code findings were fixed during this round: the refusal-recovery guard now
compares the lookup key rather than the attempt id (no infinite refusal loop after a
row edit during the write), and the back link invalidates synchronously.

## Summary

- Standards: 0 hard violations; smells fixed or documented.
- Spec: all brief requirements met and tested; no #183 creep; the two follow-up
  findings from the verification pass are fixed.

## Evidence

- Reviewer transcripts were produced by the code-review sub-agents for this round;
  the synthesized findings and resolutions are above. Fix commits: `0f0a6a9`,
  `a207283`, `179eaf1`.
