# Test-audit — issue #281, transient lock-file read error vs theft

- Reviewed head: `410cb7b01ccfa1c832ce51f6b9463bfc19ab2ff6` (frozen)
- Base: `origin/fix-275-vault-lock-liveness` = `375788bd725b2074944e4b984393c38975f5469d`
- Branch: `fix-281-read-error-vs-theft`; tier: High-assurance
- Scope: `apps/api/src/lib/vault/lock.ts` (+`lock.test.ts`); focused runs only
- Method: mutation audit. Baseline `bun test src/lib/vault` = 156 pass / 0 fail (63 s);
  `lock.test.ts` alone = 46 pass / 0 fail (3.3 s); `lock.integration.test.ts` (itHeavy, cross-process)
  = 4 pass / 0 fail. Each ablation below mutated `lock.ts` from a pristine copy, ran the focused
  file, then restored via `cp` and verified `cmp` identical; `git status --short` at the end of the
  session shows no modified tracked file (the one untracked file besides this report is the
  parallel code-review lens's, not this lane's).

## Wisdom applied (from `.agents/wisdom/`, read first)

- **`2026-10-16-latent-shape-mutation-proof.md`** — the mutation-proof-then-ablate method this
  report uses, and the caution to say what a test is a *chain-level* detector for, not what its
  title implies. Applied directly to F1: the window-cap claim fails under the *combined* mutant
  but not under the *unit* mutant, which is the distinction the table below records.
- **`2026-10-15-test-helper-vacuous-guard-and-inherited-mutation-claims.md`** — a guard that
  passes on the happy path protects nothing; proved here by F2 (the NaN half of a clamp test runs
  and passes against a mutant that deletes the mechanism it titles). Also the provenance rule:
  every ablation below lists its exact mutants, the red tests, and the run's exit evidence.
- **`2026-10-16-shared-fixture-edit-erases-a-pin.md`** — run both shapes so a pin proves a
  negative; here that meant checking the aisles for seams the mutant kills the runner before it
  reaches (see the abort note under A11), not only counting the reds the console printed.
- **`2026-10-14-readonly-reviewer-can-fabricate-shell-output.md`** (title borrow) — every run in
  the table actually executed in this worktree; exit codes were captured, not inferred.
- Not applied: the vault-concurrent-e2e lessons (no e2e run happened) and the lanes/ports lessons
  (single lane, focused suite).

## Claims × pinning evidence

Every claim the diff makes, with the test that went red when the production code was mutated to
remove it — or the gap. Mutant markers are the actual diffs applied to `lock.ts` during the audit.

**A. Machine classification (`LockFileRead`)**
- "`ENOENT` is the only canonical gone, every other failure is `unreadable`" → **pinned, 3 reds
  under A3** (`if (false && code === "ENOENT")`): `treats ENOENT as gone at once…`,
  `fail-stops when the lock file has genuinely gone (default reader)` (1 004 ms — the mutant's
  held read burns the window before failing closed), `classifies a non-Error throw by its errno code`.
  The reverse mutant (A4, `if (code)` — any coded error is gone, the `88d01e2` blob) → **4 reds**
  (`rides out one failed read`, `stops retrying at the bound`, `names every error code`,
  `bounds a hostile error code`), matching the debate r5's count for the same mutant.
- A non-Error `{ code }` still classifies → **pinned** (the A3 mutant reds the non-Error test).

**B. Held-path retry budget (`readHeldLock`)**
- "an unreadable held file is retried, bounded, then fails closed" → **pinned, 5 reds under A2**
  (loss condition forced true — no retries): `rides out one failed read`, `stops retrying at the
  bound`, `names a malformed record…`, `retries a malformed record…`, `names every error code`.
  Note: A2 kills the runner at `clamps a negative or non-finite knob…` (that test's NaN half has
  no `onLost`, so `lost()` calls `process.exit(1)`); the heartbeat/cap tests never execute under
  this mutant and their discrimination is asserted against the tighter mutants below instead.
- "attempts are bounded by `transientReadRetries` (101-read ceiling)" → **pinned** (A12, ceilings
  removed: `caps the attempt ceiling…` red at 10 001 reads vs 101).
- "the default is 10 × 100 ms = one second of patience" (r3-2) → **pinned as an aborted run**
  (A11, defaults reverted to 5 × 50: runner exits 1 immediately after `clamps…`, never reaching
  `keeps its patience at the default budget`). It is discriminated, but the pin trips through
  `process.exit`, not a clean red — see hardware note at the bottom.
- "`gone` loses on the first read, no budget spent on a missing file (`readsAtLoss === 1`)" →
  **pinned** (the A3 mutant reds it via readsAtLoss; A4 reds it via the reason text).

