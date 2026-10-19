# Code review (lens 3) — PR #290 / issue #283 @ 74a92c9

Reviewer model: glm-5.3-flash-free
Author model: deepseek-v4.1-flash-free

Base: `git merge-base develop 74a92c9` = `b16dfbb`. Diff read with
`git diff develop...74a92c9`. Read-only lens: nothing committed, nothing pushed,
no e2e run.

Scope of the diff: 22 files, +3106/−75, of which the code surface is
`apps/api/src/lib/vault/lock.ts` (+467/−?), `apps/web/src/{App.tsx,vault-client.ts,vault-gate.tsx,i18n.ts}`,
`apps/api/src/lib/locale-neutral.test.ts`, and the three test files. The rest is
`.scratch/` design and earlier reviews.

Measured state at this SHA (commands and counts):

| Command | Result |
|---|---|
| `cd apps/api && bun test src/lib/vault/lock.test.ts src/lib/locale-neutral.test.ts` | 94 pass, 0 fail, 237 `expect()` — `lock.test.ts` alone is 67 pass |
| `cd apps/web && bun test src/App.test.tsx` | 44 pass, 0 fail, 164 `expect()` |
| `cd apps/web && bun test src/lib/vault-client.test.ts` | 14 pass, 0 fail, 31 `expect()` |
| `cd apps/api && bun run typecheck` | clean |
| `cd apps/web && bun run typecheck` | clean |

Every mutation below was applied with the file backed up, run, then restored;
`git status --short` was empty after each restore.

---

## Answers to the five hunt items

**(a) Does the stale-lock branch ever change when the API refuses to open the
folder, because it must not.** No. `holderVerdict` (lock.ts:355-372) returns
`live` computed by the same three branches `holderIsLive` had — foreign host →
heartbeat, `alive` → true, `gone` → false, inconclusive → heartbeat. The new
`heartbeatIsStaleByWindows` call is reachable only inside the `alive` arm and its
result goes only to the second field. Both throw sites (lock.ts:750, 761) keep
`if (verdict.live)` as the condition. `assertHeld`, `heartbeat`, `release`,
`reclaimStaleLock`, `readOwner` and the retry budgets are untouched by the flag.
`buildLockRefusalHandler` (main.ts:148) constructs the error with no third
argument, so the running-instance loss always serves the honest page. Clean.

**(b) New Arabic screen and standalone page: is the lock-file path escaped, can
user data leak into the copy.** No injection path. `escapeHtml` wraps the whole
message and the hint (lock.ts:855-858). The only record data that reaches the
copy is `host` and `pid`: `pid` is `z.number().int().positive()` from the read
schema, and `host` goes through `sanitizeHostForDisplay` (charset-strip + 64-char
cap + `fallbackHost`) *before* the `{host}` substitution, so a hostile record
cannot inject markup or a placeholder. The web screen's copy
(`vaultLockStaleHeartbeat`, i18n.ts:403) is a static string with no
interpolation, so no record data reaches the browser at all. User data does
appear in the standalone page (`الجهاز {host}، العملية {pid}`), which is #276's
existing exposure, unchanged in kind. Findings P3-1 and P3-2 below are about that
asymmetry, not about escaping.

**(c) Future-stamp guard (age below zero): can clock skew refuse a legitimate
unlock.** It cannot add a refusal. `heartbeatIsStaleByWindows` (lock.ts:334-341)
feeds only the story field; `live` was already `true` for an alive pid before
this diff and is `true` after it. A stamp ahead of now yields `age < 0` → `false`
→ honest copy, no extra refusal, no reclaim. Two notes: the guard line at 339 is
redundant (see P3-3, ablation B), and the *mirror* skew (a record written by a
clock that has since stepped backwards) inflates `age` and flips the copy to
"delete `vault.lock`" for a live holder — the same window as P2-2, not a new
refusal.

**(d) Does the app-level catch-all serve the stale page for a non-stale
refusal.** No. `createVaultLockRefusalApp` derives one `stale` constant from
`error.staleHeartbeatOverAlivePid` (lock.ts:906) and uses it for both the status
envelope and `app.all("*")`; the flag is `false` by construction on the
running-instance loss path. Ablation C (drop the flag from the catch-all only)
turns `serves the stale-lock page from the catch-all route` red, 1 fail / 66
pass, so the negative half is genuinely held. Cannot fire the stale page for a
non-stale refusal.

