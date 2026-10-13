# Code-review evidence — #177/#180, Greptile round-3 delta (two axes)

- Base: `8259667` · prior reviewed head `43dc30d`
- Reviewed head: `90d3d73b6e9ae6867203ae06da148af47c4ea00f`
  (final code head `11498e4`)
- Tier: High-assurance
- Standards + Spec reviewers ran across the round-3 iterations.

## Standards axis

Sources: `AGENTS.md`, `CONTEXT.md`, `docs/engineering-workflow.md`,
`docs/development-workflow.md`, `docs/branch-workflow.md`, plus the Fowler smell
baseline.

- **No hard documented-standard violation.** Source-only diff; tests accompany every
  behaviour change.
- Judgement calls, all addressed or accepted:
  - the tie-break rule is duplicated server/client (`pickByName` vs
    `matchByNormalizedName`), but the server no longer trusts a client-resolved id
    (the `supplierId` branch re-scans siblings), so the divergence cannot cause a
    wrong post;
  - the inline `NamedCandidate` type was moved to module level;
  - `pickByName` was simplified to take the candidate array;
  - the unconditional `listParties` load is accepted (the sibling check needs the map)
    and noted as a possible names-only follow-up.

## Spec axis

Brief (`feat-177-180-greptile-round3.md`): six findings, each with a fix and a
pre-fix-failing regression test.

| # | Brief requirement | Status |
|---|-------------------|--------|
| 1 | Forward `confirmExisting` on named rows | ✅ |
| 6 | Refresh suppliers after `OPENING_BALANCE_EXISTS` even on the confirmed path | ✅ |
| 2 | Check the signature across all matching suppliers before the entry-count tie-break | ✅ named **and** client-resolved `supplierId` paths |
| 3 | Only move into an `untouched` target row | ✅ exact line per the brief |
| 4 | Use the resolved row count for the batch cap in `submit` and `save` | ✅ |
| 5 | Correct the stale refusal-order comment | ✅ |

Behaviour beyond the brief: the `supplierId` sibling scan (required to close the
critic's bypass of finding 2), and the mixed-batch/refresh tests.

## Summary

- Standards: 0 hard violations; judgement calls addressed or accepted.
- Spec: all six findings implemented and pinned; no blocker open.
