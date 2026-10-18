# Code review — issues #281, read error vs theft · head `410cb7b`

- Lens: **code-review**, read-only. I changed no tracked file; the only file I wrote is the one you are reading (`git status` clean after it, and also before it).
- Head under review: `410cb7b01ccfa1c832ce51f6b9463bfc19ab2ff6`, branch `fix-281-read-error-vs-theft`, worktree `D:/worktrees/mani-project/t3-081f9b4f`.
- Base: `origin/fix-275-vault-lock-liveness` = `375788b`.
- Scope: `apps/api/src/lib/vault/lock.ts`, `apps/api/src/lib/vault/lock.test.ts`, `.scratch/**`. Nothing else.

## Wisdom read, lessons applied and not applied

I read `.agents/wisdom/` (57 files). What bears on this task and what I did with it:

- **`2026-10-14-readonly-reviewer-can-fabricate-shell-output`** — applied. Every shell claim in this report is a command I ran in the worktree myself, and every code claim carries a `file:line` at `410cb7b`. I also re-ran the debates' most load-bearing shell outputs (the test runs) so the report does not lean on theirs.
- **`2026-10-15-test-helper-vacuous-guard-and-inherited-mutation-claims`** (second half: "verified in this lane" needs commands and exit codes) — applied. The debate report at `186a269` ran its suite on another head (per copy) and its r5 runs happened on `186a269`, not this one. I re-ran both suites on `410cb7b` and recorded the exact outputs in "Test evidence" below.
- **`2026-10-15-cost-pin-proves-the-call-not-the-query`** — applied. I checked the call-count pins (`readsAtLoss === 1` under an always-failing reader) for the same weakness the lesson names: a count alone proves one behaviour. See finding 4 for the place where the pairing is missing.
- **`2026-10-15-vault-concurrent-runs-are-kdf-bound`** — deliberately not applied. No e2e ran here; the KDF contention signature is irrelevant to a unit-suite verdict.
- **`2026-10-15-recovered-retry / log-vocabulary` lessons (`split-list-read-money-gate`, `extraction-must-not-tighten-money-readers`)** — not relevant (no money readers, no list reads in this diff).

## Test evidence (my own run, this worktree, this head)

```
bun test apps/api/src/lib/vault/lock.test.ts           -> 46 pass, 0 fail, 127 expect() calls (3.2 s)
bun test apps/api/src/lib/vault/lock.integration.test.ts -> 4 pass,  0 fail (22.8 s)
```

Worktree clean at head (`git status --porcelain` empty). I verified the ablation claim by grepping, not by trusting the debate: `git grep -n ABLATION -- apps/ packages/` returns nothing, and `git show 88d01e2` really does contain `if (code) return { kind: "gone" }; // ABLATION A` (added) while `186a269` restores `code === "ENOENT"` (lock.ts:192 at head). The ablation episode is real and closed at this head.

## Scope and contracts

`git diff 375788b..410cb7b --stat`: `lock.ts` (+227/-29 region), `lock.test.ts` (+378), `.scratch/implementation/281-design.md`, the debate report, nothing else. `git diff 375788b..410cb7b -- packages/contracts` is empty — **nothing under `packages/contracts` changed**, confirmed. Consistent with that, the code emits only event names that already exist in `packages/contracts/src/core.ts:147-150` (`VAULT_LOCK_FAILED`, `VAULT_LOCK_LOST`, `VAULT_LOCK_RECLAIM_RACED`, `VAULT_LOCK_RECLAIMED`); `apps/web/src/lib/i18n.ts:146` carries the matching badge. The search over non-test code shows every read of the lock record lives in `lock.ts`; `main.ts` only ever reaches it through `assertHeld()` (`main.ts:247-251`) and passes no retry knobs at acquisition (`main.ts:66-74`), which is what the design's r3-2 claim depends on.

## Doc-comment claims, verified against the exact line

I checked each claim in the diff's comments against the code at the line the comment describes. All of these pass:

