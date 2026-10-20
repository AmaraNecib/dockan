# #280 — fence the snapshot envelope so a zombie write cannot make the new owner trust stale bytes

Base SHA: `b16dfbb` (merge-base with `origin/develop`).

## Tier

**High-assurance.** The diff changes the vault snapshot's on-disk format and its
read/write path, so it can violate failure mode (5): a backup/restore loses or
corrupts data. A wrong fence makes a committed image unreadable, or lets the new
owner record a version it does not hold.

## Decision implemented

Owner decision on the issue (2026-10-19), option 1: fence by stamping the lock's
own token into the authenticated data, keep reading the legacy envelope, and
rewrite what is read on the holder's next write.

### Numbering correction (flagged to the parent)

The decision says "bump to **v3**, keep reading **v2**". The tree's envelope
version is **1**, not 2:

- `apps/api/src/lib/vault/format.ts:193` — `VAULT_SNAPSHOT_VERSION = 1`;
- `snapshotAad(vaultId)` — `dokan:vault:db:v1:<vaultId>`;
- no branch, PR or remote ref carries version 2 (checked `refs/heads`,
  `refs/remotes`, `refs/pull`).

Reading "v2 and writing v3" as written has no v2 to read and drops the real v1,
so every existing vault would fail unlock with `VAULT_CORRUPT: unsupported
snapshot format 1`. This lane uses the true sequence — **read v1, write v2** —
and the PR body's compatibility rule must be stated as v1→v2, not v2→v3.

### Stamp placement

The token is a **cleartext field in the envelope** and is **also fed into the
AAD**. "Into the AAD" alone cannot work: after a crash the next holder's token
differs from the writer's, so a token that only lived in the AAD could never be
reconstructed by the next holder and every unclean restart would brick the
vault. Storing it in the header lets the next holder read it and decrypt;
binding it into the AAD makes it tamper-evident (changing it fails GCM).

### What the stamp proves, and what it does not

Binding the stamp into the AAD makes the cleartext field **tamper-evident**:
swapping one envelope's stamp for another fails the GCM tag, which is exactly
what the AAD-swap test asserts. It does **not** bind the stamp to an identity. A
process that holds the master key and the folder reads the current holder's
token out of `vault.lock` and mints a validly fenced envelope under that stamp;
the post-write re-read then sees "mine" and records the overwrite as durable,
with nothing detected, ever.

So the fence discriminates a holder that behaved **helplessly** — a stuck or
suspended former holder seals with the token it held at acquire time, and that
stamp stays recognisable forever — and never one that behaved **deliberately**.
Nothing in this design holds a deliberate writer back, and nothing in this
codebase could: such a writer decrypts the database and rewrites history. The
threat this closes is the zombie, not the adversary. An earlier draft of this
section said the stamp was "useless to forge because it is authenticated by the
same tag"; that sentence was false and is replaced by this one.

## Public interfaces

`format.ts`

- `VAULT_SNAPSHOT_LEGACY_VERSION = 1` — magic ‖ 1 ‖ sealed, AAD `snapshotAad(vaultId)`.
- `VAULT_SNAPSHOT_VERSION = 2` — magic ‖ 2 ‖ stampLen(1) ‖ stamp ‖ sealed,
  AAD `fencedSnapshotAad(vaultId, stamp)`, stamp length 1..64.
- `fencedSnapshotAad(vaultId, stamp)`.
- `readSnapshotFence(envelope): { version, stamp, bodyOffset } | undefined`.
- `SNAPSHOT_FENCE_PREFIX_BYTES = magic + 1 + 1 + 64` — enough to parse any fence.

`encrypted-connection.ts`

- `EncryptedConnectionOptions.writeStamp?: () => string` — the holder's lock
  token, as it is at the moment the connection OPENS (read once, not per write).
  Absent = unfenced (writes v1, exactly today's behaviour).
- `EncryptedConnectionOptions.logger?: StoreLogger` (`store/port.ts`) — where a
  fence the connection cannot verify is reported. `StoreLogger.info` is the
  level the routine cases use.
- `buildEncryptedSnapshot(masterKey, vaultId, image, stamp?)`.
- `openSnapshot` returns `{ image, stamp }`.
- `SnapshotFailureReason` travels on `SnapshotPersistenceError`, so a caller can
  tell "the disk failed" from "another writer took the file".

`vault-store.ts` passes `writeStamp` and `logger` through; `main.ts` supplies
`holderToken(vaultLock)` with the same fail-loud rule as `requireHeldLock`. No
change to `lock.ts`'s locking (that is #287's lane), beyond exporting the
token reader so its no-lock branch is unit testable.

`packages/contracts` gains the fence event codes, and `apps/web` their Arabic
badges: `VAULT_SNAPSHOT_FENCE_FOREIGN`, `VAULT_SNAPSHOT_FENCE_UNSTAMPED`,
`VAULT_SNAPSHOT_FENCE_MISSING`, `VAULT_SNAPSHOT_FENCE_UNKNOWN`,
`VAULT_SNAPSHOT_FENCE_UNREADABLE`, `VAULT_SNAPSHOT_FENCE_DOWNGRADE`.

