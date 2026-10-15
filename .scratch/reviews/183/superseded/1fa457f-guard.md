# #183 — guard evidence (review-fix round 1)

- **Issue:** #183 — Names-only supplier lookup for the opening-balance conflict check
- **Tier:** Standard
- **Branch:** `feat-183-names-lookup`
- **Base:** `origin/develop` @ `f75721133f25bfe29766266381893520e48d6bb0`
- **Reviewed HEAD:** `1fa457f2e15e4b9a04f932defc3c64083cb2528d`
- **Round delta:** `apps/web/src/pages/supplier-opening-balance.test.tsx` only
  (test-only; production code unchanged)
- **Ports:** Guard 2 on isolated pairs `DOKAN_PORT=4493/DOKAN_WEB_PORT=5293`
  (pre-fix run) and `4497/5297` (final run); diagnostics on `4487/5287`.
  **Avoided 4399/5174** (`vault.spec.ts` hardcodes them) and the shared
  4317/5173 pair other crew lanes use.

## Guard 1 — pre-commit

| Check | Command | Exit |
|---|---|---|
| Typecheck | `bun run typecheck` (turbo, 3 packages) | **0** — 3 successful |
| Lint | `bun run lint` (oxlint) | **0** |
| Tests | `bun run test` (turbo, concurrency 2) | **0** — api 888/0, web **963**/0, desktop 57/0 |
| Rust | not applicable (no `apps/desktop/src-tauri/src/` change) | n/a |
| Focused | `cd apps/web && bun test src/pages/supplier-opening-balance.test.tsx` | **0** — 25 pass / 0 fail |

Web rose from 962 to 963 because of the one added names-read-failure test.

Logs (gitignored): `logs/r1-guard1b-{typecheck,lint,test}.log`.

## Guard 2 — pre-review / pre-push

| Check | Command | Exit |
|---|---|---|
| Typecheck | `bun run typecheck` | **0** |
| Lint | `bun run lint` | **0** |
| Tests | `bun run test` | **0** |
| E2E | `DOKAN_PORT=4497 DOKAN_WEB_PORT=5297 bun run test:e2e` | **0** — **57 passed / 0 failed (5.2m)** |
| Working tree | clean after the evidence commit (only ignored `.dokan-port` churn, restored) | clean |
| Evidence current | `.scratch/reviews/183/1fa457f-*.md` names the reviewed HEAD | valid |

Log: `logs/r1-guard2-e2e-final.log` (57 `ok` lines, `57 passed`).

### E2E contention note (why there was more than one run)

The first full run on `4487/5287` reported 54 passed / 2 failed / 1 did not run:

- `stock-ledger.spec.ts:77` — **passed in isolation** (`logs/r1-guard2-stock-ledger-isolated.log`),
  the documented concurrent-lane/stale-server symptom
  (`.agents/wisdom/2026-10-13-e2e-stale-server-and-checksum-flake.md`).
- `vault.spec.ts:166` — the **hardcoded 4399/5174 collision**. A sibling crew lane
  held 4399/5174 during the run; with the ports freed, `vault.spec.ts` passed
  **3/3 in isolation** (`logs/r1-guard2-vault-isolated2.log`). This is the
  deterministic collision in
  `.agents/wisdom/2026-10-14-e2e-port-collisions-vault-spec.md` and
  `.agents/wisdom/2026-10-15-concurrent-lane-e2e-ports.md`, not a regression.

The final content then ran green in one pass on `4497/5297` (57/57). No shared
port owned by a sibling was killed.

## Mutation verification of the finding

Removed `orpc.suppliersAccountSummaries.queryKey()` from `supplierReadQueryKeys`
(page), ran the unit file, restored the page. **4 fail**, exactly the tests that
assert the account refresh; page restored and clean. Log:
`logs/mutation-final.log`. Details in `1fa457f-test-audit.md`.

## PR #190 status re-check (end of round)

`git fetch origin develop` → `origin/develop` is still
`f75721133f25bfe29766266381893520e48d6bb0`. `gh pr view 190` →
`{"number":190,"state":"OPEN","mergedAt":null,"mergeCommit":null}`, branch
`feat-184-server-name-resolution` @ `c25b66a`. **PR #190 has NOT landed.** It
edits the same files (`rpc/router.ts`, `packages/contracts/src/{core,app-contract}.ts`,
`supplier-opening-balance.tsx`) and lands first per the write-path rule, so this
branch still needs a **further rebase onto the post-#190 `develop`** after it
merges. That rebase is out of scope for this round and was not pre-empted.

## Raw logs

Local, gitignored (`logs/` is in `.gitignore`) — not committed:

- `logs/r1-guard1b-{typecheck,lint,test}.log` — Guard 1
- `logs/r1-guard2-e2e-run2.log` — first green full run (`4493/5293`)
- `logs/r1-guard2-e2e-final.log` — final green full run (`4497/5297`)
- `logs/r1-guard2-{stock-ledger,vault}-isolated*.log` — isolation evidence
- `logs/mutation-account-refresh-removed.log`, `logs/mutation-final.log` — mutation

## Greptile re-review (Guard 3) — blocked on auth

`greptile` is installed at `/c/nvm4w/nodejs/greptile`, but `greptile whoami`
returns `error: refresh failed: access_denied`. A local
`greptile review --json --branch develop` therefore cannot run this round; the
fix needs an interactive `greptile login`, which this lane cannot perform.

The Greptile finding was addressed and mutation-verified instead, and the
independent **test-audit** answers the same question ("would this still pass if
the account refresh were broken?") with a mutation proof. The parent can
trigger the hosted re-review on push. **This is the one open Guard-3 item.**

## Not done (authority boundary)

No push, no PR update, no merge, no remote writes. The parent owns landing.
