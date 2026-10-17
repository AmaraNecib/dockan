# #253 round 2 — evidence (HEAD 25ff75a)

PR **#265**, issue **#253**. Greptile round 2 scored 4/5 at `1ddaf227` and named
7 findings; findings 1≡5, 2≡6, 3≡7 are three distinct defects, plus finding 4 on
the round-1 evidence file. Tier: **standard** (fix round on an existing PR).

Base: merge-base with `origin/develop` is `d843566`; this round is a continuation
of the PR branch `fix-253-activity-keys`, not a restart from `develop`.

## Failing-first (red before, green after)

Every fix has a named assertion that failed on the unfixed tree at `1ddaf227` and
passes at `25ff75a`. The red runs were taken on this worktree before the
production edits.

| # | Finding | Red run: assertion + received | Green |
|---|---|---|---|
| 1/5 | `ITEM_CREATED_WITH_STOCK` unlinked | `apps/web`: `activity reference links > links an item row to its history` — `expect(activityRefLink({summary:"ITEM_CREATED_WITH_STOCK 12 بطارية",ref:"1111aaaa-2222"})).toEqual({to:"/items/$itemId/history",params:{itemId:"1111aaaa-2222"}})` received `null` | pass (54/54 in `activity.test.tsx` + `log-copy.test.ts`) |
| 2/6 | `VAULT_RECOVERY_UNLOCKED` raw badge | `apps/api`: `api log events match the shared vocabulary (#253) > emits no log event outside logEvents` — `expect(offenders).toEqual([])` received `["VAULT_RECOVERY_UNLOCKED (src/lib\vault\manager.ts)"]` | pass (3/3) |
| 3/7 | `VAULT_SETUP_RESUME_FAILED` raw summary | `apps/web`: `activity summary tokens render translated copy > renders "VAULT_SETUP_RESUME_FAILED 2026-10-16T09:00:00" without leaking its tag` — `expect(rendered).not.toContain(tag)` received `"VAULT_SETUP_RESUME_FAILED 2026-10-16T09:00:00"` | pass |
| 4 | evidence overstates the guard | see the separate-scan ablation below | `2d91024-evidence.md` row C split into C1/C2 |

Red command (captured before the fix):

```bash
# apps/web
bun test src/pages/activity.test.tsx          # 48 pass / 2 fail
# apps/api
bun test src/lib/log-events.test.ts           # 2 pass / 1 fail
```

Red for finding 2 required the scan pattern to exist first: `EMIT_SITES` in
`apps/api/src/lib/log-events.test.ts` matched `logger.*` and
`recordFailure("CODE")` only. `finishUnlock(…, "VAULT_RECOVERY_UNLOCKED")` passes
the code as a parameter, so the literal was invisible — that is *why* the event
was absent from `logEvents`. The pattern `finishUnlock\([^)]*?"([A-Z][A-Z0-9_]*)"\)`
was added and observed failing on the unfixed `logEvents` before the contract
entry was added.

## Finding 4 — the two scans are independent (separate mutations, separate results)

Round 1 claimed one mutation (`summary: \`ABLATION_TAG payload\``) reddened both
the activity scan and the log-event scan. It does not: the log-event `EMIT_SITES`
patterns match `logger.info("CODE"` and `recordFailure("CODE")` / `rotateSession("CODE")`,
never `summary:`, so that mutation produced **1 activity match and 0 log-event
matches**. Re-run as two mutations, each against its own scan:

| Mutation (file under `apps/api/src`, removed after) | Activity scan `emits no tag outside activitySummaryTags` | Log-event scan `emits no log event outside logEvents` |
|---|---|---|
| **C1** `export const probe = { summary: \`ABLATION_TAG payload\` };` | **FAIL** (`ABLATION_TAG`) | pass — 0 log-event matches |
| **C2** `logger.info("ABLATION_LOG_TAG", "probe")` | pass | **FAIL** (`ABLATION_LOG_TAG`) |
| restored (no probe file) | pass | pass |

Command (both scans, each mutation):

```bash
cd apps/api
printf 'export const probe = { summary: `ABLATION_TAG payload` };\n' > src/__ablation_probe.ts
bun test src/rpc/activity-tags.test.ts src/lib/log-events.test.ts   # 4 pass / 1 fail
rm src/__ablation_probe.ts
printf 'export function probe(logger: { info: (e: string, m: string) => void }) { logger.info("ABLATION_LOG_TAG", "probe"); }\n' > src/__ablation_probe.ts
bun test src/rpc/activity-tags.test.ts src/lib/log-events.test.ts   # 4 pass / 1 fail
rm src/__ablation_probe.ts
bun test src/rpc/activity-tags.test.ts src/lib/log-events.test.ts   # 5 pass / 0 fail
```

`2d91024-evidence.md` row C is corrected to record C1/C2 separately and to drop
the claimed log-event protection that C1 never exercised.

## Gates (this HEAD, 25ff75a)

| Gate | Command | Result |
|---|---|---|
| Typecheck | `bun run typecheck` | 4 successful / 4 total, exit 0 |
| Lint | `bun run lint` | exit 0 (oxlint clean; pre-commit also ran `skills:check`) |
| Web unit (covering set) | `bun test src/lib/i18n.test.ts src/lib/log-copy.test.ts src/pages/activity.test.tsx src/pages/activity-empty.test.tsx src/pages/diagnostics.test.tsx src/pages/history-empty.test.tsx` (apps/web) | **85 pass / 0 fail**, exit 0 |
| API unit (covering set) | `bun test src/lib/log-events.test.ts src/rpc/activity-tags.test.ts` (apps/api) | **5 pass / 0 fail**, exit 0 |
| Full unit (`bun run test`) | — | **NOT RUN — harness guard.** See below. |
| E2E | — | not run (no visible surface changed; parent owns it) |

### The full-suite gate was blocked by the harness heavy-run guard, not by this change

`bun run test` (and bare `bun test`, and `bun test ./src`) is refused with:

```
Blocked: this is a HEAVY run (full suite / e2e) and no slot is free.
/bin/bash: D:projectsmani-project.scratchscriptse2e-slot.sh: No such file or directory
```

The guard's slot-script path is mangled (Windows backslashes stripped:
`D:projectsmani-project...` instead of `D:/projects/mani-project/...`), so it can
never detect a free slot. A real slot **was** taken with the actual script
(`e2e-slot.sh acquire fix-253-activity-keys-round2 --no-wait` → `PORT_SLOT=slot2`)
and the run was retried once, as the guard instructs; it stayed blocked. The
covering set above is the narrowed run the guard permits. Full suite + e2e are
left to the parent.

## Decisions

- **`VAULT_SETUP_RESUME_FAILED` stays an activity tag only, not a `logEvents`
  member.** Its `recordFailureInternal` path logs `VAULT_ATTEMPT_FAILED` to the
  JSONL and stores the specific code in `pendingEvents`, so it never appears as a
  diagnostics event code. Adding it to `logEvents` would claim a JSONL vocabulary
  the api never writes.
- **The `finishUnlock` scan pattern is the root-cause fix for finding 2.** Adding
  the event alone would leave the next parameter-passed log code invisible again.
- **No e2e for this round.** The three defects are pure copy/link mapping in unit
  surfaces; the round-1 visual evidence (`.scratch/reviews/253/before-*` /
  `after-*`) still describes those surfaces. The new tag/link branches are covered
  by the enumeration tests that assert the raw token never survives.
