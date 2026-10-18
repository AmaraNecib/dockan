# Code-review evidence — #184 review-fix round 2 (PR #190, two axes)

- Delta base: `aa9f324`; code head `c1dd110`; tier: **High-assurance**.
- Roles: Standards (`reviewer`) + Spec (`reviewer`), first pass and verification.

## Standards axis

Sources: `AGENTS.md`, `docs/engineering-workflow.md`,
`docs/development-workflow.md`, `docs/adr/`, plus the Fowler smell baseline.
Also applied the installed `tanstack-query-best-practices`,
`tanstack-router-best-practices`, `vercel-react-best-practices`, and
`web-design-guidelines` skills.

- **Hard violations: none.** No type assertions, raw colours, skipped tests, or
  tooling drift. Evidence filenames carry their reviewed SHA.
- Smells fixed: `abandonAttempt()` replaces three copies of
  `invalidateAttempt() + closeConfirm()`; the E2E no-write assertion is one
  helper; `routerMock` spreads the real module (mirrors `dashboard.test.tsx`).
- Skill-guided changes: `resolveKeyRef` latest-ref via `useLayoutEffect`
  (Vercel `advanced-use-latest`); Escape closes the dialog (Web Interface
  Guidelines keyboard handlers); `fetchQuery` kept over `ensureQueryData`
  (TanStack `pf-ensure-query-data`, because the resolve must be live, not cached).
- Deliberate deviations (documented): `query-cancellation` is not applied (the
  generation guard already prevents any effect, an aborted oRPC call logs
  `AbortError` through the rpc interceptor, and aborting the held request would
  break the leave E2E tests); E2E setup duplication is a documented deferral.

## Spec axis

| Brief requirement | Status |
|---|---|
| Invalidate the attempt when the dialog is canceled | ✅ `abandonAttempt` on the dialog Cancel (`:599`) |
| A test that fails without the fix | ✅ web + e2e dialog-cancel tests (verified by revert) |
| No-write assertions over a bounded window, all three tests | ✅ `expectNoWriteDuring`, four leave tests + dialog |
| Verify the two re-reported round-0 findings, don't re-implement | ✅ finding 3 fixed by `leave()` (`:206`), back link (`:374`), unmount guard (`:149`), dialog Cancel (`:193`); finding 4 fixed by keyed `typedDestination` (`:111`), `confirmStale` (`:115`), effect (`:137-140`). Tests named in the design doc. The only residual was the dialog Cancel (finding 1). |
| Re-run debate + test-audit + code-review at the new SHA | ✅ this evidence |
| Guard 1+2 on isolated ports | ✅ `bun run typecheck` / `lint` / `test`; Playwright at `DOKAN_PORT=4829 DOKAN_WEB_PORT=5284` (avoids the vault spec's 4399/5174) |

Spec findings: the extra hardening (layout-effect unmount guard, `abandonAttempt`,
`resolving` disable, sidebar e2e, mock spread, Escape) is within the brief's
critic mandate ("every exit path" / "every stale value") and the operator's
skill-guided instruction; no #183 creep. `save()` re-entrancy and
refusal-recovery Cancel disabling are accepted residuals, documented.

## Summary

- Standards: 0 hard violations; smells fixed or documented.
- Spec: all round-2 requirements met and tested; the two re-reported findings
  verified already fixed with exact lines and tests.

## Evidence

- Reviewer transcripts were produced by the code-review sub-agents for this
  round; the synthesized findings and resolutions are above. Fix commits:
  `7815dd7`, `da2e394`, `1997cee`, `c1dd110`.
