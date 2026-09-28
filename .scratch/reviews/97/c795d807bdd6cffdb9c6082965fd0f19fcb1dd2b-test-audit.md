# Test audit — issue #97, PR #104 round 4 (delete the optimism)

- **Reviewed HEAD:** `c795d807bdd6cffdb9c6082965fd0f19fcb1dd2b`
- **Fixed point:** `dfe35222a355fcdb606725cbac175726b03ae760` (previous reviewed HEAD)
- **Diff:** `git diff dfe3522...c795d80` (commits `ce91093` simplification, `c795d80` review fixes)
- **Tier:** Standard
- **Method:** three read-only reviewer sub-agents (edge-case hunter, coverage
  analyst, test-quality reviewer) run as one parallel workflow at `ce91093`;
  this file synthesises them and records the fixes now present in `c795d80`.

## Verdict

The simplification is real and complete: `grep` finds no overlay, overlay-clear
effect, write queue/sequence, `cancelQueries`, retry tuning, or deleted seam
callers. Every directive point has a real test, including the new sequencing
and disabled-control cases. No blocker.

## Findings and disposition

| # | Risk | Finding | Disposition |
|---|------|---------|-------------|
| 1 | HIGH | The write echo could create a partial cache when the first read had not landed (`previous === undefined`), dropping sibling preferences | **Fixed** `c795d80`: the `setQueryData` updater returns `previous` unchanged when undefined; controls are also disabled while the read is pending, so the app never writes against an unconfirmed map |
| 2 | MED | The `RequireSession` migration-before-render sequencing had no test | **Fixed** `c795d80`: `App.test.tsx` holds `preferencesGet`, asserts the shell is withheld, releases, then asserts the legacy import landed and the shell rendered |
| 3 | MED | The new disabled-while-writing controls were untested | **Fixed** `c795d80`: `dashboard.test.tsx` gates `preferencesSet` and asserts the dismiss button is disabled until the write resolves |
| 4 | MED | The failed-dismissal test's synchronous panel assertion could pass on a no-op click | **Fixed** `c795d80`: it now waits for `preferenceWriteCalls >= 1`, then asserts the panel and server are unchanged |
| 5 | LOW | `migrateLegacySidebarCollapsed` returned a value only tests consumed | **Fixed** `c795d80`: returns `Promise<void>`; the migration tests assert side effects |
| 6 | LOW | `onboarding-state.test.ts` (9 tests) and the sidebar seam describe (5) were deleted | **Accepted:** they tested the deleted seam/overlay machinery; the surviving semantics (parse, failed-read default, milestone idempotency) are covered by `preferences.test.tsx`, `app-sidebar.test.tsx`, `dashboard.test.tsx`, and the API store tests |
| 7 | LOW | A hung write leaves the control disabled for the session (no timeout) | **Dismissed:** loopback sqlite; the fetch rejects rather than hanging, and a page reload recovers |
| 8 | LOW | Failed writes are silent (no toast) | **Dismissed:** the directive's policy is explicit — the server value simply stays; a toast is a separate product decision |
| 9 | LOW | StrictMode can run the migration effect twice | **Dismissed:** idempotent (the second read sees the server value and clears the legacy key) |
| 10 | LOW | The migration read is separate from the shell's first query read | **Dismissed:** one extra loopback GET on launch; cheap |

## Commands (this HEAD)

```
bun run typecheck   # 3/3 packages pass
bun run lint        # oxlint: 0 errors
bun run test        # api 470 pass, web 276 pass, desktop 34 pass, 0 fail
bun run test:e2e    # 30/30 pass (DOKAN_PORT=4817 DOKAN_WEB_PORT=5673)
bunx playwright test tests/e2e/00-onboarding.spec.ts --repeat-each=2  # 10/10
```

## Residual risk

- No test models a delayed read racing a write; that is intentional — the
  design removes the state that could disagree, and the controls are disabled
  while the shared read is pending.
- One E2E full-suite attempt failed while another worktree on the same machine
  was running vitest; two clean re-runs passed 30/30. The failures were auth
  and action timeouts, not product assertions.