**(e) One ablation per test I doubt.** All five ran. A and B are the two that
surprised me (green where the PR claims red). Details in the findings.

---

## P1

None. The refusal decision is byte-identical to `develop`, the payload change is
additive, and the three lenses' earlier findings on the #281 tail are untouched
by this diff.

## P2

### P2-1 — The post-settle refusal's flag is untested; dropping it keeps 67/67 green
`apps/api/src/lib/vault/lock.ts:759-762` is the *second* `holderVerdict` check,
after `stealSettleMs`. It passes `verdict.staleHeartbeatOverAlivePid` exactly
like the first, but no test reaches it with a stale-heartbeat holder: the new
`#283` tests all throw at the first check (line 750) because the record is
already live. The test that *does* reach the second check
(`abandons a reclaim when the holder looks live again after the settle window`,
lock.test.ts:324) asserts only `toThrow(VaultAlreadyLockedError)`.

Ablation A: replace line 761's three-argument throw with the two-argument form.

```
sed -i 's|new VaultAlreadyLockedError(settled, lockPath, verdict.staleHeartbeatOverAlivePid)|new VaultAlreadyLockedError(settled, lockPath)|' apps/api/src/lib/vault/lock.ts
cd apps/api && bun test src/lib/vault/lock.test.ts
```

Result: **67 pass, 0 fail**. Green with the flag gone.

Impact: a boot that loses the settle race to a holder whose pid looks recycled —
a real reboot loop, since each boot re-enters `acquireVaultLock` — sends the
operator back to "close the other copy", the exact instruction #283 exists to
replace. The lane's own design listed this test (planned test 2 was about the
inconclusive branch, not this one), so the gap is a planning gap, not a
regression.

Falsification test to add: reuse `abandons a reclaim...`'s scripted probe with a
heartbeat 10 minutes old and assert `refusal?.staleHeartbeatOverAlivePid` is
`true` at the second check (assert `probes >= 2` as that test already does, so
the second check is provably the one that threw).

