# Design: #283. The lock refusal must not promise another instance that may not exist

## The defect

`holderIsLive` refuses on an alive pid before consulting the heartbeat. When the
recorded pid has been recycled by an unrelated long-lived process,
`VaultAlreadyLockedError` is answered forever while no other Dokan copy exists.
The copy says "close the other copy", the one instruction the operator cannot
follow. ADR-0012's refusal of start-time reclamation (option D) is the deliberate
trade and is not the bug. The bug is the story the refusal tells.

## Review tier

Standard. The diff changes the reason label and the refusal payload only. It never
changes `holderIsLive`'s decision (acceptance criterion 3). No money, auth,
backup/restore or schema-version surface is reachable from it. The vault lock
path would normally hint at a failure mode, and this diff deliberately does not
touch the steal-vs-refuse decision behind it.

## Base SHA

`92c2956` (develop). #276 landed the in-use screen and owns the same strings, so
this lane rebased onto it before writing a line.

## Shape

One boolean, borrowed from the evidence the verdict already has:

- `holderVerdict` (formerly `holderIsLive`'s body) returns
  `{ live, staleHeartbeatOverAlivePid }`. `live` is byte-identical to the old
  decision. Another host reads the heartbeat, an alive pid always wins, an
  inconclusive probe defers to the heartbeat. Only the alive-pid case gains a
  second return: is the recorded heartbeat more than three staleness windows
  old? A live Dokan beats every 10s, so three windows of quiet is not a paused
  holder, it is a lock whose pid is now someone else's.
- `VaultAlreadyLockedError` carries the flag. `buildLockRefusalHandler` (the
  running-instance loss) leaves it false. A runtime loss means a real other
  holder took the folder.
- `createVaultLockRefusalApp` adds `staleHeartbeat: true` to the
  `/api/vault/status` error envelope when the flag stands. The envelope and
  `/health` stay unchanged for a genuine holder. No new contract code: the web
  keys the story off the envelope's extra field, so `packages/contracts/**`
  stays out of this diff and its classification unchanged.
- The standalone HTML page gets its own stale copy. Its today hint says "do not
  delete any file", which is exactly the instruction the pid-reuse case must
  not give.
- The web maps `staleHeartbeat` to a new `VaultFailure` value (`"stale-lock"`)
  and a new screen beside `VaultLockedByOtherInstance`, with copy that names
  `vault.lock` and the condition under which deleting it is the exit.

## Files

- `apps/api/src/lib/vault/lock.ts`: verdict, error flag, refusal app, page copy
- `apps/api/src/lib/locale-neutral.test.ts`: allow-list the two new keys
- `apps/api/src/lib/vault/lock.test.ts`: verdict edges, refusal app, page
- `apps/web/src/lib/vault-client.ts`: carry the field through the throw
- `apps/web/src/lib/vault-client.test.ts`: carry-the-field test
- `apps/web/src/components/vault/vault-gate.tsx`: `VaultFailure` and mapping
- `apps/web/src/App.tsx`: the stale screen
- `apps/web/src/lib/i18n.ts`: the new key
- `apps/web/src/App.test.tsx`: the screen pins
- `tests/e2e/vault.spec.ts`: the two-copy case, replayed from the wire body as
  #276's does (written here; the e2e slot is the parent's)

## Planned tests

Every new test gets a mutation proof: revert the guard it claims to hold, run
it, record the red, restore, and confirm the tree is byte-identical.

1. `lock.test.ts`: a live pid with a heartbeat several windows past
   `staleHeartbeatMs` refuses AND flags the suspicion; the same pid with a
   recent heartbeat refuses but does not flag it. Mutation: make
   `heartbeatIsStaleByWindows` answer `false`, and the flag test goes red.
2. `lock.test.ts`: an inconclusive probe and a foreign host never claim a
   recycled pid. Mutation: mislabel the inconclusive branch `true`, red.
3. `lock.test.ts`: an unparseable heartbeat over an alive pid is a recycled
   one. Mutation: treat it as fresh, red.
4. `lock.test.ts`: the refusal app's status route names `staleHeartbeat: true`
   for a suspected pid and omits it otherwise. Mutation: force the app's
   `stale` to `false`, red.
5. `lock.test.ts`: the stale page says the file, the honest page says the
   copy. Mutation: force the page to `ownerTemplate`, red.
6. `vault-client.test.ts`: `fetchVaultStatus` rejects with `staleHeartbeat`
   when the envelope carries it. Mutation: drop the field from the throw, red.
7. `App.test.tsx`: the suspected case renders the new screen and never the
   "close the other copy" one; a normal refusal keeps the copy. Mutation:
   delete the `stale-lock` branch in `RequireSession`, red.
8. e2e: the replayed body with `staleHeartbeat: true` shows the file-naming
   copy (parent runs it).

## Risks

- Copy honesty vs the suspended-holder case: a laptop asleep for ten minutes
  also has a stale heartbeat over an alive pid. Both copies therefore say
  "close the other copy / delete the file **if** no other copy is open", never
  a certainty, and both hints keep "do not modify the store data".
- The field leaks into old web builds. They ignore the envelope field and keep
  #276's copy. The API never gives the new code alone, so nothing regresses.
