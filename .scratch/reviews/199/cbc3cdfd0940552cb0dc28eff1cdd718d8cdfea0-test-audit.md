# PR #199 — test-audit at `cbc3cdf` (sync-claude-skills link gate)

Scope: `scripts/sync-claude-skills.ts` + `scripts/sync-claude-skills.test.ts`.
Three lenses (edge-case hunter, coverage analyst, quality reviewer) run as
read-only `reviewer` children; results synthesised here.

## Verdict: can a link still pass?

No — for the gate's contract (a skill named in `skills-lock.json`, i.e. the
mirrored set). `walkTree` reports a symlink at any depth in either tree and never
lists it as a file; `compare` rejects a linked root on either side. A fresh
mutation ("treat a link as a file in the walk") fails 7 of 13 tests. The
linked-`SKILL.md` bypass from Greptile finding 1 is closed.

## Mutation results

| Mutant | Tests killed (before `cbc3cdf` → after) |
|---|---|
| treat a link as a file (`walkTree`) | 7 → 7 |
| non-recursive walk | 8 → 8 |
| never detect content drift | 0 → 1 (closed here) |

## Closed in `cbc3cdf`

- **Vacuous pass (quality lens).** "rejects a real linked SKILL.md" returned early
  on Windows `EPERM` and reported `(pass)` with zero assertions. Now a one-time
  `canSymlinkFiles` probe + `it.skipIf(!canSymlinkFiles)` gives an honest `(skip)`
  locally and a real test on Linux CI. Removing the `as NodeJS.ErrnoException`
  assertion also fixes the Phase 1 lint failure.
- **Equivalence core unpinned (edge + quality lenses).** Three tests now assert
  exact problem arrays for: differing content, a file only the mirror has, a file
  only the source has.

## Deferred (out of scope — the gate's contract is the mirror set)

1. **Non-locked `.agents/skills` subtrees.** `skills:check` walks only
   `Object.keys(lock.skills)`; a link inside a Pi-only skill (e.g.
   `.agents/skills/guard/`) passes. By design per the script header ("Pi-only
   skills are deliberately not mirrored"), but a portability hazard if such a link
   is ever committed. Separate change.
2. **No CLI `main()`/`--check` integration test.** `ROOT`/`LOCK_FILE` are
   module-level consts and `main` is not exported, so a temp-root integration test
   needs a seam (env override or exported `runCheck`). Separate change.
3. **`sync` copies source symlinks as links** (`cpSync` defaults
   `dereference:false`), so the printed remedy could re-create the drift. Low risk;
   `--check` still fails the next run.
4. **Stale SAFETY comment** at `sync-claude-skills.ts:145`: a malformed
   `skills-lock.json` throws at `JSON.parse` rather than surfacing as a missing
   mirror source. Fails closed.
