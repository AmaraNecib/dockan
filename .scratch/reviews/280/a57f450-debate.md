# Debate review — PR #291 (issue #280), snapshot envelope fencing

Reviewer model: zen-proxy/glm-5.3-flash-free
Author model: zen-proxy/deepseek-v4.1-flash-free

Run per `.agents/skills/debate/SKILL.md`: critic and defender each read the diff (`git diff b16dfbb...HEAD` at `D:/worktrees/mani-project/t3-75f03409`, HEAD `a57f450`), the surrounding files (`encrypted-connection.ts`, `format.ts`, `lock.ts`, `backup.ts`, `manager.ts`, `main.ts`), the design doc `.scratch/implementation/280-design.md`, and the new tests. This file is the synthesis. Read-only elsewhere; nothing modified.

## Verdict

No P1. The fence is real, the falsification test does exercise the in-window rename race rather than assume it away, and every claim about *what the code does* checks out. The fence is **not sound in the continuous sense**: detection is activity-gated, so one sequence slips past all three points, and one sentence in `format.ts` affirmsatively overstates what the stamp can do. Everything is fixable in prose or inherits cleanly into #287.

## Answers to the five attacks

### 1. Does the fence catch the zombie? — Not continuously. One sequence all three points miss (P2)

The construction in the falsification test is a faithful construction of the race, not an assumed one: the zombie's envelope is injected **after** the winner's rename (`writeFileAtomic`) and **before** the post-write guard call in `persistNow` (`encrypted-connection.test.ts`, guard call #2 = the post-write guard), so it lands in exactly the moment the issue names, and is detected (`diskFenceIsMine()` fails, `continue`, retry, then durable). `writeFileSync` instead of a rename is equivalent-or-stricter for fence parsing; a torn write yields an undecidable fence, which reads as "not mine".

The miss — the three points all run **when the holder acts**; nothing checks on a clock:

1. Holder A commits version N. `persistNow` writes v2(stampA), the post-write re-read passes, `persistedVersion = N`, `fenceSatisfied = true` (`encrypted-connection.ts:327-338`).
2. A zombie renames its envelope (v1, or foreign-token v2) onto `dokan.db.enc`. Disk now holds roughly version N−k.
3. A goes idle: no client traffic → `persistIfDirty` never runs; no backup → `checkpoint` never runs; A crashes instead of closing cleanly → `close` never runs.
4. The next holder opens the zombie bytes. They decrypt (same master key), `quickCheckIsOk` passes, and the holder serves version N−k — with `fenceSatisfied = false` recorded, but **no log, no error, no signal at open** (`:243`).

The committed transactions that were acknowledged between the zombie's last persist and N are silently lost, exactly as pre-#280. Baseline matters: this is not a regression — pre-#280, the same rename lost the same data with strictly less knowledge. But the fence's claim, per the design doc ("a zombie's rename may have replaced our bytes since the last verified write, and a write is then still owed"), is only true *at the next check*, and the holder's last activity may be the last thing that ever happens before the crash. The `lock.ts` heartbeat runs every ~10s and re-reads the **lock file** — the natural place for a fence re-check — but `lock.ts` is #287's lane and #280 touches it not at all.

**Fix path:** piggyback `diskFenceIsMine()`-shaped verification on the heartbeat in #287, or scope the PR's claim to "detected at the next write/checkpoint/close/reopen, never served as a verified durable version". Either is acceptable; required is one of them. Relatedly, the at-open foreign-stamp detection is completely silent — a load-bearing signal ("a zombie landed on the last holder's write; the newest acknowledged transactions may be missing") with zero telemetry. Add a log at `:243`.

### 2. The migration window — a real laundering path; it stops at the first fenced write, and that is the whole protection (P3)

Walk: old-build zombie (no guard, no stamp) renames a v1 envelope containing version N−k onto a disk that already held holder A's verified v2. A's next activity rewrites it — but if A dies first, holder C opens the v1 bytes, serves them, and on C's first write (`markDirty` + boot migration persists at boot, `drizzle-store.ts:1256-1260`) serializes **C's in-memory image** — which was loaded from the zombie's bytes — under stampC in a clean v2. From that moment no holder, present or future, can distinguish laundered zombie bytes from legitimate fenced data.

Where it stops: at the first post-legacy write, and only there. The fence never authenticates legacy content by construction (that is the defect #280 patches), so the "trust" the laundered v2 envelope gets is ordinal — it says "C's process wrote this blob", which is true, not "the freshest acknowledged transactions are here", which is not checkable. The honest residual, which the design doc does not say: **until every writer in the fleet is on the fenced build, a zombie overwrite followed by an unlucky crash remains a fully silent transaction loss**, and keeping legacy read compat is what makes it silent. State that cost in the design doc and the PR body. Not a code fix — the alternative is bricking every released vault.

Credit what the migration does buy: once a vault has one fenced write, the channel is closed. The `v1 → undefined stamp → fenceSatisfied = false` open path (`:243`) plus the boot persist rewrite that v1 even when nothing is user-dirty. That part of the design is correct and tested (`"reads the legacy envelope and rewrites it fenced on the next write"`).

### 3. The stamp's trust — who can forge, and what the truth is (P3)

The `format.ts` docstring at `:262` is wrong as written: "it is useless to forge because it is authenticated by the same tag". GCM binds the stamp to *those bytes*; it does not bind it to an *identity*. A process that holds the master key and the folder can `readOwnerOnce(vault.lock)` for the current token and mint `buildEncryptedSnapshot(key, vaultId, foreignImage, currentToken)` — a fully valid fenced v2 with the **current** holder's stamp. The fence's re-read then sees "mine" and records the zombie's overwrite durable with no detection ever. The AAD defeats only the passive swapper of an existing envelope's cleartext field — which is the AAD-swap test, and that test is real.

What the stamp actually buys, and what the design doc's threat model actually relies on, is this: a **broken** former holder (stuck, suspended, failed to notice its loss) seals with the token it held at acquire time, so its bytes stay recognisable forever. An **actively malicious** holder with the key and the folder is defeated by nothing in this design — and by nothing in this codebase; such a writer can decrypt the DB, rewrite history, and produce a valid anything. Neither the docstring nor the design doc draws that line. Reword the docstring, and say the boundary in the PR: the fence discriminates between holders who behaved *helplessly*, not between holders who behaved *deliberately*.

Does cleartext-in-the-envelope widen anything? No. The token already sits in cleartext in `vault.lock` beside the snapshot, and it is a random per-acquisition value (`lock.ts` — `randomBytes(16).toString("hex")` each acquire). The one marginal widening is that stamped snapshots travel where the lock file does not — backup bundles go off-machine — but a historical holder's token is inert. The defender's set-piece argument (a token that lived only in the AAD could never be reconstructed by the next holder, bricking every post-theft unlock) is correct and caps the design space; cleartext-plus-AAD is the only shape that works.

### 4. Untaken paths — restore is not broken; two small defects nearby (P3)

`main.ts:248-253`: the fail-loud rule mirrors `requireHeldLock` correctly, and there is no "no current owner" hazard in practice — `connectionStamp` is captured once at connection construction, while a held lock exists, and later lock loss is the writeGuard's job mid-write (`assertHeld` before and after every write). If the lock file vanishes, the stamp callback's throw is unreachable at write time because the guard throws first. Correct by the same invariant both callbacks share: `writeStamp?.()` runs exactly once, at open.

The two unfenced writers both round-trip:

- `extractVaultBackup` copies `bundle.snapshot` **bytes verbatim** — it builds no envelope. A fenced backup carries the *making* holder's stamp; the restored holder decrypts it fine (the AAD is derived from the envelope's own stamp field, not from an identity comparison), gets `fenceSatisfied = false`, and rewrites at its boot migration. A refusal would require the reader to compare stamps at open and reject — the code does not.
- `.dknvbak` conversion (`manager.ts:581`) writes a legacy v1 bundle via `buildEncryptedSnapshot` without a stamp; every reader accepts v1 unconditionally (`openSnapshot:180-187`). Not rejected, not rewritten at read — the vault's daily backups stay v1 until the snapshot proper is fenced. Acceptable; a v1 bundle the reader defers to is the price of the frozen legacy AAD.

Two real but small defects in this area:

- `readDiskFence` (`:266-284`) swallows every error as `{readable: false}`. A transient `EBUSY`/`ACCES`-class failure reading the 76-byte prefix makes a **healthy, correctly-stamped** disk read as foreign, forcing a full serialize+encrypt+rename (possibly many MB) and flipping `checkpoint`'s skip into a write. Write amplification, not data loss. Distinguish "cannot read" from "reads as not mine", or retry once.
- `checkpoint`'s fence-refusal throw (`:378-381`) propagates out of `close()` before `connectionKey.fill(0)` and `raw.close()`. Key not zeroed, raw handle leaked — harmless in practice because this is fail-stop and the process exits (OS reclaims), but this file's own key-zeroing discipline is broken on that exact error. Move the zeroing into a `finally` or catch-and-rethrow after cleanup.

Also note the nanosecond window between `diskFenceIsMine()` and `persistedVersion = version` (`:333-338`): a rename landing there is recorded durable against the fence's knowledge — same lazy-detection family as §1, caught only at the next check.

### 5. Compatibility honesty — the refusal claim is true about safety, incomplete about operability (P3)

Verified: the old build's `openSnapshot` sees `version = 2`, aborts with `VaultCorruptionError("unsupported snapshot format 2")` (`:180-184`), and the HTTP surface maps it to `VAULT_CORRUPT`/409 (`lib/vault/http.ts:393`). GCM makes a silent misread structurally impossible — the old build would need to reconstruct the v2 AAD, which it cannot even name. "Refused, not silently corrupting" is the whole truth **about data safety**. What it omits:

- The error text implies the file is damaged. It is healthier than any v1 byte. The plausible user response — delete the snapshot, restore a backup — *loses* the live data; the correct response is "reopen on the new build", and the error suggests neither.
- Every backup bundle written after the upgrade carries a v2 snapshot (`writeBackupTo` copies the on-disk file verbatim, `:427`), and the daily pass keeps regenerating them. So a downgraded instance has **no restorable backup either** — its restore path fails the same `VAULT_CORRUPT`.
- A mixed fleet flip-flops: old build writes v1; new build's next unlock sets `fenceSatisfied = false` and rewrites v2; old build now refuses again. Each side alternately resurrects and breaks the vault until the fleet converges.

There is no downgrade reader in the tree (nothing writes v2→v1). That is a legitimate choice, but the PR should say: upgrade is one-directional; after the first fenced write an older build has lost access to the vault AND its post-upgrade backups, loudly, until it is brought back to a compatible build. An over-claiming sentence is a finding on this project: the PR's formulation implies "refused" is a benign state, and for a downgraded fleet it is not.

## Critic findings — classification per the skill

| # | Finding | Severity | Score | Decision |
|---|---|---|---|---|
| 1 | Detection is activity-gated; zombie-overwrite-while-idle + crash = silent stale serve; no log at open | **P2** | 8 | **Scope or fix.** Heartbeat fence-check belongs to #287; the PR (and design doc) must state the lazy boundary, and the at-open foreign stamp needs a log line. |
| 2 | `format.ts:262` "useless to forge" is false against a key-holder adversary; threat-model boundary never stated | P3 | 7 | **Fix (prose).** Reword docstring; state malicious-writer boundary in PR. |
| 3 | Legacy window launders zombie bytes under a future holder's stamp; silent until the fleet converges | P3 | 7 | **Document.** Design doc already states the mechanism; add the "silent until every writer fences" sentence. |
| 4 | Downgrade: misleading error, no restorable backup for old builds, mixed-fleet flip-flop; claim incomplete | P3 | 6 | **Document.** One-directional upgrade, stated in the PR. |
| 5 | `checkpoint` fence-throw leaks key/`raw` on fail-stop path; post-check rename window | P3 | 4 | **Fix (cheap).** Cleanup on the refusal path; window is inherent (with 1). |
| 6 | `readDiskFence` converts any read error to "not mine" → spurious full rewrite | P3 | 3 | **Fix (cheap).** Distinguish unreadable from foreign. |

Testing gaps worth one follow-up commit each, cheap: (a) no falsification-style injection test for the **checkpoint sync path** (only `persistIfDirty` is exercised); (b) no test for the overwrite-war exhaustion (zombie keeps landing → 3 attempts → `SnapshotPersistenceError`); (c) no re-open-after-close verification that a laundered foreign-stamp open logs or otherwise surfaces itself. None block.

## What the defender holds, and the synthesis accepted

The defender's load-bearing defense — "a holder that verified its own write never serves a version it does not hold" — is correct for the live process: every durability-consumption point (`persistIfDirty`, `checkpoint`, `close`) re-reads the fence live rather than trusting the cached `fenceSatisfied`, so a foreign stamp always wins the next durability decision. That is why this is a P2, not a P1: the fence's own accounting is internally consistent, and the gap is the spacing between checks, which the pre-existing code shared and #280 strictly narrows. The defender also correctly caps the shape space on §3 (cleartext-plus-AAD is forced; the variants each brick a real scenario) and was right that restore is unbroken. Where the defender's 9-10/10 confidences overreach (§1's "nothing consumes the disk except a future holder, whose open-time check is the fourth detection point" — true, but that future holder serves silently and gets no signal; §2's residual "explicitly out of scope" exists only in the doc's scope line, not in the doc's cost accounting), those are precisely the report's P2/P3 prose findings.

## Recommended parent actions

1. Land the prose fixes on this PR: `format.ts:262` docstring; PR body — lazy-detection boundary (§1), malicious-writer boundary (§3), one-directional upgrade (§5), legacy-laundering cost (§2).
2. Add to #287's brief: heartbeat piggy-backs a snapshot-fence verification; the at-open foreign-stamp detection in `encrypted-connection.ts:243` gains a log line either in this PR or #287.
3. Cheap same-PR fixes, if the author has budget: checkpoint-refusal cleanup order (`:378-381`), `readDiskFence` error discrimination (`:266-284`), and the checkpoint-path injection test.
