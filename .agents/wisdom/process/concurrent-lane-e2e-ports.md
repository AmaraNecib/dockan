# Concurrent lane worktrees fight over the shared e2e ports

**Date:** 2026-10-15 · **Ticket:** 146 · **Area:** tests/e2e, playwright.config.ts, crew worktrees

Two full `bun run test:e2e` runs on 4317/5173 failed, 7 specs and then 8, with a
*different* set each time: `page.goto: net::ERR_CONNECTION_REFUSED at
http://127.0.0.1:5173` in `settings.spec.ts`, plus timeouts in `00-onboarding`,
`activity`, `catalog-scan`, `debts` and `purchase-intake`. Every one of them
passed in isolation.

The cause was not this branch. A sibling crew lane in another worktree
(`feat-130-arabic-name-variants`) was running the same suite on the same ports at
the same time. Both lanes start `@dokan/api` and `@dokan/web` from
`playwright.config.ts`, and Windows leaves those processes behind after a run, so
the two suites killed each other's dev servers. `tasklist` showed the other
lane's `playwright test` and a stale `bun run test:e2e` still alive.

This is the same failure family as
`2026-10-13-e2e-stale-server-and-checksum-flake.md`, but the trigger is another
lane rather than this lane's own previous run. "A different set of specs fails
each run" is the tell, and it costs a lot of time if you read it as a regression.

**Always**: before a full e2e run, check whether another lane is running one.
Look for other `playwright test` processes and their cwd, not just listeners on
4317/5173. When another lane is active, run on an isolated pair instead of
killing the shared ports (killing them breaks the other lane):

```bash
DOKAN_PORT=4617 DOKAN_WEB_PORT=5473 bun run test:e2e
```

The config reads both from the environment, so the api, the vite proxy and the
Playwright `baseURL` all move together. Do not kill a shared 4317/5173 listener
owned by a sibling worktree.