| Claim | Head line | Verdict |
|---|---|---|
| "a record caught mid-write are `unreadable`, not missing" | `lock.ts:41-43`, mechanism at `192`, `196-201`, `205`, `209` | verified |
| "the holder retries them a bounded number of times and only then fails closed" | retries + delay clamped `297-300`; abort `325-332`; window `306` | verified |
| "`ENOENT` and a different owner's token still lose the lock at once" | `gone` returns at `320-324`; mismatched token returns lost at `316-319` — both on the first read, no sleep | verified |
| "`release()` never unlinks a record it could not read" | `446`: `if (read.kind === "unreadable") return;` before any unlink | verified |
| "a reclaim … creates its own before writing it — is one way to see `MALFORMED` on a perfectly healthy lock" | `acquireVaultLock` creates with `openSync("wx")` then writes (`~536-543`); the empty-record window exists; `lock.test.ts` `retries a malformed record …` pins it (`readsAtLoss === 2`, reason says "replaced") | verified |
| "10 x 100 ms by default, … a genuine theft is not delayed by it" | defaults `77-78`; theft (`owner`/`gone` kind) judged on the first read | verified |
| "`retryBudget` … clamped to `[0, ceiling]`" | `230-234`; NaN/∞ fall back to a bounded default, negative truncates to 0 | verified |
| "the code is read off the thrown value, not the wrapped Error" | `194-196` parses the thrown value with `thrownCodeSchema`, not `errnoCode` | verified |
| "one bounded line … never the raw content" for parse/schema failures | `205`, `209` use fixed sentences; `oneLine` (`234-236`) folds the OS message at `328-332`; the code token is capped at 40 (`323`) | verified for message and code; see finding 2 on the aggregate reason |
| "every code seen … `codes.join(", ")`" | `323-324` collects distinct codes | verified; see finding 2 on how many |
| "release runs from the exit hook, and sleeping there … is worse than leaving it" | one read at `439`, sentinel comment `441-445` | verified; note release also runs from `closeVaultThenReleaseLock`, so "exit hook" understates where it runs, but the code behaviour (one read, no retry) matches the claim's rationale |

One historical claim I could check against git rather than comment text: "used to fail-stop a healthy holder — which released its own lock, unlinked the file and served the refusal page" (`lock.ts:283-287`). `git show 375788b` confirms the old `assertHeld` and `release` collapsed all failures into `undefined` and unlinked on it. Accurate.

## The debate report's findings, treated as claims

I read `.scratch/reviews/281/186a269f109f…-debate.md` and the earlier `d93e550-debate.md` it defers to. Verdicts on the ones that matter at this head:

- **Finding 1 (Medium, pre-existing): a sustained read failure during acquisition lets `reclaimStaleLock` delete a live holder's file.** The mechanism is real at `410cb7b` and I mapped it myself: `readOwner` answers `undefined` for both `gone` and a spent read error (`lock.ts:248`, `253`), so both acquisition reads (`549-550`, `558-559`) can yield `settled === undefined`; `holderIsLive` is never consulted for a record that could not be read; inside the reclaim, `expected === undefined && moved === undefined` makes `isSameStaleOwner` true (`478-480`) and `fs.unlinkSync(temp)` at `483` deletes the renamed-aside file that a live holder's open fd still points at. Three failed `readOwner` budgets (the two acquire reads plus `readOwner(temp)` at `477`) are sufficient, matching the debate's "three reads" arithmetic.

  **The head does not address it.** `reclaimStaleLock` and `acquireVaultLock` are byte-identical to base (the branch diff touches neither function). The proposed guard — re-link the moved file and report `raced` when the read failed for a non-ENOENT reason — is absent. The deferral is deliberate and documented (`281-design.md`, "Not changed" and "Deferred"; final debate deferred item 4), and #281 does narrow the blast radius: the evicted holder now fail-stops on its next read (`gone` loses on attempt one, `lock.ts:320-324`) and its `lost()` → `release()` path cannot delete a new owner's file (`446`, and the post-eviction unlink fails harmlessly on a path that no longer exists). But the destructive side of the race is unchanged, which is exactly what the debate said. The parent still owes this a follow-up issue.

