# Test audit — PR #300, issue #292 (`fence-heartbeat.test.ts`)

**Base** `5941770` · **Head** `b85e435ca8d28109dc750dd1c2d7ff6c6df1d453` · **Subject under audit** `apps/api/src/lib/vault/fence-heartbeat.test.ts` (new, 5 tests, 249 lines)

**Verdict: the suite is green against seven implementations that break the promise.** The implementation is correct; the tests do not hold it. Nine of the diff's changed lines can be deleted with every test still passing — including the production wiring that *is* the feature.

Method: three agents (edge-case hunter, coverage analyst, quality reviewer) in parallel, plus my own line-by-line trace of every changed hunk. The coverage analyst **executed** the ablations in a throwaway tree at `/tmp/pr292-audit-1633` (repo untouched); my independent trace agrees with every measured result. Baseline 5 pass / 0 fail. `encrypted-connection.test.ts` (29 pass) and `lock.test.ts` (34 pass) show no regression from the diff.

---

## 1. Does each test fail if its fix is reverted?

The parent's question, answered with the measured ablation of each candidate revert.

| Revert (one line, file otherwise pristine) | pass / fail | Caught by | Verdict |
|---|---|---|---|
| `lock.ts:281` — delete `this.runHeartbeatChecks();` | 2 / 3 | T1, T2, T5 | ✅ pinned |
| `encrypted-connection.ts:478` — delete `recordDiskStamp("write")` in `persistNow` | 4 / 1 | **T4** | ✅ pinned |
| `encrypted-connection.ts:462` — delete `noteDiskStamp(fence.stamp, "heartbeat")` | 3 / 2 | T1, T2 | ✅ pinned |
| `encrypted-connection.ts:344-345` — drop the change detection | 3 / 2 | T2, T3 | ✅ pinned |
| `encrypted-connection.ts:551` — delete `recordDiskStamp("write")` in `checkpoint` | **5 / 0** | none | ❌ **unpinned** |
| `encrypted-connection.ts:409` — delete `noteDiskStamp(fence.stamp, "write")` in `diskFenceIsMine` | **5 / 0** | none | ❌ **unpinned** |
| `main.ts:262` — delete `vaultLock?.addHeartbeatCheck(() => conn.recheckFence())` | **5 / 0** | none | ❌ **unpinned** |
| `encrypted-connection.ts:463` — delete `fenceSatisfied = fence.stamp === connectionStamp` | **5 / 0** | none | ❌ **unpinned** |
| heartbeat runs the checks only every 50th tick | 4 / 1 | T5 only | ❌ T1, T2 still pass |

Direct answers to the four questions asked:

