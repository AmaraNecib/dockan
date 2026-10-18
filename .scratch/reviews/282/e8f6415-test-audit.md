# #282 — test-audit lens, head `e8f6415`

Base `origin/fix-275-vault-lock-liveness` (stack under: `7ad9627` guard, `3efdd42`
onLost wiring, `cd22773` hook hardening + holder threading). Worktree
`D:/worktrees/mani-project/t3-f09e6466`, read-only: every ablation was a
temporary source edit, reverted with `git checkout` immediately after its run;
the tree is clean (`git status` shows only the pre-existing `.scratch/`
untracked files). No test file, no lock-module file, no other source file
touched. No commit, no push.

## What I ran

`bun test src/lib/vault/backup.test.ts` from `apps/api` — the focused file, once
per condition, never the suite. Baseline 11 pass / 0 fail, **1.47 s** wall; each
ablation run 1.3–3 s. Eight ablations plus greps total ~10 minutes. The one run
that exits the process (ablation G) kills the bun runner mid-file, which is
itself the result — no summary line prints.

## The eight ablations

| # | Mutation (where) | Tests that go red | Tests that stay green and why that matters |
| --- | --- | --- | --- |
| A | Guard removed entirely (`backup.ts:110–146`) | T1 (refusal), T2 (quiet-hotter refusal), T6 (theft), T7 (throwing hook) | **T3, T4, T5 pass vacuously** — see finding F2 |
| B | All three `assertHeld` call sites no-op'd (`backup.ts:136,138,142`) | T6, T7 | T1–T5 still green: acquisition, refusal, reclaim and release are all pinned independently of the ownership re-checks |
| C | Only the **post-pair** check removed (`backup.ts:142`) | **none — 11 pass** | untested decision, finding F3 |
| D | Only the **pre-header** check removed (`backup.ts:138`) | T6 | the theft is caught by the post-pair check, so no single in-window check is individually required |
| E | `try/catch` swallow dropped from the hook wrapper (`backup.ts:115–123`) | T7 | T6 green — the throw only reaches the caller when the caller's own hook throws |
| F | `holder` not forwarded at the call site (`backup.ts:116` → `options.onLockLost?.(reason)`) | **none — 11 pass** | the `cd22773` F2 fix is unpinned, finding F4 |
| G | Always-present handler dropped (`backup.ts:110` → bare `acquireVaultLock(dataDir)`) | **the runner exits during T6** — `lock.ts:261–262` runs `handler(reason, holder); else process.exit(1)`, no summary prints, T7 never runs | confirms the debate report's structural claim empirically |
| H | decode moved after `acquireVaultLock` | **none — 11 pass** | the comment at `backup.test.ts:273–274` ("decode runs before the lock is taken") is not pinned by T5's garbage branch, finding F5 |

### The red list in detail

Test names as written, all in `describe("vault backup restore takes the data
folder's lock")` (`backup.test.ts:214`):

- T1 `refuses while another instance holds the folder, and writes nothing`
  (`:215–227`) — red under A only. Pins the decision (`VaultAlreadyLockedError`,
  `:221`) **and** the end state (`dokan.db.enc` and `vault/` absent, `:225–226`).
- T2 `refuses a live holder whose heartbeat is stale` (`:229–237`) — red under A
  only. Decision-pinning via error type at `:236`; no write-side end state
  asserted (nothing to check beyond refusal — acceptable).
- T3 `restores over a dead holder's stale lock` (`:239–250`) — green under A
  (vacuous: with no guard, the restore succeeds without ever reading the
  record). End state only (`:248–249`); the liveness *distinction* is carried by
  the T2/T3 pair, not by either alone.
- T4 `releases the folder lock` (`:252–261`) — green under A vacuously:
  `existsSync(vault.lock)` is trivially false when no lock is ever taken.
  Under B (guard acquired, checks disabled) it stays green legitimately —
  release-on-success is pinned by `:257` and by the `acquireVaultLock` at
  `:259–260` succeeding.
- T5 `releases the folder lock when a write fails` (`:263–277`) — green under A
  vacuously for the same reason; its failure-path release pair (`:269`, `:270–271`)
  only means anything while a lock exists.
- T6 `fails the restore with an error, never a process exit, when the lock is
  stolen mid-restore` (`:279–289`) — red under A, B; pins decision
  (`VaultLockLostError` `:283`, one loss `:284–285`) and end state (`:287–288`).
- T7 `still fails with VaultLockLostError when the caller's onLockLost handler
  throws` (`:291–307`) — red under A, B, E. Pins the swallow decision through
  `hookRan` (`:303`) — unless mutated red, though; see finding F5.

## Which assertions could not fail

The mutations a reviewer would actually suspect, and what the file answers:

