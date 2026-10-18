# #218 code-review at cac905a

The Standards and Spec axes ran as parallel read-only `reviewer` children over
the pre-rebase diff `git diff f60d357...HEAD` at 72aa6c7, plus a delta review of
the last fix commit.

**Rebase delta (cac905a).** Re-issued after rebasing onto `origin/develop`
`4bf10be`. The only change to the reviewed source is #199's already-landed
binary-comparison fix (`readNormalised`/`sameContent` plus two tests) auto-merged
into `scripts/sync-claude-skills.ts`; the #218 logic is byte-identical to the
reviewed 72aa6c7 content, so every finding and disposition below still holds.
Commit SHAs in the body are pre-rebase: e71b57b→2141a9c, a892ba1→9cd6bcf,
43c4ca5→390b23d, 72aa6c7→cac905a.

## Standards

No documented-standard violation. The design doc is at the path
`docs/engineering-workflow.md` names. Judgement calls, all accepted:
- Tracking `.scratch/implementation/218-design.md` matches repo convention
  (`.scratch/implementation` is already tracked).
- The branch was stacked on PR #199 head f60d357 while #199 was open; it is now
  rebased onto `origin/develop` `4bf10be`, which carries #199.
- Duplicated link-message code was fixed in a892ba1. `compare` owns the link
  messages and `runCheck` delegates to it. The sync source-link scan and
  `nonLockedAgentLinks` share a shape but differ in prefix and scope, left as is.

## Spec

Acceptance 1 to 4 verified:
1. A link anywhere under `.agents/skills` fails. Locked and non-locked paths are
   covered by CLI tests and mutation-proven on the real tree.
2. A command-level test drives the CLI, including one that spawns the wired
   `bun run skills:check` with `SKILLS_MIRROR_ROOT`.
3. `sync` refuses a source symlink (root or nested) and leaves the mirror
   untouched. The check remedy is split: source and root links say replace by
   hand, a per-skill mirror link says `skills:sync`.
4. The stale SAFETY comment is corrected and its claims are now true.

Partial, accepted:
- When a locked mirror entry is itself missing, an inner link in that source is
  not named. The gate still exits 1.
- No timeout changed; no vendored skill content touched.

Scope creep, accepted and small:
- Lock-name and lock-shape validation, part of failing closed.
- `SKILLS_MIRROR_ROOT` is required by acceptance 2.

## Evidence

- Review lenses: `.scratch/reviews/218/cac905a-test-audit.md`; workflows ran from
  the pre-rebase `f60d357` and the delta commit, re-issued at `cac905a`.
- Gate: `bun run skills:check` = 32 in sync, exit 0.
