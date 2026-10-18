# #282 — code-review lens, head `e586a03`

Reviewer model: zen-proxy/glm-5.3-flash-free
Author model:   zen-proxy/deepseek-v4.1-flash-free

This run replaces the `e8f6415-code-review.md` report, which named itself with
the author's model. Every finding below was checked against the tree at
`e586a03` in this worktree; nothing is carried over on the previous report's
say-so. Re-run of the focused suite, read-only: `bun test
src/lib/vault/backup.test.ts` from `apps/api` — 11 pass, 0 fail, 36 expect()
calls, ~2 s. No file edited except this report; no commit, no push, no GitHub
call.

Base `origin/develop`. Diff scope: `apps/api/src/lib/vault/backup.ts`
(+87/−9) and `apps/api/src/lib/vault/backup.test.ts` (+157/−2) — exactly the
two files, +244/−11 total. The branch carries the guard chain
(`18253ea` guard, `d4650f8` fail-restore-not-exit, `c00ea5b` hook fail-stop
removal, `2833d94` pin the hook fires, `cb27f64` ownership before the first
write) rebased onto the now-merged #279 line, plus `e586a03` (this and the
other lens reports). The `e8f6415` the neighbouring lens reports name is the
same tree as `2833d94` (backup files byte-identical), so their findings map
onto this head; `cb27f64` is the only code delta since.

## Scores

**Spec 9/10. Standards 9/10.** The guard is in the right place, throws the
lock module's own errors, and is held up by tests that fail without it. The
points off: three test-coverage gaps of the kind the test-audit lens measured
(no red under a targeted mutation), one doc over-claim, one formatting glitch.

## Spec — against issue #282

Both acceptance branches are satisfied by code, not just prose:

- The guard: `backup.ts:105` `acquireVaultLock(dataDir, {…})` inside
  `extractVaultBackup`; both `writeFileAtomic` calls (`backup.ts:144`,
  `:147`) sit in the `try` whose `finally` at `:152-154` releases the lock —
  the lock never outlives the function.
- Check-before/check-after: `lock.assertHeld()` at `backup.ts:142` (before
  the first write), `:145` (before the header), `:149` (after the pair). Same
  cadence as the live write path (`encrypted-connection.ts:216` guard, write,
  `:230` guard again, comment `:228-229` "a theft during the write is never
  mistaken for saved data").
- Refusal and release are the ablation-pinned part: with the guard removed,
  T1/T2/T6/T7 go red (measured by the test-audit's ablation A at
  `e8f6415`, and the tests are unchanged since). The refusal test asserts
  both the error type (`VaultAlreadyLockedError`, `backup.test.ts:221`) and
  the empty-folder end state (`:225-226`).
- Claims about the lock module re-verified at this head (the vault tree other
  than these two files is identical to `origin/develop`): `lock.ts:400`
  throws `VaultAlreadyLockedError` for a live holder; `holderIsLive`
  (`lock.ts:170-177`) returns alive on the same host for a live pid regardless
  of heartbeat, so the same process and the quiet-holder case both refuse;
  `lost()` (`lock.ts:258-268`) releases before calling the handler and only
  fail-stops (`process.exit(1)`) when no handler was supplied — which is why
  the always-present wrapper at `backup.ts:113-126` exists.

Errors stay in the existing taxonomy: the diff touches no `VaultErrorCode`,
nothing under `packages/`, and adds no caller — `extractVaultBackup` still
has zero production call sites.

## What changed since the previous code-review run

`cb27f64` fixes three of the debate's four findings, in code the earlier
report had left open:

- The doc no longer says a loss "stops the writes"
  (`backup.ts:90-96`): it now states the check-before/check-after cadence,
  that a write already in flight cannot be interrupted, and what the theft
  test pins. Matches the mechanism.
- `fs.mkdirSync(vaultDir, …)` moved below the first `assertHeld`
  (`backup.ts:142-143`) — every folder write but the lock file itself now sits
  under a checked ownership state, and the sequence has no await between
  check and mkdir.
- The `onLockLost` block now states the hook runs post-release and must not
  write the folder (`backup.ts:117-118`).

## Findings, ordered by severity

**F1 — 2 — the post-pair `assertHeld()` (`backup.ts:149`) has no test that
can fail.** The theft helper singles out the snapshot rename
(`backup.test.ts:188`, `endsWith("dokan.db.enc")`), so the theft always lands
before the pre-header check and the `:149` check never decides anything:
removing it leaves all 11 tests green (the test-audit's ablation C at
`e8f6415`). The theft test still pins the class of decision it was written
for — a theft mid-restore fails the restore — but a theft between the header
write and the return is today covered only by a comment
(`backup.ts:148-149`), not by an assertion. One-line fix in the test file:
a variant that steals at the `vault.json` rename.

**F2 — 2 — `holder` forwarding (`backup.ts:121`) is not pinned.** Dropping
the second forward argument leaves 36 green assertions: T6 checks only
`losses[0]).toMatch(/lock/i)` (`backup.test.ts:285`), and the helper's
"(taken by … pid …)" suffix (`:197`) is never asserted. Fix: append
`expect(losses[0]).toContain("pid ")` in T6.

**F3 — 2 — decode-before-lock is asserted by comment, not by observation.**
`backup.ts:112-113` claims garbage input never takes the folder; the garbage
test (`backup.test.ts:276-279`) asserts `vault.lock` is absent afterwards —
but the `finally` release erases that trace, so moving the decode inside the
lock still passes all 11 (test-audit ablation H). Fix: spy on the acquire and
assert it is not called for garbage, or leave the comment to carry the claim
alone. Recorded, not a defect today.

Both F1 and F3 are kept open here against a head that closed the debate's
code findings, so the PR's remaining risk lives entirely in the test file,
not in `backup.ts`.

**F4 — 1, carried, unchanged — the doc opens with "Restore is an OFFLINE
write" (`backup.ts:79`), but offline-ness is the caller's decision and the
function cannot observe it.** What the function enforces is exclusivity at
the instant of the writes, and the following sentences describe exactly that.
Recorded so a future reader does not quote "OFFLINE" as a code-guaranteed
property.

**F5 — 1 — formatting glitch** at `backup.test.ts:263`: the first statement
sits on the `async () => {` line of the
"releases the folder lock when a write fails…" test. A format pass catches
it. One-line extra observation while chasing numbers: the new comment at
`backup.ts:143` cites "(debate F2)" — the reasoning in the sentence
("creating the directory is itself a write into the folder") stands on its
own, but the citation points at a `.scratch/` report whose life ends with
this PR, worth losing in a later touch-up.

Confirmed fixed by this run (from the prior lens reports): debate F1's doc
wording, F2's unguarded mkdir, F3's missing hook contract — see the section
above; C1/F5 and C2/F4 from the earlier code-review remain open verbatim.
The debate's F4 (a `readOwnerOnce` returning undefined lets `release()`
unlink a record it did not confirm — `lock.ts`) is untouched by this diff and
out of scope for #282; the diff against `origin/develop` covers only the two
backup files, verified by name-only listed diff.

## Unverified findings

None. Everything cited above is line-checked against this worktree's tree,
and the lock-module and encrypted-connection claims were grepped in the same
tree, not taken from the earlier reports.

## Verdict

**VERDICT: FINDINGS — no blocker.** Both acceptance criteria of #282 hold
with ablation-backed tests; the three test gaps (F1-F3) are one-line test
additions of the same kind the test-audit lens already reported, and F4/F5
are a doc sentence and a formatting pass. Nothing here blocks the merge.
