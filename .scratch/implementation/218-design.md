# #218 — harden `skills:check` beyond the mirrored set

Tier: **Standard**. The gate protects the skill mirrors, so it must fail closed.

## Base note (important)

The brief names `origin/develop` (`68f5107`) and claims it contains #199's gate.
It does not: PR #199 (`chore-workflow-docs-and-tanstack-skills`) is still OPEN and
`scripts/sync-claude-skills.ts` exists only on that branch. This lane is stacked
on #199's head `f60d357`; review diff is `git diff f60d357...HEAD`, and the
branch must be rebased onto `develop` once #199 merges.

## Gaps and fixes

1. **Non-locked trees unwalked.** `runCheck` gains a whole-tree scan of
   `.agents/skills`: every top-level entry not in `skills-lock.json` is checked
   for a link at its root and recursively. Locked trees keep going through
   `compare` (unchanged), so no message is duplicated.
2. **No CLI seam.** Export `runCheck(root)`; the CLI honours
   `SKILLS_MIRROR_ROOT` (default: repo root). A test spawns the script with that
   env against a temp root, so the command (not just helpers) is exercised.
3. **`sync` copies source symlinks.** `sync` now refuses when any locked source
   root or nested path is a symlink, before copying. The `--check` remedy is
   conditional: link problems say "replace the symlink", the rest say
   "run `skills:sync`".
4. **Stale SAFETY comment.** The old comment claimed a malformed lock surfaces as
   a missing mirror source. It throws instead. The comment is corrected, and the
   CLI catches the throw and prints one clear failure line (still exit 1).

## Public surface

- `export const runCheck = (root: string): { names: string[]; problems: string[] }`
- `export const nonLockedAgentLinks = (agentsDir: string, names: string[]): string[]`
- CLI env: `SKILLS_MIRROR_ROOT`.
- Exit contract unchanged: 0 in sync, 1 on drift; still fails a missing / extra /
  differing entry and a linked root.

## Planned tests (bun `scripts/`)

- Unit (`runCheck`): clean temp root passes; link inside a non-locked tree is
  reported; non-locked top-level link is reported.
- CLI (`spawnSync` + `SKILLS_MIRROR_ROOT`): in-sync temp root exits 0; link in a
  non-locked tree exits 1 with the link path and the link remedy; plain drift
  exits 1 with the sync remedy; malformed lock exits non-zero; `sync` refuses a
  source symlink and leaves the mirror untouched.
- Existing `compare` / `walkTree` tests stay green.
- Real tree: `bun run skills:check` still reports **32 in sync**.

No Playwright spec is added: this is a build-time gate with no user-facing flow.
The full suite still runs for Guard.

## Risks

- Stacked base; isolated to `scripts/` so it rebases cleanly.
- Windows junctions vs POSIX symlinks: tests use `junction` (no admin on Windows,
  a normal symlink on POSIX), matching #199's fixtures.
- The whole-tree walk is O(entries) per check; the tree is small (32 skills).