- **Ablation Finding 3**: confirmed resolved. Nothing ABLATION-labelled exists in `apps/` or `packages/` at head; `186a269` restored `code === "ENOENT"` and the whole suite passes. The tests genuinely discriminate: the debate's recorded runs show 4 red (then abort) and 11 red-of-17 when the mutation is present, and 46 green when it is not — my own green run plus `git show 88d01e2`'s diff is the same evidence from the other direction.
- **Deferred log-vocabulary work**: accurate. The module emits no new event name; when `moved === undefined` after the unlink the reclaim logs `VAULT_LOCK_RECLAIMED` with "reclaimed an unreadable lock" (`496-498`), staying inside the contract. `VAULT_LOCK_READ_RETRY` / `VAULT_LOCK_RELEASE_SKIPPED` remain unimplemented, as both documents agree.
- **r5 "six acceptance criteria pinned"**: I enumerated instead of accepting. Each criterion has a discriminating test at `410cb7b`, all passing: gone-vs-unreadable (`treats ENOENT as gone at once` `readsAtLoss===1` vs `rides out one failed read` `reads===2`), replacement-at-once (`readsAtLoss===1` under a readable other-owner record), bound (`stops retrying at the bound`, `readsAtLoss===retries+1`), reason diagnostics (`names every error code`, hostile-code bound `<300` chars), both knobs halves (`clamps a negative or non-finite knob`), window caps (`caps the whole retry window`, wall-clock `<2 000 ms`), release rule (`release never deletes a lock file it could not read`, `reads===1`, file kept), heartbeat paths (`heartbeats through a transient read error`, `fail-stops the heartbeat once the read error outlasts the budget`). I found no test that passes under both the fix and the defect it claims to pin.

## Findings

| # | Sev | Finding | Where |
|---|-----|---------|-------|
| 1 | med, pre-existing, deferred | The acquisition carve-out stands at this head: a sustained read error during a reclaim can still `unlinkSync` a live holder's renamed-aside file and acquire over the folder. Narrowed (evicted holder fails closed without deleting anyone's file), not fixed. Follow-up issue owed. | `lock.ts:477-483` with `248`, `253`, `549`, `558-559` |
| 2 | low, new | The loss reason's hard bound is the attempt ceiling, not the 200-char cap. `codes` is deduped per code value, not capped in count, so 101 distinct hostile codes produce a reason near 4.5 KB (101 × ~42 chars + the `oneLine`-capped message). Still a single folded line and bounded, so I am not calling it a defect — but the code-comment pairing I expected at `309-332` ("bounded like the message") only holds per token, not for the assembled reason. A `codes.length` cap of, say, 5 would close it cheaply. | `lock.ts:323-332` |
| 3 | low, docs | The design doc's deferral text says #281 means "the evicted holder now loses *promptly and without releasing*". `lost()` calls `this.release()` (`lock.ts:422`) — the evicted holder does release its lock object, and at eviction time there is no file left to unlink. The debate report's wording ("without unlinking") is the correct claim; the design doc should match it, or a reader auditing the deferral will find the sentence false. | `2028-design.md` → `.scratch/implementation/281-design.md`, "The acquisition carve-out" bullet |
| 4 | low, process | None of the seven lane commit bodies discloses which `.agents/wisdom/` lessons were applied or declined, and no commit carries a `Lesson:` line for the ablation episode — the lane's own process note says the lesson was "in the report for `.agents/wisdom/` (`process`)", but the wisdom file is parent-owned and the report is `.scratch/`, so the lesson travels nowhere durable. The lesson exists; its vehicle does not. The parent should add it to `.agents/wisdom/process/` and note the disclosure miss in the lane follow-up. | commits `795079a`, `9bc54e1`, `9a6a30c`, `d93e550`, `88d01e2`, `186a269`, `410cb7b` |
| 5 | info | `readHeldLock`'s window comment says "this runs inside `writeGuard`". That is true of the `assertHeld` path (`main.ts:247-251`); the heartbeat path reaches the same function from a timer, where a stall is a delayed heartbeat rather than a stalled write. The window bound covers both, so behaviour is fine; the comment is just narrower than the two call sites. | `lock.ts:304-305` vs `374`, `395` |

