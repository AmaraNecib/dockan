## Problem Statement

The shop owner's Dokan stopped opening their own data. The desktop window said the server was not running (`تعذّر الاتصال بالخادم. تأكد من تشغيله ثم أعد المحاولة.`) with a retry button, and the retry never worked. The server *was* running: it was refusing because the data folder looked open in another copy of Dokan. The "other copy" was a sidecar process that had died hours earlier. Every later start refused the same way, and the only way back was deleting the lock file by hand — something no shop owner can be expected to find.

## Solution

Dokan reclaims a data folder whose owner is provably gone, and when it genuinely cannot open the folder it says so in the owner's own words: **"the data folder is in use"**, naming the other copy, instead of blaming a server that is answering requests. A refused start heals itself as soon as the other copy closes, with no restart and no file editing.

Concretely, for the owner:

1. A crashed Dokan no longer strands the next start. Reopen, and the folder opens.
2. When another copy really does hold the folder, the screen says which copy and what to do, using the same words as the log.
3. The retry button retries something that can succeed: while another copy holds the folder, the app keeps trying and lets the owner in the moment it is released.
4. Two copies still never write the same data.

## User Stories

1. As the shop owner, I want Dokan to open my data after it crashed, so that a crash costs me a restart and not a day of selling.
2. As the shop owner, I want to be told when my data folder is open in another copy of Dokan, so that I close the right thing instead of hunting for a server that is already running.
3. As the shop owner, I want that message to name the other copy (its machine and its process), so that I can tell which window to close when several are open.
4. As the shop owner, I want the retry button to have a real chance of succeeding, so that retrying is not a dead end.
5. As the shop owner, I want Dokan to let me in by itself once the other copy is closed, so that I do not have to restart the app or delete files.
6. As the shop owner, I want the app never to claim the server is down when it is answering my requests, so that I trust what the app tells me.
7. As the shop owner, I want a genuinely unreachable server to keep saying exactly that, so that the honest message does not get watered down.
8. As the shop owner, I want two copies of Dokan to never write the same data, so that my balances stay correct and my backup stays restorable.
9. As the shop owner, I want Dokan to stop writing the instant it loses the folder, so that a slow machine or a sleeping laptop never causes a second writer.
10. As the shop owner, I want the app to tell me (not just the log) when it stopped because it lost exclusivity, so that a silent exit does not look like a crash.
11. As the shop owner running the portable copy from a USB stick, I want a folder left locked by a machine that was unplugged to be recoverable, so that moving the stick between machines does not need hand-editing files.
12. As the shop owner whose laptop hibernates mid-day, I want the resumed app to behave safely around the folder's single-writer rule, so that waking up never puts two writers on my data.
13. As the person supporting this install, I want every refusal and every reclaim recorded in the log with the holder's machine and process, so that a stuck install can be diagnosed from the log alone.
14. As the person supporting an install stuck on the current build, I want a documented one-step manual recovery, so that a user who cannot start the app is not stranded until they update.
15. As the shop owner, I want the app's words and the log's words to name the same thing, so that a support conversation and the app agree.

## Implementation Decisions

- **Liveness rule for the lock on the data folder.** The pid probe proves liveness only when it does not throw. A definitively gone pid is reclaimed. An inconclusive probe (EPERM, which on Windows covers a pid that no longer runs) defers to the recorded heartbeat against the existing staleness window. A definitively alive pid still wins over an old heartbeat — the round-5 rule is preserved, and only the unknowable case changes. See ADR-0012.
- **One helper decides pid liveness**, shared by the vault lock and the port record's check that a recorded pid is still alive. Two copies of this rule is how the bug survived.
- **One injectable probe on the lock's existing options object**, so tests can force the inconclusive outcome; the lock already takes its timing knobs that way.
- **A holder that loses the lock switches to refusing, on the port it already owns.** It never opens a second listener and never publishes the port record. Today the caller exits, which leaves the desktop shell's broker with nothing to talk to and drives the web to the wrong message.
- **The refusal carries a machine-readable code on the route the app actually calls.** The JSON status route answers `503` with `VAULT_LOCKED_BY_OTHER_INSTANCE`, matching what `/health` already answers. The web must not parse the refusal's HTML page.
- **The web gains a distinct failure for that code** instead of collapsing every non-OK response into `VAULT_UNREACHABLE`, and renders the refusal through the existing translated copy for `VAULT_LOCKED_BY_OTHER_INSTANCE`, on a screen that also offers retry. The contract already lists this code and the i18n test already requires a key for every code; nothing new needs inventing.
- **The refused instance retries the reclaim with bounded backoff** while it serves the refusal, so a released folder is taken without an app restart. It writes nothing to the folder while refused, and it never overwrites the owner's port record.
- **The lock record's shape does not change.** The holder identity it already writes (pid, host, start time, heartbeat, token) is enough for all three clauses.
- **Glossary.** `CONTEXT.md` gains **Data folder** (مجلد البيانات) and **In use** (قيد الاستعمال), with their `_Avoid_` lists, because the owner-facing language for this situation did not exist and the refusal page was already using it without a definition.
- **Landing order.** The lock-liveness ticket lands first, since it changes the refusal path the other two touch; the other two rebase onto it. The other two are independent of each other.

## Testing Decisions

Good tests here exercise external behaviour: which boot wins the folder, what the owner's screen says, and what a second process can do. They must not assert on internals (timer arming, private fields, the shape of the reclaim temp file).

Seams, highest first, all of which already exist:

- **The vault lock module's unit tests.** They already cover the live-holder refusal, a dead-holder reclaim, a stale foreign heartbeat, and a lock replaced mid-life. Add the inconclusive-probe cases through the options seam: an inconclusive probe with a stale heartbeat is reclaimed; an inconclusive probe with a fresh heartbeat is refused; a definitively alive holder with a stale heartbeat is still refused. Prior art for the shape: the existing dead-pid test and the existing foreign-heartbeat test.
- **The port record's unit tests** for the shared liveness helper, so the second site cannot drift back.
- **The lock integration test that already spawns a real second instance** of the api and waits for the refusal. Extend it to assert the JSON status route answers the refusal code with 503, and that the refused instance takes the folder once the holder is killed, without a restart.
- **The web vault client's unit tests.** They already distinguish a legacy build (404) from an unreachable server; add the refusal code answering 503, and keep the unreachable case covered so the honest message does not regress.
- **The app session-gate component test** for the refusal screen: the in-use copy appears, the server-down copy does not, and retry is offered.
- **The i18n test** that requires a key for every contract code already enforces the vocabulary; it should stay green without a new code.

## Out of Scope

- The plaintext/legacy build path and its login screen.
- The desktop shell's spawn, respawn, freshness and identity-probe logic. Its behaviour is the input to this work, not part of it.
- The lock file's name, location or on-disk shape.
- The genuinely unreachable case (no server at all) and its existing copy.
- The wording of every other vault failure; only the two that this situation produces change.
- Warning a user on an older build before they hit this. They cannot be reached by the app that is refusing.

## Further Notes

- **A patch release ships with the first ticket, plus a documented manual recovery** (the lock file in the data folder) for anyone still on the current build, since those installs cannot be repaired from inside. Cutting the release is the owner's call and stays open until the lock fix has landed.
- **Evidence that started this:** the log of a real install showing `VAULT_LOCK_REFUSED` ("port record untouched: another instance owns the folder") on every retry, beside a lock record whose pid was absent from the OS process list while the probe still reported `EPERM`.
- **Recorded decision:** ADR-0012, on the liveness rule and the fail-stop that makes reclaiming from a frozen holder safe.
