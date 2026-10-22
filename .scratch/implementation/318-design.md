# Design — #318: typecheck the e2e tests

## Review tier

**Standard.** Justification: config + docs only — a new `tsconfig` project, one
script line, one docs section. It touches no failure mode from the High-assurance
list; the worst it can break is a CI check, which the change itself is meant to
make stricter.

## Problem

`apps/web/tsconfig.json` includes `["src", "vite.config.ts"]`, `apps/api/tsconfig.json`
includes `["src"]`, `scripts/tsconfig.json` includes `["**/*.ts"]` — and nothing covers
`tests/**`. `bun run typecheck` passes while an e2e spec's bad import only fails when
the runner loads it. It bit for real: a spec imported `APP_HOST` from
`@dokan/e2e-support`, a package with no entry point.

## Change

1. **`tests/tsconfig.json`** — a new root project, modelled on `scripts/tsconfig.json`
   (same shape, same `typeRoots` trick reaching into `apps/api/node_modules`, since
   `tests/` has no `node_modules` of its own; `bun.types` is resolved from the root).
   Guidance from the brief; identical body so the two sibling configs stay diffable.
2. **Root `typecheck` script** — append `tsc -p tests/tsconfig.json` after the
   existing `tsc -p scripts/tsconfig.json`. Turbo untouched: `tests/` is outside the
   workspaces, so it never appears in the graph.
3. **Config fixes in `tests/e2e/**`** — whatever the new project surfaces. Fix only
   what compiles wrong without changing product behaviour; anything else is reported,
   not fixed.
4. **Docs section in `docs/engineering-workflow.md`** — the three environment paths
   (`PLAYWRIGHT_BROWSERS_PATH`, `RED_ON_PARENT_CACHE`, `BUN_INSTALL_CACHE_DIR`) a
   fresh machine does not have, as a variable/effect table plus one line that turbo's
   cache already lives in the repo (`.turbo/`).

## Interfaces

None public. The new project is consumed only by the root `typecheck` script and CI.

## Dependencies

No new dependency. `typescript`, `@playwright/test` and `@types/bun` are already in
the tree.

## Planned tests

- `bun run typecheck` fails when a deliberately broken line is added to `tests/e2e/`
  (paste the error), and passes again once reverted.
- `bun run lint`, api + web suites (`turbo test`) and `bun scripts/red-on-parent.ts`
  stay green.

## Risks

- The new project may surface pre-existing errors in `tests/**`; each one is either a
  cheap config/test fix or a reported finding — never a product-behaviour change.
- Pulling package sources in transitively (e.g. `packages/contracts/src/app-host`) must
  not change what the api/web projects compile — they have their own tsconfig roots and
  are unaffected; verified by keeping their suites green.
- `test:affected` is **not** touched: `scripts/test-affected.ts` and its script exist on
  develop and its filter spelling is measured; this lane reads it, does not rewrite it.