- **Real idle-then-rename sequence?** Yes. T1 builds it faithfully: real `acquireVaultLock`, real heartbeat timer, real `renameSync` over the real `dokan.db.enc`, no persist / checkpoint / close in between (`fence-heartbeat.test.ts:98-102`). Nothing is faked except the connection.
- **A BOUND (within one heartbeat)?** **No.** `waitFor` gives up at 2 000 ms against a 20 ms tick — **100 ticks of slack**. A check that fires every 50th tick still passes T1 and T2. The test *name* promises a bound the assertion does not measure. The design note admits it (`292-design.md:117`, "a hundred ticks of slack over a bound the issue states as one") and then treats the slack as a feature.
- **The report-once rule?** Partly. Same-site repeat is pinned (T2, ablation H). The **dedupe reset** — the doc's own promise at `encrypted-connection.ts:341`, "a repair (our own stamp back on disk) resets it, so the next theft is named again" — is not tested: no test performs a second theft after a repair. A `noteDiskStamp` that remembers the last *reported* stamp rather than the last *observed* stamp would silence every theft after the first, and all 5 tests stay green.
- **The write-path ordering?** Only one half. T4 pins `persistNow`'s ordering (`encrypted-connection.ts:478`) and is the strongest test in the file. T3 does **not** pin `checkpoint`'s ordering — its event comes from `diskFenceIsMine` (`encrypted-connection.ts:409`), because T3's version is *clean*, so `snapshotIsCurrent()` reaches the disk read before `checkpoint` gets to its own early read. A dirty checkpoint is the untested case, and it is the one the backup seam uses.
- **A check that throws?** T5 covers it for the happy-logger path. It does not cover "the rest still run" (`lock.ts:285-286`'s own words) — one check is registered, so adding a `return` inside the catch at `lock.ts:292-298` changes nothing and passes. It also does not cover a logger that itself throws, and the production logger does exactly that (`logger.ts:129`, `fs.appendFileSync` with no try/catch).

---

## 2. The five findings that matter

### F1 🔴 — The dirty-checkpoint path is the one that repairs a theft in silence, and no test covers it

`encrypted-connection.ts:551`. Delete that line and all 5 tests pass (ablation C, 5/0).

With a dirty version, `checkpoint()` short-circuits `snapshotIsCurrent()` at the version comparison (`encrypted-connection.ts:434`), so `diskFenceIsMine()` never reads the disk and line 409 never reports. **Line 551 is the only reporter on that path.** The coverage analyst proved it with a probe: `markDirty()` then `checkpoint()` over a zombie's envelope gives `events === ["VAULT_SNAPSHOT_FENCE_FOREIGN"]` pristine, and `events === []` with line 551 deleted — the theft is repaired and never named.

That is the exact Greptile P2 failure mode the ticket exists to close ("a report that fires only on one branch of an early return is a report that depends on control flow, not on fact"), still live on the checkpoint path. `writeBackupTo` (`encrypted-connection.ts:614`) calls `checkpoint()`, and a backup is exactly where the version is routinely dirty.

### F2 🔴 — The production wiring is untested; the feature can be switched off and stay green

`main.ts:262` — `vaultLock?.addHeartbeatCheck(() => conn.recheckFence());`. Delete it and all 5 tests pass (ablation E, 5/0). The new test file registers the check **by hand** (`:92`, `:133`), so the shipped line is pinned by nothing. There is no `main.test.ts`; `gate.test.ts:122,158-164` injects its own `bootstrap` stub.

The repo already has the idiom for this: `locale-neutral.test.ts` reads production sources and asserts on them. A source scan is the cheap fix; the strong fix is booting the sidecar and reading the log.

### F3 🔴 — "Within one heartbeat" is not asserted

`fence-heartbeat.test.ts:105` / `:139` wait on a 2 s deadline with a 20 ms tick — 100 ticks of slack. An implementation that detects the theft up to 50 heartbeats late passes the test named "within one heartbeat".

Pin it with a **tick count**, not a wall-clock deadline (timer jitter on CI makes a millisecond bound flaky; a tick count is exact): register a counter as a second heartbeat check, read the counter at the rename, and assert `detectedAtTick - ticksAtRename <= 1`. The same counter fixes the vacuous negative assertion at `:95-96`, which passes identically whether the heartbeat ran three times or never ran.

### F4 🟠 — The "not durable within one heartbeat" criterion has no assertion

`encrypted-connection.ts:463` — `fenceSatisfied = fence.stamp === connectionStamp;`. Delete it and all 5 tests pass (ablation F, 5/0).

T1's comment claims "the version is not durable: the holder's bytes are back on disk only because it rewrote them" (`:108-111`), but the rewrite happens anyway because `snapshotIsCurrent()` → `diskFenceIsMine()` (`:434`, `:403`) reads the live disk. The flag is redundant as written, and the design's acceptance criterion "the version is then not durable" has **no observable surface** in the current API. Either expose one (`isDurable()`) or drop the claim from the acceptance criteria — as written, the ticket's first bullet is neither true nor false, and no test can tell.

### F5 🟠 — The context that noticed is never asserted; a wrong one passes

Every logger stub is `warn: (event) => events.push(event)` (`:82`, `:127`, `:163`, `:199`) — the message is dropped, so all four wordings in `foreignStampMessage` (`encrypted-connection.ts:367-379`) are unreachable by any assertion in the repo.

Change `noteDiskStamp(fence.stamp, "heartbeat")` to `noteDiskStamp(fence.stamp, "write")` at `encrypted-connection.ts:462` and **all 5 tests stay green**. The operator's log then says "another writer's envelope replaced the snapshot on disk" when it was in fact the idle holder's tick that noticed — and the heartbeat wording ("while this holder was idle") is the one that says the theft happened during idleness. The design note sells the site distinction as the deliverable ("this lane adds a *site*, not a code"); the site is unpinned. The same blindness hides the difference between a **foreign stamp** (an incident) and a **legacy unfenced envelope** (the normal pre-#280 upgrade path), which share one event code.

---

## 3. The rest, ranked

| # | Finding | Revert that passes all 5 | Risk | Action |
|---|---|---|---|---|
| F6 | `diskFenceIsMine`'s `noteDiskStamp` (`encrypted-connection.ts:409`) is the only reporter for a **post-write** rename (a zombie that lands between the write and the durability read). Deletable with 5/0. | delete `:409` | 🟠 | Fix it — add a test that renames inside the write window and asserts the FOREIGN event |
| F7 | `recheckFence`'s other three outcomes are untested: unfenced early return (`:458`), `absent` (file deleted — the design says "a missing snapshot is not a theft"), `undecidable` (bytes that are not an envelope), `unreadable` (`:465-470`). `encrypted-connection.test.ts:597-630` covers unreadable for the *other* site only. | report FOREIGN on `absent`; drop the UNREADABLE warn | 🟠 | Fix it — three small cases |
| F8 | The legacy envelope on the heartbeat path is untested. `noteDiskStamp(undefined, "heartbeat")` reports it as foreign by design (`292-design.md:48`); adding `if (fence.stamp === undefined) return;` passes everything. | that one line | 🟠 | Fix it |
| F9 | "Each one stands alone" (`lock.ts:285-286`) is untested — T5 registers one check, so a `return` inside the catch passes. In production a check registered *before* `recheckFence` that throws would permanently disable the fence re-read, with a log line saying it was "skipped". | add `return;` in the catch | 🟠 | Fix it — register two checks |
| F10 | A **second theft after a repair** is never named (the dedupe-reset promise at `encrypted-connection.ts:341`). A "report the first foreign stamp ever" implementation passes all 5. | `reported: boolean` instead of change detection | 🟠 | Fix it |
| F11 | The heartbeat→write **cross-site dedupe** ("the first site to notice names it and the rest stay quiet") is not asserted: T1 checks `events` *before* its final `persistIfDirty()` (`:106` then `:110`). | let the write path report again | 🟡 | Fix it — re-assert `events` after the persist |
| F12 | A throwing **logger** crashes the holder. `runHeartbeatChecks`' catch calls `logger.error` (`lock.ts:293`); the production logger's `fs.appendFileSync` (`logger.ts:129`) has no try/catch, and there is no `uncaughtException` handler in `apps/api/src`. The log directory becoming unwritable (read-only stick, ENOSPC) kills the sidecar — the exact "a failed diagnostic must never fail-stop a healthy instance" promise at `lock.ts:216-218`. Separately, `noteDiskStamp` assigns `observedStamp` *before* the report (`encrypted-connection.ts:345` vs `:349`), so a throwing report consumes the change and the theft is never named. | — (the proposed test fails today) | 🟠 | Fix it — implementation fix + a test whose logger throws |
| F13 | The `finally` blocks are not nested: `await conn.close(); lock.release();` (`:112-115`, `:143-146`, `:180-183`, `:218-221`). `close()` → `checkpoint()` throws `SnapshotPersistenceError` at `encrypted-connection.ts:559` when the post-write fence read fails. That throw replaces the real assertion failure **and** skips `lock.release()`, leaving the 20 ms interval running; the next tick finds the lock file gone → `lost()` → no `onLost` → `process.exit(1)` (`lock.ts:310`) → the whole run dies with no message. Today `close()` does not throw in these tests, so it is a trap, not a live failure. Use `try { await conn.close(); } finally { lock.release(); }` — production already has that shape in `closeVaultThenReleaseLock` (`lock.ts:555`). | — | 🟠 | Fix it |
| F14 | The assertions are coupled to the whole event list: `expect(events).toEqual([...])` fails on *any* second event, including a different code. A tick whose two fence reads fail logs `VAULT_SNAPSHOT_FENCE_UNREADABLE` (`encrypted-connection.ts:466-470`); two consecutive failed opens on a loaded Windows runner (a scanner holding the file) would go red even though the behaviour under test held. | — | 🟡 | Fix it — filter for the foreign event, treat UNREADABLE as an environment fault |
| F15 | The "no lock → no stamp" rule (`main.ts:251-254`) is untested. Its twin `requireHeldLock` exists **precisely so the branch can be pinned** (`lock.ts:334-345`, tested at `lock.test.ts:169`); the stamp twin was never extracted. Making the callback a constant (`() => "a".repeat(32)`) makes every FOREIGN report vanish and all 5 tests pass. | constant stamp | 🟡 | Fix it — extract `requireHeldStamp` and test it |
| F16 | "It does not rewrite on the tick" is unpinned. No test asserts the disk still carries the zombie's bytes after the detection; T1 only checks the stamp *after* an explicit `persistIfDirty()`. A `recheckFence()` that rewrote the snapshot passes all 5. | — | 🟡 | Fix it |
| F17 | The `return;` this diff added to the heartbeat's catch (`lock.ts:279`, so the checks do not run after `lost()`) is untested. Removing it changes no outcome and would let a check run against a released lock. | — | 🟡 | Fix it |
| F18 | Setup duplication: four of five tests repeat the same 8-line acquire+create block, and `serializedImage` (`:60-67`) is a verbatim copy of the one in `encrypted-connection.test.ts`. A `makeHolder({ heartbeatIntervalMs })` + `writeZombieEnvelope()` pair removes ~60 lines; the copy belongs in a shared fixture so the two cannot drift. | — | 🟡 | Fix it |

---

## 4. Acceptance criteria, one by one

From the ticket (#292) and `.scratch/implementation/292-design.md`.

| Criterion | Covered? | Where |
|---|---|---|
| "Piggyback a fence re-read on the holder's existing heartbeat tick, so a foreign stamp becomes not-durable **within one heartbeat**" | 🟡 re-read pinned; **not-durable** unobservable (F4); **within one heartbeat** not asserted (F3) | T1, T2 |
| "**Log** when a foreign stamp is observed at open rather than serving it silently" | ✅ but **not by this file** — all 5 tests use `fresh: true`, so the open path is never taken. It is covered by `encrypted-connection.test.ts:435-466`. The diff only refactors that warn into `noteDiskStamp`; the behaviour was already there from #280. | existing file |
| "A test that constructs the idle-then-rename sequence and asserts detection **within one heartbeat**" | 🟡 sequence ✅, bound ❌ (F3) | T1 |
| Design §Tests 1 — "detected within one heartbeat … the version is then not durable" | 🟡 log ✅, bound ❌ (F3), not-durable ❌ (F4) | T1 |
| Design §Tests 2 — "one event, not one per tick" | 🟡 same-site ✅, dedupe-reset ❌ (F10), cross-site ❌ (F11) | T2 |
| Design §Tests 3 — "a checkpoint that runs before the next tick is the first to notice the replacement, and it names it" | 🟡 names it ✅ (via `:409`, not via the checkpoint's own read); the "first to notice" **ordering** is unpinned because two independent reporters exist (F1) | T3 |
| Design §Tests 4 — "a throwing check is not a lost lock" | 🟡 happy logger ✅, "the rest still run" ❌ (F9), throwing logger ❌ (F12) | T5 |
| The fifth test (Greptile P2, dirty write repairs) | ✅ the only test that survives ablation B | T4 |

**The design note's ablation table is wrong and must not be quoted in the PR body.** Row 1 ("0 pass, 3 fail") was written for the four-test version; with five tests it is **2 pass / 3 fail**. Row 2 ("removing the write path's `noteDiskStamp` call turns test 3 red (3 pass, 1 fail)") is **false under every reading**: removing `persistNow`'s call turns **T4** red, not T3; removing `checkpoint`'s call turns nothing red; removing `diskFenceIsMine`'s call turns nothing red. No single-site revert turns T3 red. The commit body states the mutation correctly ("removing the `recordDiskStamp("write")` from `persistNow()` turns the new test red and leaves the other four green") — the design doc contradicts its own branch, because `b85e435` added T4 and the `recordDiskStamp` calls without updating the note.

---

## 5. Synthesis — what to fix

| Finding type | Action |
|---|---|
| F1 dirty-checkpoint path unpinned (🔴) | Fix it — add `markDirty()` + `checkpoint()` case |
| F2 production wiring untested (🔴) | Fix it — source scan on `main.ts`, or an integration test |
| F3 one-heartbeat bound unasserted (🔴) | Fix it — count ticks, don't measure milliseconds |
| F4 not-durable has no surface (🟠) | Fix it — expose the state or drop the criterion |
| F5 context never asserted (🟠) | Fix it — capture the message in the logger stub |
| F6–F12, F14–F18 | Fix it (see the table) |
| F13 nested `finally` | Fix it — `try { close } finally { release }` |
| Setup duplication (F18) | Fix it — a `makeHolder` helper; move `serializedImage` to a shared fixture |
| Design note §Tests / §Ablation stale and wrong | Fix it — rewrite both rows against the five-test reality |
| Duplicate coverage between T1 and T2 | **Keep** — they are not duplicates: T1 is the bound + the no-false-positive check, T2 is the dedupe. Collapse the *setup*, not the assertions. |

**Ordering for the author, cheapest first:** F3 and F5 are two edits to one file and turn two unpinned claims into pinned ones. F1 is one more test. F2 is a source scan. F4 needs a decision (expose `isDurable()` or amend the acceptance criteria) — the owner may want that one.

**No false alarms on the implementation.** Nothing here says the code is wrong; every finding is a place where the suite cannot tell a correct implementation from a broken one.

---

## Files checked

- `apps/api/src/lib/vault/fence-heartbeat.test.ts` (new, 249 lines — the subject)
- `apps/api/src/db/encrypted-connection.ts` (`recheckFence`, `noteDiskStamp`, `recordDiskStamp`, `diskFenceIsMine`, `snapshotIsCurrent`, `persistNow`, `checkpoint`, `close`; the full diff hunk)
- `apps/api/src/lib/vault/lock.ts` (`addHeartbeatCheck`, `runHeartbeatChecks`, `heartbeat`, `assertHeld`, `lost`, `release`, `requireHeldLock`; the full diff hunk)
- `apps/api/src/lib/vault/format.ts` (`readSnapshotFence`, `VAULT_SNAPSHOT_VERSION`, `SNAPSHOT_FENCE_PREFIX_BYTES`)
- `apps/api/src/main.ts` (`bootstrapVault`, the `writeStamp` closure, the `addHeartbeatCheck` wiring at :262)
- `apps/api/src/db/encrypted-connection.test.ts` (the #280 fence suite — the coverage the new file inherits and the open/legacy/unreadable cases it does not repeat)
- `apps/api/src/lib/vault/lock.test.ts` (the `requireHeldLock` unit test and the 20 ms heartbeat convention)
- `apps/api/src/lib/vault/format.test.ts` (the source-scan idiom)
- `apps/api/src/lib/locale-neutral.test.ts` (the production-source-scan idiom)
- `apps/api/src/lib/logger.ts` (`:129` `fs.appendFileSync`, no try/catch)
- `.scratch/implementation/292-design.md` (the ticket's design note, §Tests and §Ablation)
- `gh issue view 292` (the ticket text, all three "what would close it" bullets)

**Not run** (read-only lens; the parent owns the heavy queue): the test suite, the build, e2e. The coverage analyst ran only `fence-heartbeat.test.ts`, `encrypted-connection.test.ts` and `lock.test.ts` against a mutated copy of the implementation in a temp tree outside the repo.

Model: zen-proxy/glm-5.3-flash-free / Thinking: high / Harness: pi / Agent: child-subagent