# #275 — debate lens, round 2, head `375788b`

Run by a separate sub-agent on `zen-proxy/glm-5.3-flash-free` (not the author's model).
Read-only: the lens produced findings, it did not edit. Base `origin/develop` `8515174`.
Change under review: `git diff origin/develop...HEAD`, 12 files, +811/-56.

Verdict as returned: **nothing blocks**. Round-1 findings C1–C4 verified fixed in this head.
Three new findings survive, one of them major.

## A — broker `reset`/`unlock` are ungated after lock loss (major, fix now)

`lockLost` gates only four sites (`main.ts:63,75,304,676`), and every one of them protects
`dokan.db.enc`. The stdin broker loop's `reset` and `unlock` branches check nothing.

Reachable sequence: instance loses the folder -> the refusal handler takes over HTTP -> the user
drives a recovery reset through the shell -> `vault.setPassphraseFromRecovery` (`manager.ts:472`) ->
`core.setPassphraseFromMasterKey` -> `writeFileAtomicSync(headerPath)` (`manager.ts:166`). The
loser rewrites `vault/vault.json` with a wrap set the winner has no in-memory counterpart for, so
the winner's next credential change last-writer-wins the header back and strands what the loser
wrote. That is the split-state class this change exists to remove, one level up.

`unlock` after loss has a second half: `bootstrapVault` correctly refuses to install the live app
(`main.ts:304`), then the broker still replies `{ok:true, sessionToken}` — a working session
promised while every HTTP path serves the refusal.

The shell is invited to send exactly that line: the status payload flips `unlocked` to false
(`main.ts:366`) while `state` stays `"unlocked"`, so a shell showing the lock screen reaches the
wrong branch.

The defender's answer — that the webview shows the refusal page so the user cannot reach the
recovery screen — rests on the shell's rendering and on an unspecified reading of
`unlocked:false, state:"unlocked"`. Nothing in the diff pins the broker's behaviour after loss, and
one stdin line is enough. Harm is bounded (a header rewrite plus wrong `ok:true` promises, no
acknowledged-sale loss), but it survives.

Fix: gate the broker loop on `lockLost` and reply a typed refusal code. ~15 minutes plus 2-3 tests
in `broker.test.ts`.

## B — in-flight write can still land after theft (major, already deferred)

`persistNow` calls the guard, then renames (`encrypted-connection.ts:217-230`). A reclaimer that
finishes between the guard's `readOwnerOnce` and the rename lets the loser's older image overwrite
the winner's, and the loser also refuses to advance `persistedVersion` — so the winner is told
version N is durable while disk holds M.

This is ADR-0012's own documented residual and is represented by #280 (envelope fencing, a format
change). Not re-litigated here.

## C — alive-pid-wins strands a restart on pid reuse (minor, deferrable)

`holderIsLive` (`lock.ts:164-171`) returns on `alive` before consulting the heartbeat, so a
recycled pid means every boot answers `VaultAlreadyLockedError` forever, with manual lock deletion
the only exit. Deliberate per ADR-0012 (option D rejects start-time pid-reuse detection), and the
opposite trade is silent two-writer overwrite. Worth tracking, not worth stealing.

Cheap mitigation with zero steal risk: when the probe says alive but the heartbeat is stale by
several windows, say so in the refusal — "if this is not another Dokan instance, delete the lock
file". Today the copy promises "close the other copy" when there may be none.

## D — future-dated `heartbeatAt` reads as fresh (minor, one line)

`heartbeatIsFresh` (`lock.ts:150-154`) computes `Date.now() - heartbeat <= 60_000`. A future
timestamp gives a negative age, which satisfies the test. This branch was previously load-bearing
only cross-host; it is now also the only reclaim path for the same-host `EPERM` case. Clamp with
`age >= 0`. Cheap and safe; deferrable.

## Charges the defender holds (recorded so they are not re-reported)

- Port-record takeover is unchanged: `probe(pid) !== "gone"` yields identical truth values to the
  old `EPERM -> alive` reading for both `EPERM` and `ESRCH` (`port-record.ts:126-128`).
- Round-1 C1: post-write guard refuses to advance `persistedVersion` (`encrypted-connection.ts:226-231`);
  bootstrap aborts before the live app swaps in when loss beats boot (`main.ts:304-309`).
- Round-1 C3: the guard is unconditional in `openVaultStore` (`vault-store.ts:36`) and refuses to
  be a silent no-op (`main.ts:~248-252`).
- Round-1 C4: `lockLost` present on every status, `recoveryKeyCount` zeroed on loss
  (`main.ts:364-384`), broker test pins the field shape.
- The shell's health probe does not kill the refusal server: `wait_for_verified_health` runs only
  at spawn (`desktop.rs:705`), so a later 503 leaves the child alive and the refusal design holds.
