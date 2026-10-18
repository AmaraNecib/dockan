# PR #199 — Guard Phase 1 (pre-commit) at `cbc3cdf`

HEAD: `cbc3cdfd0940552cb0dc28eff1cdd718d8cdfea0`
Worktree: `D:/projects/mani-worktrees/chore-workflow-docs`
Branch: `chore-workflow-docs-and-tanstack-skills`

Change scope: skill/doc content (`.agents`, `.claude`), `docs/skills-vendoring.md`,
`AGENTS.md`, the `scripts/sync-claude-skills.ts` generator plus its tests, and
CI / pre-commit wiring. No app/UI code.

| Check | Command | Result | Exit |
|---|---|---|---|
| Typecheck | `bun run typecheck` | 3 successful, FULL TURBO | 0 |
| Lint | `bun run lint` | 0 errors | 0 |
| Unit (apps) | `bun run test` (turbo) | `@dokan/web` 986 pass / 0 fail, 5156 expect() calls, 157.79s; 3 tasks | 0 |
| Unit (scripts) | `bun test ./scripts/` | 12 pass / 1 skip / 0 fail, 14 expect() calls | 0 |
| Skills mirror | `bun run skills:check` | `skills mirror in sync: 32 skills` | 0 |
| Pre-commit hook | `.husky/pre-commit` | ran on `cbc3cdf` (oxlint + skills:check); passed | 0 |

Round-4 lint fix: `89a75e0` added
`if ((error as NodeJS.ErrnoException).code === 'EPERM') return`, which `oxlint`'s
`anti-slop(require-safety-comment-for-type-assertion)` rejected. `cbc3cdf` removes
the assertion entirely via a one-time `canSymlinkFiles` probe + `it.skipIf`, so the
file-symlink test is an honest skip on Windows and a real test on Linux CI.

The 1 skip is that file-symlink test (Windows without Developer Mode cannot create
one). It runs on Linux CI.

Rust: not applicable (no `apps/desktop/src-tauri/src/` change).

All green. Proceeded to Phase 2.
