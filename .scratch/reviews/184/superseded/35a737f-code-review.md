# Code-review evidence — #184 review-fix round 2 (PR #190, two axes) + rebase

- PR base: `origin/develop` @ `f757211`; delta base `aa9f324`; code head `35a737f`.
- Tier: **High-assurance**. Roles: Standards (`reviewer`) + Spec (`reviewer`).

## Rebase

Rebased onto the current `origin/develop` (`bcc586a` → `d90e000` → `f757211`). One
additive conflict in `apps/api/src/rpc/router.ts`, resolved by keeping the union:
#143's `postStockBatch` (`:216`) + `postStock` (`:231`) and the #184 extraction
(`import { resolveOpeningDestination, type NamedSupplierCandidate }` at `:18`;
`resolveOpeningDestination` called at `:1044` and `:1121`; no local
`NamedSupplierCandidate` type declaration; `pickByName`/`signatureHolder` gone).
Verified by reading the file and by the full suites.

## Standards axis

Sources: `AGENTS.md`, `docs/engineering-workflow.md`,
`docs/development-workflow.md`, `docs/adr/`, the Fowler smell baseline, and the
`tanstack-query-best-practices`, `tanstack-router-best-practices`,
`vercel-react-best-practices`, `web-design-guidelines` skills.

- **Hard violations: none.** No type assertions, raw colours, skipped tests, or
  tooling drift. Evidence filenames carry their reviewed SHA.
- Smells fixed: `abandonAttempt()` replaces three copies of
  `invalidateAttempt() + closeConfirm()`; the E2E no-write assertion is one
  helper; `routerMock` spreads the real module (mirrors `dashboard.test.tsx`).
- Skill-guided: `resolveKeyRef` latest-ref via `useLayoutEffect` (Vercel
  `advanced-use-latest`); Escape closes the dialog (Web Interface Guidelines
  keyboard handlers); `fetchQuery` kept over `ensureQueryData` (TanStack
  `pf-ensure-query-data`).
- Deliberate deviations (documented): `query-cancellation` not applied; E2E
  setup duplication deferred.
- Rebase conflict resolution matches the additive-union rule and touches only
  `router.ts`; no money-path behaviour was altered (the resolver file is
  byte-identical to the pre-rebase branch).

## Spec axis

| Brief requirement | Status |
|---|---|
| Invalidate the attempt when the dialog is canceled | ✅ `abandonAttempt` on the dialog Cancel (`:599`) |
| A test that fails without the fix | ✅ web + e2e dialog-cancel tests (verified by revert) |
| No-write assertions over a bounded window, all three tests | ✅ `expectNoWriteDuring`, four leave tests + dialog |
| Verify the two re-reported round-0 findings, don't re-implement | ✅ finding 3: `leave()` (`:206`), back link (`:374`), layout-effect unmount guard (`:149`), dialog Cancel (`:193`); finding 4: `typedDestination` (`:111`), `confirmStale` (`:115`), effect (`:137-140`). Tests named. The only residual was the dialog Cancel (finding 1). |
| Rebase onto current `origin/develop`; keep #143 + the extraction | ✅ one additive conflict resolved; #143 and #174 suites green |
| Re-run debate + test-audit + code-review at the new SHA | ✅ this evidence |
| Guard 1+2 on isolated ports | ✅ typecheck/lint/`bun run test` (1936 pass); Playwright at `DOKAN_PORT=4829 DOKAN_WEB_PORT=5284` (64 pass) |

## Summary

- Standards: 0 hard violations; smells fixed or documented.
- Spec: all round-2 requirements met and tested; the rebase preserved both
  features and the money-path resolution is unchanged.

## Evidence

- Reviewer transcripts were produced by the code-review sub-agents; the
  synthesized findings and resolutions are above. Fix commits: `7815dd7`,
  `da2e394`, `1997cee`, `c1dd110`; rebased head `35a737f` (base `f757211`).