The api cannot see these codes with a literal-only scan: `reportFence` picks
info-or-warn at runtime and passes the code to one local `emit`. The #253
vocabulary scan therefore matches `emit(level, "CODE"` as well, and
`lib/log-events.test.ts` lists the six codes so the scan's own reach is pinned —
a pattern that stops matching now fails instead of quietly shrinking the set.

## Detection points

1. **Open.** A read envelope whose stamp is not the connection's own (or is
   legacy) sets the fence unsatisfied, so the next `persistIfDirty` /
   `checkpoint` rewrites it fenced even with no mutation. The case is surfaced as
   an **informational** line: `VAULT_SNAPSHOT_FENCE_FOREIGN` for another
   holder's stamp, `VAULT_SNAPSHOT_FENCE_UNSTAMPED` for the legacy envelope with
   no stamp at all. It is information and not a warning because the token is
   minted per acquisition (`lock.ts`), so the bytes on disk after any clean
   shutdown always carry the previous session's stamp: the routine restart and
   the zombie are the same input, and nothing in the envelope can tell them
   apart. A warning here would fire on every launch and train the owner to
   ignore the one row that matters. The signal only becomes discriminating when
   a holder epoch travels with the fence (a format change, tracked separately).
2. **Before reporting durable.** The `persistNow` early-return also asks the
   disk for its stamp. A zombie overwrite after a verified write makes
   "nothing dirty" false, so the holder rewrites instead of trusting bytes it
   did not write.
3. **After the rename.** `persistNow` re-reads the fence after `writeFileAtomic`
   and `checkpoint` after `writeFileAtomicSync`; a stamp that is not ours means
   the version just written is not what disk holds, so it is not durable and the
   write is redone (async) or refused (sync). The refusal carries which fence
   replaced ours, and ONLY a readable replacement is a refusal — the race is
   what the issue is about. An **unreadable** prefix is not evidence that
   anyone took the file (a replacement would have been read and named), so that
   case writes and returns; the version is simply left dirty and re-sealed by
   the next write, instead of killing the process over a transaction that is on
   disk. This is the #280 window.

## Planned tests

Unit (`apps/api/src/db/encrypted-connection.test.ts`, `apps/api/src/lib/vault/format.test.ts`):

1. A written envelope carries the current holder's stamp.
2. A former holder's snapshot is detected by the current holder with no
   timestamp comparison and rewritten.
3. A foreign-stamped snapshot on disk makes the current holder's version not
   durable, and it rewrites.
4. The falsification test: a zombie rename lands inside the write window; the
   write is detected and the stolen version is not recorded.
5. The legacy envelope reads, and is rewritten fenced on the next write.
6. Tampering with the stored stamp fails decryption (it is in the AAD).
7. `readSnapshotFence` parses legacy/fenced/truncated/unknown/oversized input.
8. The checkpoint window (debate finding): a rename injected inside the
   synchronous write makes `checkpoint` refuse, and nothing is recorded durable.
9. The overwrite war: a zombie that lands after every rename exhausts the three
   attempts with `SnapshotPersistenceError`, and the version is still dirty —
   pinned by putting a correctly stamped envelope on disk by hand and showing
   the next persist still writes (a `persistedVersion` that had advanced would
   short-circuit it).
10. A foreign-stamped envelope surfaces at open as INFORMATION, and a legacy one
    under its own code (`VAULT_SNAPSHOT_FENCE_UNSTAMPED`).
11. An unreadable fence is retried exactly twice, with the write path's 50 ms
    between the attempts: one refusal that clears inside the window is absorbed
    with no warning and no rewrite, and a bound of one or five reds.
12. A `close()` whose final checkpoint refuses still closes the raw handle.
13. `openVaultStore` passes the stamp down, and `holderToken()` returns the
    lock's own token and throws with no lock (`db/vault-store.test.ts`,
    `lib/vault/lock.test.ts`).
14. A vanished file and unparseable bytes are each unverifiable, named, and
    rewritten — not believed durable.
15. A stamp that cannot survive the UTF-8 round trip, an empty one, and one past
    the 64-byte bound are refused at open; 64 bytes is written and read back.
16. `writeBackupTo` refuses to bundle bytes whose fence is not the holder's,
    checked on the buffer actually bundled.
17. A dirty persist reads the fence exactly once, and a clean check exactly
    once — the cost line below is a counted claim and this counts it.
18. The restore write site (deliberately ungated): `extractVaultBackup` writes
    the bundle's snapshot byte-for-byte, with the stamp the bundle carried, and
    not the restoring process's own lock token. The exception is a documented
    one, so a later "fence every writer" change has to break a test to make it
    disappear (`lib/vault/backup.test.ts`).
19. `checkpoint()` after `close()` writes nothing and does not throw: the
    synchronous seam refuses a released handle silently instead of surfacing
    "Can't do this on a closed database" from a caller that cannot retry.
20. The bundle fixture reads back as the legacy v1 envelope it is named for,
    so the fixture's meaning cannot drift silently with the version constant.