**C. Identity / theft (`token` comparison)**
- "another owner's token loses NOW; writes refuse" → **pinned, 5 reds under A5** (held-branch
  treats any owner record as ours): `still fail-stops at once when another owner's record is
  there`, `retries a malformed record…`, `vault single-writer lock > a queued snapshot write
  refuses once the lock is stolen, and writes nothing (ADR-0012 clause 3)` (snapshot bytes
  unchanged ⇒ the write gate really does gate), `fail-stops when the lock file is replaced…`,
  `names the holder in the log…`.
- The reply-identity chain writes are pinned by the queued-snapshot test; it is a *chain-level*
  detector (heartbeat + `assertHeld` + persist `writeGuard`), per the latent-shape lesson.

**D. Heartbeat**
- "a transient error during the heartbeat is not a loss" → pinned by `heartbeats through a
  transient read error…` (knobs 3 × 1 ms).
- "a sustained error outlasts the budget and the heartbeat fail-stops" → **pinned, 3 reds under
  A13** (`heartbeat()` returns silently on a lost read): `fail-stops the heartbeat once the read
  error outlasts the budget`, `fail-stops when the lock file is replaced by another owner`,
  `names the holder in the log…`.

**E. `release()`**
- "an unreadable record is never unlinked" → **pinned, 1 red under A6** (skip removed):
  `release never deletes a lock file it could not read` (file kept → existsSync true).
- "ONE read only" (N3) → pinned directly by the same test's `state.reads === 1` assertion (a
  mutant that adds a retry loop makes the count ≠ 1; counting assertion is its own mutation
  detector, not ablated further).

**F. Bounded hostile input in the loss reason**
- codes list is exhaustive (all errnos seen in the window) → **pinned, 1 red under A8**
  (`codes.length = 0` before each push — keep-last): `names every error code it hit`.
- message folded to one line / 200 chars → **pinned, 1 red under A9** (`oneLine` dropped on the
  message): same test reds on the embedded newline.
- code folded and capped → **pinned, 1 red under A10** (`oneLine(read.code, 40)` dropped):
  `bounds a hostile error code the same way as the message`; classification still compares the
  raw code, so the ENOENT tests stay green under A10 (the log fold is independent of the classify).

## Findings

