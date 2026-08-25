# project

2026-08-25, whole-project dependency swap for apps/web (radix -> base-ui).

## Dependency swap

- `apps/web/package.json`: `radix-ui@^1.6.7` removed; `@base-ui/react@^1.7.0`
  added (the stable Base UI package; the `@base-ui-components/react` name in
  the task brief is the pre-release scope and does not exist on npm — the
  registry golden pairs emit `@base-ui/react`).
- `bun.lock`: regenerated via `bun remove radix-ui` / `bun add @base-ui/react`
  (package runner: bun). No radix entries remain in the lockfile.
- `apps/web/components.json`: `"style": "radix-nova"` -> `"base-nova"` so
  future `shadcn add` delivers base variants. Valid because this lane migrated
  the LAST radix usage in the repo (see sweep).

## App-code sweep

- Full-repo grep for `radix-ui` / `@radix-ui` before this change: exactly
  `apps/web/src/components/ui/button.tsx`, `label.tsx`, `select.tsx` and the
  package.json entry. No app code outside components/ui imported radix.
- Consumer sweep for the radix call-site props from consumer-props.md
  (`asChild`, select `position`, etc.): no `asChild` usage exists anywhere in
  apps/web; the only ui consumers are `Button` (unknown-scan-dialog.tsx,
  backups.tsx — plain usage) and `Skeleton` (pure component, untouched). No
  call-site edits were needed.
- Intentionally untouched (hard rule, not radix): sonner (toasts), and the
  pure components card/input/skeleton/table.

## Baseline vs final build

- Baseline (before dependency changes): `bun run typecheck` passing.
- Final: `bun run typecheck` (3 turbo tasks) 0; `bun run lint` (oxlint) 0;
  `bun run test` (turbo) 204 api + web suite incl. new ui tests, 0 fail;
  `DOKAN_PORT=4328 DOKAN_WEB_PORT=5184 bun run test:e2e -- --workers=1`
  12/12 pass. `.dokan-port` restored byte-exact after the e2e run.

## Remaining radix wrappers

0 wrappers remain on Radix (derived: `grep -rn "radix-ui\|@radix-ui" apps/web/src` is clean).