### P2-2 — A suspended holder lands in the "delete `vault.lock`" screen at 3 minutes
`PID_REUSE_HEARTBEAT_WINDOWS = 3` × the default `staleHeartbeatMs` of 60 s =
180 s (lock.ts:328-340). A closed laptop lid or a Windows sleep of four minutes
gives an alive pid plus a heartbeat 181 s old, and the operator is shown
`staleHint` — which instructs deleting the lock file — for a process that is not
recycled, just asleep. The design acknowledges the class and hedges the copy
("إن لم تكن هناك نسخة أخرى مفتوحة"), and the resume path is guarded: every store
write goes through `requireHeldLock` → `assertHeld` → `readHeldLock`, so the
resuming holder fail-stops on `gone` before writing. So this is a copy/UX defect
that could provoke a two-writer window only if some write path bypasses
`writeGuard` (that would be a separate defect, not this diff's).

Ablation for the threshold: mutation of `PID_REUSE_HEARTBEAT_WINDOWS` from 3 to
2 leaves the new test green, because its 2000 ms / 5000 ms pair sits at 2 and 5
windows with `staleHeartbeatMs: 1000` and `2000 > 2000` is false. Mutation to 1
turns it red. So the constant is pinned from one side only.

Falsification test: write a record 179 s old and one 181 s old with
`probePid: () => "alive"` and the default `staleHeartbeatMs`, assert the flag is
`false` then `true`. That pins 3 windows and the 180 s boundary; today only the
`staleHeartbeatMs: 1000` shape is pinned.

## P3

### P3-1 — The two surfaces tell different stories about the same holder
The standalone page names `host` and `pid`; the web screen
(`vaultLockStaleHeartbeat`) names neither, and the JSON envelope carries no
identity field at all. On the desktop shell, which loads the web bundle, the
operator cannot check whether the pid named in `vault.lock` is the one they are
about to delete around. The remedy is an envelope field or dropping the identity
from the standalone page so both read the same; either way the two should agree.
Not a leak — the web copy is stricter.

### P3-2 — Only the honest template has an escaping test
`escapes a hostile lock-record host in the refusal page` (lock.test.ts:573) and
the over-long-host test (588) exercise `ownerTemplate` only. The stale template
shares `sanitizeHostForDisplay` and `escapeHtml`, so the code is safe, but a
future change that interpolated the host into `staleOwnerTemplate` directly would
keep both tests green.

Falsification test: same hostile host, `vaultLockRefusalPageHtml(owner, true)`,
assert no `<script` in the output and `owner.pid` present.

### P3-3 — The future-stamp guard is redundant, and its test does not exercise it
lock.ts:339 (`if (age < 0) return false;`) cannot change the answer: a negative
`age` already fails `age > 3 * staleHeartbeatMs`. Ablation B deletes the line and
runs the suite:

```
sed -i '/if (age < 0) return false;/d' apps/api/src/lib/vault/lock.ts
cd apps/api && bun test src/lib/vault/lock.test.ts
```

Result: **67 pass, 0 fail**. The commit message of 74a92c9 says the test-audit
found "`heartbeatIsStaleByWindows`, whose future-stamp guard no test exercises"
and that this commit fixes it; the test pins the outcome (flag `false` for a
future stamp, and inverting the line to `return true` would indeed go red) but it
still does not exercise the guard line, because the arithmetic already answers
correctly. The line is now documentation, which is fine — the commit message's
claim is what should be corrected, and a comment saying `redundant on purpose`
would stop the next reader from "simplifying" it away in the other direction.

### P3-4 — The `#283` e2e builds its own wire body
`tests/e2e/vault.spec.ts:353` hand-writes
`{error:{code:"VAULT_LOCKED_BY_OTHER_INSTANCE", staleHeartbeat:true}}` because
the state cannot be forced through a live second instance — fair, and the reason
is in the comment. The consequence: the API's flag → envelope → web hop is only
unit-tested (lock.test.ts:1314 for the envelope, App.test.tsx:304 for the screen).
Ablation proof that coverage exists anyway: drop `staleHeartbeat` from
`createVaultLockRefusalApp`'s status body and lock.test.ts:1314 fails while the
e2e stays green; drop it from `fetchVaultStatus`'s throw (ablation D, below) and
`vault-client.test.ts` fails 1/14. Both cuts are covered — nothing to fix, just
recording that the e2e's claim is narrower than it reads.

### P3-5 — Unreachable trailing throw kept for style
lock.ts:769 (`throw new VaultAlreadyLockedError(readOwner(...), lockPath)` after
the `for (;;)`) cannot be reached. Pre-existing, and it correctly does not carry
the flag, but it is now the third refusal site a reader must classify.

---

## Ablation log (all restorations verified with `git status --short` = empty)

| # | Mutation | Test file | Result | Verdict |
|---|---|---|---|---|
| A | drop the flag from the post-settle throw (lock.ts:761) | `apps/api/.../lock.test.ts` | 67 pass / 0 fail | **gap** (P2-1) |
| B | delete `if (age < 0) return false;` (lock.ts:339) | same | 67 pass / 0 fail | **guard unexercised** (P3-3) |
| C | catch-all `vaultLockRefusalPageHtml(error.owner, stale)` → `(error.owner)` | same | 66 pass / **1 fail** | test holds |
| D | `fetchVaultStatus` throw drops `refusal?.staleHeartbeat` | `apps/web/src/lib/vault-client.test.ts` | 13 pass / **1 fail** | test holds |
| E | delete the `stale-lock` branch in `RequireSession` (App.tsx:58) | `apps/web/src/App.test.tsx` | 42 pass / **2 fail** | test holds |

## Verdict

The refusal decision is untouched, the flag is additive on one route only, the
copy is escaped, the catch-all cannot mis-serve, and the web never repaints an
unrelated failure. Two real gaps: the second-pass verdict's flag has no test
(P2-1, one-line fix) and the 3-window threshold's edge is unpinned while a
suspended holder is told to delete a live lock file (P2-2). Neither blocks the
merge on its own; both are cheap to close in a follow-up test commit.

Report path: `.scratch/reviews/283/74a92c9-code-review.md`
