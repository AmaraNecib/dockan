# PR #199 — Guard Phase 2 (pre-review) at `d01fab0`

HEAD: `d01fab01bd7bfe9e11af5ee3c30d51601fcc4943`

Change scope: skill/doc content + a generator script + CI/pre-commit wiring. No
UI flow changed, but the brief asked for the full Playwright suite, so it was
run.

## Command

```
DOKAN_PORT=4637 DOKAN_WEB_PORT=5279 bun run test:e2e
```

- Isolated ports 4637/5279 (avoided 4317/5173 and the vault pair 4399/5174).
  All four ports were checked free first; no sibling lane bound them, so the
  hardcoded vault specs ran uncontended.
- Default `E2E_DATA_DIR` (`.e2e-data`, per-worktree) — no override, matching
  the round-2 lesson: an override breaks `backups.spec.ts`, which hardcodes
  `path.join(process.cwd(), ".e2e-data", "backups")`.
- `tests/e2e/vault.spec.ts` still hardcodes 4399/5174 (known, tracked in
  `AGENTS.md`; making that pair configurable is a separate change).

## Result

```
56 passed (5.2m)
E2E_EXIT=0
```

All 56 specs green, including the three vault specs (`vault.spec.ts:113`,
`:166`, `:198`).

## Other Phase 2 checks

- `bun run typecheck` → exit 0.
- `bun run lint` → exit 0.
- `bun run skills:check` → exit 0 (`32 skills in .claude/skills == .agents/skills`).
- `git status` clean after reverting the `.dokan-port` rewrite that
  `bun run test:e2e` produces; upstream clones and extracted baselines under
  `.scratch/` were removed.
- `diff -rq` over every mirrored tree → byte-identical (32/32), and
  `bun run skills:sync` produced no `.claude` git diff.
