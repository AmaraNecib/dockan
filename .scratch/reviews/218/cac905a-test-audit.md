# #218 test-audit at cac905a

Three lenses (edge-case hunter, coverage analyst, quality reviewer) ran as
read-only `reviewer` children over the pre-rebase `git diff f60d357...HEAD`. Two
rounds: the first at e71b57b found real gaps, fixes landed in a892ba1 and
43c4ca5, and a delta review closed the last one at 72aa6c7.

**Rebase delta (cac905a).** Re-issued after rebasing onto `origin/develop`
`4bf10be`. #199's landed binary-comparison fix was auto-merged into
`scripts/sync-claude-skills.ts` and adds two `compare` tests; no #218 fixture or
assertion changed. Re-run: `bun test ./scripts/` = 38 pass, 1 skip, 0 fail.
Commit SHAs in the body are pre-rebase: e71b57b→2141a9c, a892ba1→9cd6bcf,
43c4ca5→390b23d, 72aa6c7→cac905a.

## Verdict: can something still pass that should fail?

Not after the fixes. The gate now fails for a link at any depth under
`.agents/skills` (locked or not), a dangling link, either linked root, a
missing/extra/differing entry, a malformed lock, a lock whose `skills` value is
not a plain object, an empty lock, and a lock key that escapes the skills
directory.

## Findings and dispositions

| Finding | Lens | Fix |
|---|---|---|
| `{"skills":[]}` / `{"skills":"abc"}` / `{"skills":42}` printed "0 skills" and exited 0 | edge | 43c4ca5: reject a non-plain-object `skills` via `Object.getPrototypeOf` |
| `{"skills":{}}` let sync prune the whole mirror and exit 0 | edge | 43c4ca5: reject a lock that lists no skills |
| `{"skills":{"":{}}}` made `sync` treat the skills root as a skill (`join(root,'')===root`) | edge | 43c4ca5: `isSafeSkillName` rejects the empty key; a table test covers `/`, `\`, `:`, `.`, `..`, `''` |
| Dangling source link reported "missing", not a link, with the sync remedy | edge | a892ba1: `isSymlink` uses `lstat`; `runCheck` checks links before `existsSync` |
| Linked `.agents/skills` root double-reported as missing sources | edge | a892ba1: skip per-skill compare once a root link already fails |
| Per-skill linked `.claude` mirror got the "replace by hand" remedy | spec | a892ba1: route dest-only links to `skills:sync` |
| Linked `.claude/skills` root got the sync remedy, but sync refuses roots | delta review | 72aa6c7: route any non-per-skill link to hand replacement |
| No locked-tree link case through the CLI | coverage | a892ba1: CLI test for a link inside `demo/rules` |
| No wired `bun run skills:check` case | spec | a892ba1: `spawnSync(bun, ['run','skills:check'])` with `SKILLS_MIRROR_ROOT` |
| Non-locked nesting only one level | coverage | a892ba1: two-level non-locked link test |
| `isSafeSkillName` branches untested | quality | 43c4ca5: table test over every rejected shape |
| Empty lock and non-object shape untested | quality | 43c4ca5: three tests |

Declined, with reason:
- An empty `SKILLS_MIRROR_ROOT` falls back to the repo root, the same as unset; a
  harness that exports a blank value is indistinguishable from not exporting.
- A locked-tree inner link is not named when the mirror entry is itself missing.
  The gate still exits 1, and `skills:sync` surfaces the link on the next run.

## Mutation proof

A real link under `.agents/skills` fails `bun run skills:check`:
- non-locked: `.agents/skills/guard/probe` -> exit 1, names the link.
- locked: `.agents/skills/tdd/probe` and a dangling `tdd` link -> exit 1.
Removed after each run; the restored tree reports "32 skills in sync", exit 0.

## Test quality

Grade A-. Each fixture is its own `mkdtempSync` root, cleaned in `finally`.
Assertions are exact arrays or explicit `toContain`, and the negative tests use
`not.toContain('is missing')` so a wrong-reason pass fails. The one skip is the
pre-existing real file-symlink case (Windows needs Developer Mode); a
junction-based test covers the same branch on every platform.