1. **`holder` forwarding is unfalsifiable (F4, severity 3).** Dropping the
   second argument at the only call site (`backup.ts:116`) keeps all 36
   assertions green. The helper formats `"… (taken by ${holder.host} pid
   ${holder.pid})"` (`backup.test.ts:197`) but nothing asserts the suffix;
   T6 only checks `losses[0]` against `/lock/i` (`:285`), which the bare reason
   still matches. Fix: one line — `expect(losses[0]).toContain("pid ")` in T6.
2. **The post-pair `assertHeld` is unfalsifiable (F3, severity 4).** Removing
   it (`:142`) leaves 11 pass: the helper steals at the *snapshot* rename
   (`backup.test.ts:188`, `String(to).endsWith("dokan.db.enc")`), so the theft
   always lands before the pre-header check and `:142` never decides anything.
   The decision "a theft between the header write and the return is still a
   failed restore" (comment `backup.ts:140–141`) has no test. Fix: steal at the
   header rename in one extra case, or make the existing spy steal at
   `.endsWith("vault.json")` in a variant of T6.
3. **decode-before-lock cannot fail as an end state (F5, severity 2).** Moving
   `readVaultBackupBundle` inside the `try` keeps every assertion identical:
   garbage still rejects, and the `finally` (`backup.ts:144–146`) erases the
   only trace the transient lock leaves. The comment at `backup.test.ts:273`
   states the property; no assertion observes it. Fix: `spyOn` acquire or assert
   the lock file is never momentarily present — e.g. a second `fs.existsSync`
   probe inside a `fs.writeFileSync` passthrough is overkill; a `spyOn(backup
   module, "acquireVaultLock")`-style expectation on call count is the cheap
   one.
4. **`expect(stolen).toBe(true)` (`:282`) never fails under guard mutations** —
   it is a harness-sanity check on the spy, not a property of the code. Fine to
   keep; just not a defence of anything.

## Which test pins the decision vs the end state

- **Decision-pinning tests** (assert the *behaviour*, not the debris): T1 and
  T2 (error type, `:221` / `:236`), T6 and T7 (`VaultLockLostError`, `:283` /
  `:305`, plus the message-purity check `:306`).
- **End-state-pinning tests**: T1 (nothing written, `:225–226`), T4 and T5
  (lock released, `:257` / `:269` + `:270–271`), T6 (header absent, thief's
  record intact, `:287–288`).
- **Pairs, not single tests**, carry the two judgement calls: the
  live-vs-stale liveness distinction is T2 vs T3, and the release-on-success vs
  release-on-failure pair is T4 vs T5. Either alone could be green under a
  coarser guard.
- T4+T5's `acquireVaultLock(target)` immediately after (`:259–260`, `:270–271`)
  is the stronger half of each release claim: a leftover record that survived a
  buggy release would make the *next* boot fail, and the test does simulate
  that next boot.

## Findings ranked

| # | Severity | Finding | Fix |
| --- | --- | --- | --- |
| F3 | 4 — untested decision | Post-pair `assertHeld` (`backup.ts:142`) has no red under any current ablation; nothing steals between the header write and the return | Steal at the header rename in the helper (`backup.test.ts:188`) or add a variant |
| F4 | 3 — unpinned fix | `holder` forwarding (`cd22773` round-2 F2) goes green when dropped (`backup.ts:116`) | `expect(losses[0]).toContain("pid ")` in T6 after `:285` |
| F2 | 2 — vacuity risk, documented | Under guard removal T3–T5 pass vacuously (`backup.ts:110–146` deleted); the describe-block note at `backup.test.ts:209–213` ("the refusal test then restores successfully") under-counts — three tests stop defending by staying green, not by failing | Mark these in a comment so a future editor does not read "green" as "safe" |
| F5 | 2 — comment without a test | decode-before-lock (`backup.ts:107–109`, comment `backup.test.ts:273`) is invisible to the file's own assertions | Spy on acquire for the garbage case |
| F1 | —, no action | Removal of the whole guard fails 4/7 tests (T1, T2, T6, T7), and dropping the always-present handler kills the runner (`lock.ts:261–262` via ablation G) — the acceptance criterion "a test asserts it refuses when a lock is held by another instance" (issue #282) is met, twice | none |

## Verdict

**VERDICT: FINDINGS (3 actionable: F3, F4, F5) — no blocker.** The two
 behaviours the issue's acceptance criteria name are genuinely pinned (refusal
 under a live holder, error not process-exit on a mid-restore loss), the theft
 window before the header write is pinned by error type and end state, and the
 hook's swallowing contract is pinned by a test that can die under the exact
 mutation it defends against (ablation E red, ablation G runner-exit). The gaps
 are all of the same kind: properties asserted only by comments (post-pair
 check, decode-before-lock) or by a side of a formatted string the assertion
 never reads (`holder`). Two of these are one-line test additions.