No Playwright E2E: the change is not reachable from a user flow (no UI, no
route); the seam is the file format, exercised by unit tests.

## Carried along: the close() race (#291, outside this issue's scope)

The fence work rewrote `persistIfDirty`, and that rework exposed a pre-existing
race the issue does not ask about. Recording it here because the design record
is what the tier was decided from, and this diff ships the fix.

`persistIfDirty` used to `await` its opening currency read **before** it chained
the job onto `persistQueue`. A `close()` that read the queue inside that window
saw it drained, checkpointed, zeroed the key and released the SQLite handle;
the flush then resumed inside `persistNow` and called `raw.serialize()` on the
released handle, which throws `Can't do this on a closed database`. In CI that
was an intermittent shutdown failure.

Evidence, and the ordering that is the point:

- red on the parent commit: `056ca18a`'s source with the head's store tests runs
  **6 pass / 3 fail**, one failure naming exactly that error with
  `serializedAfterRelease = 1`;
- the fix is ordering, not a flag: the job is chained **synchronously**
  (`const run = persistQueue.then(...); persistQueue = run.catch(...)`), so a
  `close()` that reads `persistQueue` after the call is waiting for *this*
  persist, and it flips `closed` with no await between that resumption and the
  handle release;
- because of that ordering the flag has exactly one readable site on the async
  path — the near side of the serializer — and the store's `#291` tests kill an
  ablation of it. Guards at the top of each write attempt and after the
  post-write fence read were removed: `close()` cannot run inside an attempt it
  is awaiting, so nothing could ever observe them, which makes them comments
  that look like code;
- `checkpoint()` carries the same refusal for the synchronous seam, because a
  second `close()`, or a backup checkpoint requested while the process is going
  down, is an ordinary event and must not throw an opaque SQLite error.

The shutdown path is part of the same story. A close whose final checkpoint
cannot prove the last version durable now logs `SNAPSHOT_PERSIST_FAILED` with
the reason and exits **non-zero**, which is the verdict the write path already
gave the same condition. It cannot retry (the handle is gone), but "could not
retry" is not "did not fail". The next boot still reports a foreign or legacy
fence at `info`, because at boot that is the routine "an earlier session's bytes
are on disk" case and no loss is known yet; the shutdown row is where the loss
becomes known. The three sites therefore agree on the verdict and differ only in
the level the case deserves.

## Risks and costs the PR owns

- A read-back per write adds a 74-byte read. Cheap next to serialise+encrypt.
- **A dirty persist reads the fence once**, and a clean check reads it once —
  **measured**, and pinned by the counting test above: one `fs.openSync` on the
  snapshot path either way. A dirty image short-circuits the currency question
  before any pre-write read, so the post-write re-read is the only one; a clean
  one pays for the currency answer. Each read is a 74-byte prefix read.
- A read per `persistIfDirty` when clean. Bounded and small.
- Unfenced (no `writeStamp`) callers keep exactly today's behaviour. That is
  NOT the regression guard for the fenced path: the fenced path has its own
  tests (`db/vault-store.test.ts` pins the production wiring), because an
  unfenced caller exercises none of it.
- A fence that cannot be read is retried twice with 50 ms between attempts, and
  then the write proceeds with the version left dirty. It is never fatal: an
  unreadable prefix says nothing about who wrote the bytes, and killing the
  process over a transaction already on disk is the wrong answer to a busy
  handle.
- **The fence authenticates writer identity, never content currency.** It can
  say "the process that wrote this blob held token T". It cannot say "this blob
  holds the freshest acknowledged transactions", because no version travels
  with the bytes to compare. Two costs follow from that, and both belong in the
  PR body rather than only here:

  1. **Detection is activity-gated.** All three points run when the holder acts.
     A zombie overwrite that lands after the holder's last write, followed by
     that holder crashing instead of closing, is served by the next holder with
     an unsatisfied fence and an informational `VAULT_SNAPSHOT_FENCE_FOREIGN`
     line — but the transactions acknowledged in between are already gone, and
     that line is indistinguishable from an ordinary restart. Re-checking the
     fence on the `lock.ts` heartbeat closes the timing half; only a holder
     epoch travelling with the fence closes the diagnostic half, which is a
     format change and a separate issue.
  2. **Any foreign envelope launders, not only v1.** An old-build zombie renames
     a v1 envelope onto a disk holding the holder's verified v2. If the holder
     dies before its next write, the next holder serves the v1 bytes and, on its
     own first write, serialises that in-memory image under **its own** stamp in
     a clean v2. From then on no holder, present or future, can tell the
     laundered bytes from legitimate fenced data. The same happens with a
     foreign **v2**: it opens, it decrypts (the context comes from its own
     stamp), it is served, and it is re-sealed under the next holder's stamp,
     after which the evidence is gone. The channel closes at the first fenced
     write and not before: until every writer in a mixed fleet is on this build,
     one zombie rename plus an unlucky crash is a silent transaction loss.
     Reading v1 is what keeps it silent, and the alternative is bricking every
     released vault.

Both are docs-and-PR costs, not code fixes. The fence narrows the window the
issue names and is honest about the window it leaves.
