# PR #199 — Owner decision B+C+D evidence at `d01fab0`

HEAD: `d01fab01bd7bfe9e11af5ee3c30d51601fcc4943`
Branch: `chore-workflow-docs-and-tanstack-skills`
Worktree: `D:/projects/mani-worktrees/chore-workflow-docs`
Baseline for this work: `a85ae3d` (round 3, pushed and verified).

Three commits, no push:

| Commit | Scope |
|---|---|
| `a68b8b3` | **B** — drop `tanstack-config` from both trees, `skills-lock.json`, feature-implement table |
| `bebb0ed` | **C** — `.agents` is the source; `.claude` is generated; sync script + drift check wired into pre-commit and CI |
| `d01fab0` | **D** — pin the three upstream commits, record divergence + re-apply checklist |

## B — drop `tanstack-config`

Every file in the skill targets `@tanstack/config`. Verified: no workspace
manifest depends on it.

```
grep -rn "@tanstack/config" apps/*/package.json packages/*/package.json
→ (no matches)
```

Removed:

- `.agents/skills/tanstack-config/SKILL.md` (1 file / 343 lines)
- `.claude/skills/tanstack-config/SKILL.md` (1 file / 343 lines)
- `skills-lock.json` entry (33 → 32 skills; `bun -e` re-parse confirms valid JSON)
- `feature-implement/SKILL.md` row
  `| Build/version/publish a JS or TS package (exports, publint) | tanstack-config |`

Post-check: `grep -rn "tanstack-config"` across `*.md/*.json/*.yml/*.ts`
(excluding `.scratch/`) → no matches.

## C — one source of truth for the mirror

**Decision: `.agents/skills/<name>` is canonical; `.claude/skills/<name>` is a
generated, tracked copy.** `scripts/sync-claude-skills.ts` implements both
directions of the check:

```
bun run skills:sync     # rm + copy .agents/skills/<name> -> .claude/skills/<name>, prune extras
bun run skills:check    # exit 1 on any missing/extra/differing entry, or a symlink
```

The mirrored set is the key set of `skills-lock.json` — the skills installed by
`npx skills add`, which is exactly what `.claude/skills` held at baseline
(33 names before B, 32 after). Pi-only skills (`guard`, `feature-implement`,
`test-audit`, `debate`, …) are **deliberately left out of the `.claude` mirror**,
matching today's behaviour; mirroring all 52 `.agents` skills would add 19
Claude-visible skills that reference pi-only tooling. That is the scope line.

### Why a copy + drift check, not a symlink

The owner supplied the two disqualifying facts, and both hold here:

1. `npx skills add` writes `.claude/skills/<name>` as an **absolute** symlink
   into the installing worktree. That link is valid only in the worktree that
   ran the installer; every other checkout gets a dangling link, and the target
   can live outside the repo.
2. This repo runs on Windows. Git checks out symlinks only with
   `core.symlinks=true`, which needs Developer Mode/admin and is not the default
   on the owner's machine (verified: `git config core.symlinks` is unset).

A checked-in generator plus a failing drift check is portable, works on a plain
`git clone` on every platform, and turns a silent divergence into a red check.
`bun run skills:check` runs in `.husky/pre-commit` and the CI `checks` job.

### Drift check proven to fail closed

| Probe | Command | Result |
|---|---|---|
| Clean tree | `bun run skills:check` | `skills mirror in sync: 32 skills`, exit 0 |
| Content drift (append a line to `.claude/skills/tanstack-query/SKILL.md`) | `bun run skills:check` | `tanstack-query/SKILL.md: content differs`, exit 1 |
| Extra dir (`.claude/skills/zzz-extra/`) | `bun run skills:check` | `... is not in skills-lock.json (extra)`, exit 1 |
| Restored | `bun run skills:check` | exit 0 |
| Symlink entry | not creatable in this checkout (`EPERM` on Windows without privilege) | branch is code-reviewed only; `compare()` short-circuits on `lstatSync().isSymbolicLink()` |

`bun run skills:sync` then `diff -rq` over every mirrored tree:
`ALL 32 MIRRORS BYTE-IDENTICAL`; `git status` shows **no** `.claude` diff, i.e.
the generator is a content no-op at the committed state.

### Counts before → after

Method: `find <dir> -type f -exec wc -l {} + | awk '$2!="total"{s+=$1} END{print s}'`
(per-file, so a missing final newline cannot merge two files).

| Tree | before `a85ae3d` | after `d01fab0` | delta |
|---|---|---|---|
| `.agents/skills` files | 419 | 418 | −1 |
| `.agents/skills` lines | 82,203 | 81,860 | −343 |
| `.claude/skills` files | 238 | 237 | −1 |
| `.claude/skills` lines | 40,323 | 39,980 | −343 |
| vendored TanStack files (per tree) | 40 | 39 | −1 |
| vendored TanStack lines (per tree) | 6,784 | 6,441 | −343 |

The whole delta is the deleted `tanstack-config`; the mirror count did not
change because sync is a no-op on the remaining 32 skills.

## D — pin the upstream

`docs/skills-vendoring.md` (linked from `AGENTS.md` under **Vendored skills**):

- `tanstack-skills/tanstack-skills` — content baseline
  `6666c1b363325fdd079dd30fa07f6ea7ae4608b5` (2026-01-25); repo HEAD at pin
  time `6f5521ecbdfbfa3d54d335eba6c8b4df0b804c03`.
- `DeckardGer/tanstack-agent-skills` — content baseline
  `b2e55a575e2167fc747d79d49d98dcecef034bb1` (2026-09-09); repo HEAD at pin time
  `b2fc14c974b2ca09b38de09c28237f240175205b`.

### Divergence count (the fork made explicit)

`diff -r --strip-trailing-cr -u <upstream-dir> .agents/skills/<name>` against
the pins:

| Skill | files changed | added | deleted |
|---|---|---|---|
| `tanstack-query` | 1 / 1 | +35 | −12 |
| `tanstack-router` | 1 / 1 | +17 | −14 |
| `tanstack-router-best-practices` | 13 / 37 | +278 | −166 |
| **total** | **15 / 39** | **+330** | **−192** |

Net +138, churn 522. (The earlier round-2 figure +334/−197 included
`tanstack-config` at +6/−6 and the pre-round-3 text; after dropping config, this
is the measured state.)

The doc also lists what the added lines are (rounds 1–3), the re-apply steps,
and how to attribute a clobbered fix vs an upstream change.

## Reviews run this round

| Review | Run? | Why |
|---|---|---|
| Guard 1 (typecheck, lint, unit) | Yes | `…-guard1.md`. |
| Guard 2 (full Playwright) | Yes | `…-guard2.md`. |
| Drift check + probes | Yes | Table above; this is the new mechanism's test. |
| Divergence measurement | Yes | Pinned upstreams cloned and diffed; counts above. |
| test-audit / debate / code-review / Greptile CLI | No | No app behaviour changed; the mechanism is covered by the drift probes and the two guards. |

## Owner review flags

- `bebb0ed` touches **`.github/workflows/ci.yml`** (adds the `Skills mirror
  drift` step to the `checks` job). Per `AGENTS.md`, CI changes go to the owner
  for the diff — this is called out rather than pushed.
- The symlink-detection branch of `skills:check` could not be exercised in this
  checkout (`EPERM`); it is a two-line `isSymbolicLink()` short-circuit.
- No push, per instruction.