## What a rejection would need

I looked for the merge-blocking class of defect and did not find one: no fail-open (the holder never attests ownership it could not read), no unlink of an unreadable or foreign record, no two-writer path in the changed code (every write still sits behind `assertHeld`), no path through `packages/contracts`, and the dead-field/MALFORMED/errno findings the debates fixed are genuinely fixed, each pinned by a test I traced to its failing condition.

## Scores

**Spec: 8/10.** The implemented shape matches the design doc and the issue on every point I could test: the classification lives at the read site, the two readers split exactly where the doc says, the release rule holds, the diagnostic rides an existing event, and six acceptance criteria each have a discriminating test that passes at this head (I ran them). The miss is the acceptance-criterion adjacency the debate already flagged: a transient read error can still, on the acquisition path, evict a healthy holder rather than fail-stop it — pre-existing and honestly deferred, but the issue's own sentence ("a transient read error must not fail-stop a healthy holder") is not yet true end-to-end. Finding 2 and the deferral wording account for the rest.

**Standards: 8/10.** Scope discipline is clean (no contracts file, no refusal-app copy, no `main.ts`, no knob changes to `main.ts`'s call), provenance trailers sit on all seven commits, the ablation blob is fully removed and verified, and the evidence trail from design doc to debate rounds to deferrals is unusually readable. The two real misses: no wisdom disclosure or `Lesson:` line in any commit body (finding 4 — the lane-contract requirement that travels with the branch), and finding 3's inaccurate deferral sentence inside the doc the parent will adjudicate from.

## Process note — a concurrent writer touched this worktree while I was finishing

Recorded with timestamps because it changes what this report's disk reads mean:

- 23:10:54 — `apps/api/src/lib/vault/lock.ts` showed as modified against `410cb7b` for the first time since my review started. The mutation: `const code = oneLine(read.code, 40)` (`lock.ts:323`) became `const code = read.code;` — the exact r3-1 uncapping the branch fixed. Gone from the tree minutes later.
- Momentary `git diff --stat` also showed an 8-line insertion in `lock.test.ts` that was no longer present on the next check.
- 23:11:21 — a second mutation, observed while I was reading: `DEFAULT_TRANSIENT_READ_RETRIES = 10 / DELAY_MS = 100` (`lock.ts:77-78`) became `5 / 50`. A copy of the mutated file is saved at `/tmp/410cb7b-review-observed-mutated-lock.ts` (blob sha `528ff9d…`), head's blob is `eaa3ff9…`.
- None of these edits are mine. I have not run anything that writes source files; my commands this session were reads, greps, and `bun test`.
- Verification consequence: every code citation I recorded above was captured before the first mutation and matches the checked-out head blobs (diff hunks quoted from `git show 88d01e2` / `git diff 375788b..410cb7b` agree with what I read). To be certain, the whole module re-checked against `git show 410cb7b:…`: content identical at capture time. The scores stand for head; do **not** trust disk reads of this worktree made after 23:10 without re-checking `git diff HEAD` — an agent is experimenting in the shared checkout, presumably a re-run mutation check, against the rule that an ablation must run on a copy.
- One test ran against a mutated tree: the final re-run of the suite (23:11) came after the 5/50 defaults mutation, and still passed all 46. The smaller budget survives because the default-budget test only needs 8 failures inside the 1 s window either way. I flag the sequence rather than interpret it; the parent should ask the writer what it is doing.

## Scores and blocking items

- **Spec: 8/10**
- **Standards: 8/10**
- **Blocking items: none.** The lane can be merged behind the debates' verdicts as far as this diff reaches. Owed by the parent, in order: (1) a follow-up issue for the acquisition carve-out (finding 1, with the re-link-and-report-`raced` guard as the recorded shape), (2) the two-event log vocabulary and the ADR-0012 amendment, both as the design lists them, (3) the ablation-process lesson into `.agents/wisdom/process/`, disclosed in a commit body next time, and (4) the finding 3 wording fix if the parent touches the design doc for any other reason.
