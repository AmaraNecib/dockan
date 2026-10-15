# Vendored TanStack skills — upstream pins and re-apply checklist

Three skills under `.agents/skills/` are upstream TanStack agent skills plus our
own fixes. They are **not** a pristine copy, so an upstream sync must not
overwrite the fixes. This file pins the baseline we forked from and says how to
re-apply a sync without losing the divergence.

## Source of truth and the mirror

`.agents/skills/<name>` is canonical. `.claude/skills/<name>` is generated from
it by `scripts/sync-claude-skills.ts`; the mirrored set is the keys of
`skills-lock.json`. Never edit `.claude/skills` by hand — the pre-commit hook
and the CI `checks` job run the drift check and fail on any divergence.

```sh
bun run skills:sync    # regenerate .claude/skills from .agents/skills
bun run skills:check   # fail on missing/extra/differing entries or symlinks
```

## Upstream pins

| Skill (this repo) | Upstream repo | Upstream path | Pinned commit | Vendored |
|---|---|---|---|---|
| `tanstack-query` | `tanstack-skills/tanstack-skills` | `plugins/tanstack-query/skills/tanstack-query/` | `6666c1b` (2026-01-25) | 1 file / 872 lines |
| `tanstack-router` | `tanstack-skills/tanstack-skills` | `plugins/tanstack-router/skills/tanstack-router/` | `6666c1b` (2026-01-25) | 1 file / 737 lines |
| `tanstack-router-best-practices` | `DeckardGer/tanstack-agent-skills` | `skills/tanstack-router/` (renamed on vendor) | `b2e55a5` (2026-09-09) | 37 files / 4832 lines |

Full SHAs:

- `tanstack-skills/tanstack-skills` — content baseline
  `6666c1b363325fdd079dd30fa07f6ea7ae4608b5`; repo HEAD at pin time
  `6f5521ecbdfbfa3d54d335eba6c8b4df0b804c03` (2026-01-29). The two files above
  were last changed at `6666c1b`, so that is the exact baseline.
- `DeckardGer/tanstack-agent-skills` — content baseline
  `b2e55a575e2167fc747d79d49d98dcecef034bb1`; repo HEAD at pin time
  `b2fc14c974b2ca09b38de09c28237f240175205b` (2026-09-09).

`tanstack-config` was vendored from the same `tanstack-skills` repo and was
**removed** (2026-10): every example targets `@tanstack/config`, which no
`package.json` in this workspace depends on. It is not part of the fork below.

## Divergence from upstream

Measured with a line-ending-robust recursive diff against the pinned content:

```sh
diff -r --strip-trailing-cr -u <upstream-dir> .agents/skills/<name>
```

Current fork size: **15 of 39 files modified, +355 / −196 lines (net +159,
churn 551).** (Re-measured after the round-4 review fixes.)

| Skill | files changed | added | deleted |
|---|---|---|---|
| `tanstack-query` | 1 / 1 | +50 | −15 |
| `tanstack-router` | 1 / 1 | +19 | −14 |
| `tanstack-router-best-practices` | 13 / 37 | +286 | −167 |

The added lines are the PR #199 review fixes, each verified against installed
packages or a live run:

- `isLoading` → `isPending` guards for the offline-paused first fetch
  (`tanstack-query/SKILL.md`, `rules/load-parallel.md`).
- `res.ok` guard before `res.json()` in the query-function, infinite-query,
  cancellation and typed-query examples (`tanstack-query/SKILL.md`).
- Optimistic-list `onError` resets the query when there was no pre-insert
  snapshot, instead of restoring `undefined` and leaving the row in place.
- Hover prefetch spreads `todoQueryOptions(todoId)`, so it warms the same cache
  entry as the route loader instead of a separate `['todo', id]` key.
- The append-only infinite example drops `maxPages`, which evicted earlier rows
  with no previous-page control to load them back.
- Empty-cache seeding on `setQueryData` list updaters: `(old = []) => [...]`.
- `getNextPageParam` on `prefetchInfiniteQuery`.
- `AuthProvider` imports the router instead of calling `useRouter()` above its
  own `RouterProvider`.
- Native `onSubmit` handlers take the event and call `preventDefault()`.
- `qs` custom decoder calls the default decoder first; the hybrid parser guards
  `JSON.parse`; the Base64 example is URL-safe (base64url).
- `search-validation`'s `numberOrDefault` keeps a legitimate `0` and rejects
  `NaN`, empty and whitespace-only strings.
- `tanstack-router`'s `page` falls back to `1` on an empty/whitespace param,
  and (round 4) requires a finite positive integer, so `-2`/`Infinity` also
  fall back to `1`.
- `preloadStaleTime` prose says "becomes stale", not "garbage collected".
- `notFoundComponent` receives data via props; `onError`/`onCatch` take direct
  arguments; hooks use `Route.id`, not `Route.fullPath`.
- `ctx-dependency-injection` fence split; `nav-relative-paths` `from` note
  (`RoutePaths` for `Link`, `RouteIds` for hooks).

## Re-applying after an upstream sync

1. Fetch the upstream repo and check out the pinned commit for the skill (see
   the table). `tanstack-router-best-practices` maps upstream
   `skills/tanstack-router/` to our `.agents/skills/tanstack-router-best-practices/`.
2. Diff upstream against our tree:
   `diff -r --strip-trailing-cr -u <upstream-dir> .agents/skills/<name>`.
3. Reconcile into `.agents/skills/<name>` — the only file tree you edit. Apply
   genuine upstream changes; keep our hunks above. Move the upstream commit pin
   in this file. `skills-lock.json`'s `computedHash` stays a computed
   skill-content hash (a 64-char digest, not the 40-char Git commit ID).
4. Regenerate and verify the mirror:
   `bun run skills:sync && bun run skills:check`.
5. Commit `.agents`, the regenerated `.claude`, this file, and
   `skills-lock.json` together.

### Telling a clobbered fix from an upstream change

- `npx skills add` / `update` rewrites `.claude/skills/<name>` (as an absolute
  symlink into the installing worktree) and resets `computedHash`. It does not
  touch `.agents`. If it ran, `bun run skills:check` fails immediately; that is
  the clobber signal, not a real upstream change.
- To attribute one hunk: run the step-2 diff against the pin. A hunk that exists
  in upstream but not here is an upstream change; a hunk that exists here but
  not upstream is ours.
- The pin identifies **upstream** changes only. It cannot reveal a lost local
  fix: when an update replaces our hunk with upstream text, the fix is absent
  from both trees, so this pinned diff shows nothing. To find or restore a lost
  fix, compare our tree against the **pre-update local commit** in Git history,
  e.g. `git diff <pre-update-sha> -- .agents/skills/<name>`.
- When the pin moves, the diff baseline moves with it: update the commit in the
  table first, then re-measure the divergence counts above so the fork size on
  record stays accurate.
