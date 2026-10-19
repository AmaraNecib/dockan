# Debate — Issue #281 transient lock read error vs theft (head `d93e550`)

- Issue: #281 ("Tell a transient lock-file read failure apart from theft")
- Tier: High-assurance
- Branch: `fix-281-read-error-vs-theft`; reviewed head: `d93e550` (4 commits over `origin/fix-275-vault-lock-liveness`)
- All line numbers below are from `git show d93e550:apps/api/src/lib/vault/lock.ts` / `...lock.test.ts`, quoted so they survive branch movement.

## Process note on drift

The branch moved under this review: the tip was `d93e550` when the review started, and
`88d01e2` ("one second of patience at the default budget, and a bounded code") appeared
during it. This report is strictly about `d93e550`. Two tip-only observations are
quarantined in Finding 4 below.

## Core question — verdict

**Does the head genuinely tell "no owner recorded" apart from "read failed for a
transient reason"?**

- **On the holder path (`assertHeld`, heartbeat, release): yes.** The classification
  lives at `readOwnerOnce` (`lock.ts:184-213`): `ENOENT` is the only
  canonical-gone (`:192`), a record that does not parse or is schema-invalid is
  `unreadable`/`MALFORMED` (`:205`, `:209`), and every thrown value with a non-ENOENT
  (or missing) errno is `unreadable` (`:196-201`). No caller on the holder path
  collapses those back together — enumerated below.
- **On the acquisition path: no, deliberately.** `readOwner` (`:238-251`) answers
  `undefined` for both `gone` (`:245`) and an error that survives the retry budget
  (`:250`), and its doc-comment states this is unchanged from before #281
  (`:236-241`). That boundary is where one residual caller still reads a transient
  failure as no-owner, and it is the one place the distinction mattering for THEFT
  is thrown away. Finding 1.

## Call-site enumeration (by search, not memory)

Every read of the lock record is inside `lib/vault/lock.ts`; `rg -n "vault\.lock"`
over non-test files outside that module returns nothing. Full list:

| # | Site | Read function | How it treats an unreadable read |
|---|------|---------------|----------------------------------|
| 1 | `assertHeld` `:366-371` | `readHeldLock` `:368` | retried `transientReadRetries` (5 × 50 ms) + a 1 s wall window (`:325-329`); only then fail-stop (`:370`) — **never** no-owner |
| 2 | `heartbeat` `:382-406` | `readHeldLock` `:389` | same; on `lost` → `this.lost(...)` `:391` |
| 3 | `release` `:422-447` | `readOwnerOnce` `:439` | `unreadable` → **skip unlink** (`:440`) — cannot delete a file it cannot identify |
| 4 | `reclaimStaleLock` `:462-511` | `readOwner(temp)` `:471` | retried 20 × 50 ms, then `moved === undefined` → `expected === undefined && moved === undefined` makes `isSameStaleOwner` true (`:472-474`) → **`unlinkSync(temp)` `:477` deletes the file**. This is the residual no-owner reading; Finding 1 |
| 5 | `acquireVaultLock` first read `:543` | `readOwner` | `undefined` → proceeds toward reclaim; `holderIsLive` at `:544` is unreachable when the record is unreadable |
| 6 | `acquireVaultLock` settled read `:552` | `readOwner` | same shape at `:553` |
| 7 | `acquireVaultLock` error-report reads `:556`, `:560` | `readOwner` | `undefined` only degrades the refusal message's holder identity (`VaultAlreadyLockedError` at `:91-107`); no lock action taken |
| 8 | write guard (out of module) | `apps/api/src/main.ts:247-251` | calls `held.assertHeld()` — site 1's behavior |

That is the whole surface: no caller on the holder path reads a transient failure as
no-owner, and exactly the acquisition cluster (sites 4-6) still does, by design.

## Findings

| # | Sev | Finding | Decision |
|---|-----|---------|----------|
| 1 | 4 (med, pre-existing) | Sustained transient read failure during acquisition can delete a live holder's lock and acquire over it | **Deferred** — documented acquisition carve-out; cheap guard proposed |
| 2 | 2 | `readOwner` has attempt/delay ceilings but no wall-clock window (misconfig → up to ~150 s of sync stall total) | **Documented**; tip `88d01e2` raises the default budget, not the ceiling risk |
| 3 | 3 (hazard, not this head) | Tip `88d01e2` carries a committed `ABLATION A` mutation that treats ANY coded read error as gone | **Flag for parent** — never merge while present |
| 4 | 1 | Reason-strings built by `describeReadError` are the only diagnostics; recovered retries log nothing | **Accepted** (vocabulary-contract constraint, documented) |

### Finding 1 — the last caller that reads transient as no-owner

Scenario at `d93e550`: AV/indexer holds `vault.lock` open for a write-booting process.
If `EBUSY` lasts ≥ ~2.2 s — the two `readOwner` budgets (`:543`, `:552`, 20 × 50 ms
each), the 200 ms settle (`:551`), plus a third budget inside `reclaimStaleLock`
(`:471`) — then `expected === undefined` and `moved === undefined`, so the
"is it the SAME stale owner" check (`:472-474`) degenerates to `false || undefined,
i.e. true`, and `:477` unlinks the renamed file that a **live** holder's open fd
still points at. `holderIsLive` (`:544`, `:553`) offers no protection because it is
only consulted for a record that read successfully. The fresh boot then takes the
folder; the healthy holder fail-stops promptly on its next read (that path is what
this change fixed), so the final damage is the availability loss #281 set out to
stop, plus a narrow pre-next-guard write race.

Defender: (a) it is the deliberate trade the design carves out — a permanently
required-attestable corrupt record would block every boot forever; (b) it is
unchanged semantics from before #281, so this lane regresses nothing; (c) the
`readOwner` budget already tolerates a ~1 s AV hold at each of the two reads.

