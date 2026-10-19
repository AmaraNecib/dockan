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

## Public interfaces

`format.ts`

- `VAULT_SNAPSHOT_LEGACY_VERSION = 1` — magic ‖ 1 ‖ sealed, AAD `snapshotAad(vaultId)`.
- `VAULT_SNAPSHOT_VERSION = 2` — magic ‖ 2 ‖ stampLen(1) ‖ stamp ‖ sealed,
  AAD `fencedSnapshotAad(vaultId, stamp)`, stamp length 1..64.
- `fencedSnapshotAad(vaultId, stamp)`.
- `readSnapshotFence(envelope): { version, stamp, bodyOffset } | undefined`.
- `SNAPSHOT_FENCE_PREFIX_BYTES = magic + 1 + 1 + 64` — enough to parse any fence.

`encrypted-connection.ts`

- `EncryptedConnectionOptions.writeStamp?: () => string` — the current holder's
  lock token. Absent = unfenced (writes v1, exactly today's behaviour).
- `buildEncryptedSnapshot(masterKey, vaultId, image, stamp?)`.
- `openSnapshot` returns `{ image, stamp }`.

`vault-store.ts` passes `writeStamp` through; `main.ts` supplies
`() => vaultLock.currentOwner().token` with the same fail-loud rule as
`requireHeldLock`. No change to `lock.ts` (that is #287's lane).

## Detection points

1. **Open.** A read envelope whose stamp is not the connection's own (or is
   legacy) sets `fenceSatisfied = false`, so the next `persistIfDirty` /
   `checkpoint` rewrites it fenced even with no mutation.
2. **Before reporting durable.** The `persistNow` early-return also asks the
   disk for its stamp. A zombie overwrite after a verified write makes
   "nothing dirty" false, so the holder rewrites instead of trusting bytes it
   did not write.
3. **After the rename.** `persistNow` re-reads the fence after `writeFileAtomic`
   and `checkpoint` after `writeFileAtomicSync`; a foreign stamp means the
   version just written is not what disk holds, so it is not durable and the
   write is redone (async) or refused (sync). This is the #280 window.

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

No Playwright E2E: the change is not reachable from a user flow (no UI, no
route); the seam is the file format, exercised by unit tests.

## Risks

- A read-back per write adds a 74-byte read. Cheap next to serialise+encrypt.
- A read per `persistIfDirty` when clean. Bounded and small.
- Unfenced (no `writeStamp`) callers keep exactly today's behaviour, so the
  existing suite is the regression guard.