### F1 — Medium: the 1 s window cap (`MAX_HELD_RETRY_WINDOW_MS` / `budgetEndsAt`) is not pinned on its own
**Ablation A1**: removed only `|| Date.now() >= budgetEndsAt` from the held loss condition →
**46 pass / 0 fail. Green with the mutation.**
The claim "one held-lock read sequence may block for at most this long, whatever the knobs" is
only detected when the *delay clamp* (`MAX_RETRY_DELAY_MS = 500`) is also removed (A12 →
`caps the whole retry window…` red via the window condition firing, 1 013 ms). A mutant that
deletes the window alone leaves every path bounded by ≤ 100 × 500 ms with no red — the windows
the tests exercise (default 10 × 100 ms with ≤ 8 failures; knobs 3 × 1 ms) never reach 1 s.
So the tests pin `retryBudget`'s ceilings and let the window be defended by them; the design's
N2 wording ("the held-lock retry sequence additionally stops after MAX_HELD_RETRY_WINDOW_MS=1 s,
because it runs inside writeGuard") names a defense line no test can distinguish from the delay
clamp. **Fix shape:** one held-lock test whose knobs ask for `transientReadRetries: 10_000,
transientReadRetryDelayMs: 500` (delay legal at the ceiling, total 50 s ≫ window) and a
persistently throwing reader — that sequence only terminates at the window, and the red under
A1 is then certain.

### F2 — Minor: the NaN half of the clamp test does not discriminate
**Ablation A7**: removed `!Number.isFinite(configured)` from `retryBudget`'s fallback condition →
**46 pass / 0 fail. Green with the mutation.**
`NaN` then flows to `Math.trunc` → NaN retry count and NaN delay; NaN comparisons are always
false and `Bun.sleepSync(NaN)` does not throw, so `clamps a negative or non-finite knob…`'s NaN
half passes vacuously — the strongest claim its title makes ("falls back to the default instead
of zeroing it") is untested: no test pins default-vs-NaN behaviour for a *persistent* read error
under NaN knobs. The `-1` half does pin observable behavior (one read, then loss). Harm under the
mutant stays fail-closed through the window/attempts machinery, so this is an accuracy gap in the
claim, not a safety hole. **Fix shape:** a NaN-knob lock whose reader throws forever, asserting
the loss reason's attempt count is the default budget's (11, not window-bound).

### F3 — Minor: the acquisition-path knob clamp is unpinned
**Ablation A14**: `readOwner` reverted to raw `options.readRetries ?? 20` / `readRetryDelayMs ?? 50`
→ **46 pass / 0 fail. Green with the mutation.**
Every test that passes `readRetries` passes `1` (or none), so removing `MAX_RETRY_ATTEMPTS` /
`MAX_RETRY_DELAY_MS` from the boot path changes nothing any test can see. The claim "these stop a
boot with a pathological `readRetries` from turning a boot into an event-loop stall" is a comment
and a dead-at-runtime-if-removed function halve. **Fix shape:** one acquisition test with
`readRetries: 10_000, readRetryDelayMs: 10_000` over an unreadable file asserting the boot
verdict still lands within the clamp (wall-clock upper bound like `caps the whole retry window`).

### F4 — Debate-report Finding 1 (Medium, pre-existing) is NOT addressed at head, and is correctly deferred
`reclaimStaleLock` is byte-identical to base (`git diff 375788b..410cb7b` contains no hunk in it),
and the mechanism is unchanged in code: `readOwner` answers `undefined` for both `gone` and a
spent read error, so with `expected === undefined && moved === undefined` the reclaim unlinks the
moved record and acquires — a **sustained** read error during the rename-seam read can still evict
a live holder's file (`reclaimStaleLock` renames the live holder's record aside,
`readOwner(temp)` then fails for a non-ENOENT reason, `isSameStaleOwner` is true by construction,
`unlinkSync(temp)` destroys the holder's record). The held-side reaction #281 adds is pinned: the
evicted holder loses promptly on ENOENT ("treats ENOENT as gone…") and cannot unlink what it
cannot read ("release never deletes…" + "release never deletes another owner's lock"), which is
the narrowing the design claims. The carve-out itself has no pinning test and would need `lock.ts`
changes beyond this lane; the deferral in the debate report and the design doc is accurate.

### F5 — Minor (test quality): the "keeps its patience" pin trips the runner, not the test
A11 (default-budget mutant) produced exit 1 with **no summary** — the test's lock carries no
`onLost`, so `lost()` reaches `process.exit(1)` and ends the whole file mid-run. The
discrimination works (a CI run goes red) but buries the cause and hides the fate of all tests
ordered after it. One line — `onLost: () => undefined` on that `acquireVaultLock` call — would
turn any future default-budget regression into a clean named red. The same shape exists at
`reclaims an unreadable lock file instead of blocking forever` (also `onLost`-less, also capable
of killing a run via some future mutant).

## Verdict

**5 findings.** A–E claims pinned or gap-attributed as follows:

| Claim | Pinning test(s) (red on mutation) | Ablation |
|---|---|---|
| ENOENT = gone, alone | treats-ENOENT-as-gone; genuinely-gone (default reader); classifies a non-Error throw | A3 (3 red), A4 (4 red) |
| Coded read error ≠ gone, retried | rides-out; stops-retrying (count in reason); names-every-error-code; bounds-hostile-code | A2 (5 red, abort at 6th), A4 |
| Bounded retry, 101 ceiling, 1 s window | caps-the-attempt-ceiling (ceiling & window jointly); caps-the-whole-retry-window; stops-retrying | A12 (2 red); **window alone: no pin (F1)** |
| Default 10 × 100 ms | keeps-its-patience — pins only via aborted run | A11 (F5) |
| Another owner's token = theft, writes refuse | still-fail-stops-replaced; queued-snapshot-write (ADR-0012); replaced (round-5); names-the-holder; retries-malformed | A5 (5 red) |
| Heartbeat rides a transient error | heartbeats-through-a-transient-read-error | A13 |
| Heartbeat fail-stops outlasting/fake-owner | fail-stops-the-heartbeat; fail-stops-replaced; names-the-holder | A13 (3 red) |
| Reason names every code, one bounded line | names-every-code; bounds-hostile-code; stops-retrying (count + OS sentence) | A8, A9, A10 |
| Non-Error `{ code }` classified | classifies-a-non-Error-throw | A3 |
| `release()` never unlinks unreadable; one read | release-never-deletes-a-lock-file-it-could-not-read | A6 (1 red) |
| Knob clamp `[0, ceiling]`, non-finite → default | clamps-a-negative-or-non-finite-knob (-1 half and outcome only) | **A7 green (F2)** |
| Boot-path read-owner clamp | — (**no test drives a pathological `readRetries`**) | **A14 green (F3)** |
| Acquisition semantics unchanged (#275's readOwner) | refuses-a-second-instance; reclaim tests (unchanged by design) | n/a |
| Sustained read error during reclaim cannot evict a live holder | — (**no test pins the carve-out**) | A14/inspection (F4, deferred) |

Ablations left the tree clean: `git status --short` shows only the two untracked report files
(this one and the parallel `410cb7b-code-review.md`); `apps/api/src/lib/vault/lock.ts` is
byte-identical to `410cb7b` (`cmp` against the frozen copy).
