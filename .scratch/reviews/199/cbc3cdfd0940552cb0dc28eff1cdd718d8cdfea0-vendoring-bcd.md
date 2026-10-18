# PR #199 — Greptile round 4 findings 1-9, verified at `cbc3cdf`

Greptile re-reviewed `b85584c` at 4/5 with 9 findings. This is the round-4
verification against the current HEAD.

## Findings 1-3 (the BCD mechanism)

| # | Finding | Status at `cbc3cdf` |
|---|---|---|
| 1 | A linked `SKILL.md` escapes the check | Fixed: `walkTree` rejects a symlink at any depth and never lists it as a file; `compare` rejects a linked root on either side. Tests cover a linked `SKILL.md` (matching content), a depth-2 walk, a nested file link, a nested dir link, a dangling nested link, a source-tree link, and both linked roots. Mutation "treat a link as a file" → 7 fail. |
| 2 | Doc says put an upstream commit ID in `computedHash` | Fixed in `docs/skills-vendoring.md` step 3: the upstream commit pin stays in the doc; `computedHash` stays a 64-char computed skill-content hash (explicitly "not the 40-char Git commit ID"). |
| 3 | Lost fixes escape the recovery check | Fixed: the doc now states the pin identifies **upstream** changes only; it cannot reveal a lost local fix (a hunk replaced by upstream text is absent from both trees). Lost fixes are found against the **pre-update local commit** in Git history. |

## Findings 4-9 (vendored examples)

| # | Finding | Status at `cbc3cdf` (line evidence) |
|---|---|---|
| 4 | HTTP errors become page data | Fixed: `res.ok`/`response.ok` guards before every `res.json()`, including the cancellation and typed-query examples — `tanstack-query/SKILL.md:81,91,225,382,730,832`. |
| 5 | Blank prices become zero | **Stale — already fixed before `b85584c` (round 3, `d860a0e`).** At the reviewed SHA, `rules/search-validation.md` already read `if (value === undefined \|\| (typeof value === 'string' && value.trim() === '')) return undefined`. Current: same guard at `:35`. Greptile re-listed a fixed line. |
| 6 | Failed rows can remain visible | Fixed: `onError` resets the query when there is no pre-insert snapshot — `:323-324` (`context.previousTodos === undefined` → `resetQueries`). |
| 7 | Hover warms the wrong cache | Fixed: the hover prefetch spreads `todoQueryOptions(todoId)` — `:535-536`, the same entry the loader uses at `:551`. |
| 8 | Load More removes earlier rows | Fixed: the append-only infinite example drops `maxPages` (comment at `:392-393`). |
| 9 | Invalid page numbers pass through | Fixed: `page` requires a finite positive integer — `search-validation.md:40-45` (`pageOrDefault` → `Number.isInteger(parsed) && parsed >= 1`); `tanstack-router/SKILL.md:110-114`. |

Both `.agents` and `.claude` copies are byte-identical (`bun run skills:check`:
32 skills in sync).

Per the round-4 brief, no further unseen instances were hunted — the PR must land.