Critic: the issue's acceptance criterion 2 says a transient read error must not
fail-stop a healthy holder; this path *evicts* a healthy holder instead, which is
one house over. The cheap guard does not reopen the "corrupt record blocks boot"
door: when `moved` is `unreadable` (not `gone`) and `expected` is `undefined`, link
the temp file back and report `"raced"` — the boot refuses with a no-holder
`VaultAlreadyLockedError`, a genuinely dead-but-corrupt lock can still be reclaimed
after a human deletes it, and nothing deletable ever leaves the holder's control.
Alternatively pass the classified result through `readOwner` (`:244-245` collapse
one value) and decide on `kind`, not on absence.

Decision: **defer to a follow-up** (acquisition semantics are explicitly outside
this lane's stated scope, `.scratch/implementation/281-design.md` "Not changed"),
but it deserves an issue — it is the same blind spot in the same read path.

### Finding 2 — bound vs window

`readHeldLock` caps the wall clock (`MAX_HELD_RETRY_WINDOW_MS`, `:106`, used at
`:303-306` and `:325-329`). `readOwner` (`:238-251`) has only per-knob ceilings
(`MAX_RETRY_ATTEMPTS 100`, `MAX_RETRY_DELAY_MS 500`, `:96-101`): a misconfigured
boot can stall the event loop 100 × 500 ms per readOwner call, and the acquire loop
pays that up to five times across a failed attempt (`:543`, `:551`, `:552`, `:471`,
plus the post-failure reads `:556`/`:560`). Worst case ≈ 150 s of synchronous stall;
bounded, but long. Defaults are 1 s per read. Deferred: boot-time-only, requires
explicit misconfiguration, and the tip has already softened the default cost.

### Finding 3 — hazard on the moved tip (NOT present at `d93e550`)

`88d01e2` commits `if (code) return { kind: "gone" }; // ABLATION A: any read error
is treated as ENOENT` (tip `lock.ts:192`). That is exactly the regression this
issue exists to fix. It is caught by the tip's own tests (`:466-490` "rides out one
failed read" expects `assertHeld()` to hold after one `EBUSY`; `:531-552` expects
the loss reason to name `EACCES`, both fail under the ablation), so it reads as a
deliberate mutation-check for the test-audit lens — but it is **committed to the
branch tip**. The parent must confirm ABLATION A is a temporary mutation and is
removed (or reverted) before anything pushes. Nothing on `d93e550` behaves this
way (`d93e550:lock.ts:192` pins the correct code).

Same tip commit raises `DEFAULT_TRANSIENT_READ_*` to 10 × 100 ms (= 1 s of patience)
and bounds the errno token to 40 chars — both fine, neither evaluated here.

### Finding 4 — diagnostics

Verified clean:

- JSON-parse and schema failures never log file content — fixed sentences at
  `:205`, `:209` (a hostile or half-written record's bytes cannot reach the log).
- `describeReadError` (`:219-221`) folds newlines and caps at 200 chars before the
  reason is interpolated at `:326`, so a multi-line OS message cannot break the
  JSONL log line; flapping codes are collected (`:318`) and both are asserted by
  the tests (`.test.ts:597-621`: `toContain("EBUSY, EACCES")`, `not.toContain("\n")`).
- The loss reason (`:326`) carries only codes, attempt count, and the OS's own
  sentence (path + errno) — never the owner record, never the token. `lost()` logs
  holder identity as host + pid (`:414`), and `host` is length-capped at the schema
  (`:62`).
- No new log-event codes: `packages/contracts/src/core.ts:148-150` unchanged (the
  diff touches only `lock.ts`, `lock.test.ts`, and the design doc).
- Recovered (non-loss) retries log nothing — accepted as documented in the design
  (event vocabulary is a cross-package contract outside this lane's scope).

Passphrase check: the lock record is `{ pid, host, startedAt, heartbeatAt, token }`
(`:47-54`); no pass-phrase-derived material exists in the lock path at all, and the
only content-shaped string that could have leaked (the failing record's text) is
structurally excluded (`:203-205`). No leak path found.

## Acceptance criteria, head `d93e550`

| Criterion | Evidence |
|-----------|----------|
| ENOENT and read error distinguishable at the read site | `lock.ts:192` vs `:196-201` |
| transient error does not fail-stop a healthy holder | ride-out tests `.test.ts:466-490` (assertHeld), `:675-696` (heartbeat) |
| gone/replaced still fail-stop promptly | `gone` loses on the FIRST read, no sleep (`.test.ts:492-506` `readsAtLoss === 1`; `:508-514` default reader `rmSync`; `:516-528` replacement) |
| retry bounded, log names the error | bound test `.test.ts:531-552` (`EACCES` + "N attempts"); window/attempt caps `.test.ts:632-676` (101 reads under a 10 000-knob) |
| both errors forced through the seam | `errno()` helper `:40-42` injects codes incl. non-Error (`:614-631`) |

All five pass at `d93e550` on inspection. Test execution was skipped: the worktree
checked out the tip's drifted content mid-review, so a run here would not have
executed the reviewed head; running tests against `d93e550` is left to the gate.

## Residual for the parent

1. Finding 1 — follow-up issue for the acquisition/`reclaimStaleLock` no-owner
   reading, with the link-back-and-race guard as the proposed shape.
2. Confirm ABLATION A (Finding 3) is a mutation-check exercise and that the tip
   either reverts it or was never intended to keep it.
3. The deferred log-vocabulary work (`VAULT_LOCK_READ_RETRY`,
   `VAULT_LOCK_RELEASE_SKIPPED`) and the `docs/**` ADR-0012 amendment stand as the
   design lists them.
