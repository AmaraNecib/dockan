# Phase 2 — the unified vault (ADR-0008 §4.3, §4.6)

Status: implementation design. Base: origin/develop @ a304ada (phase 1 merged).
Tier: High-assurance.

## Goal

One passphrase unlocks the encrypted data **and** signs the owner in. A recovery
key (shown once, up to 5, rotatable) also unwraps the master key. The vault is a
pre-boot gate: no store, auth or RPC starts until the vault is unlocked.

## Crypto choices (exact)

| Concern | Choice |
|---|---|
| Master key | 32 random bytes (`node:crypto.randomBytes`), generated at first run |
| KDF | Argon2id, pure-TS `@noble/hashes/argon2` v1.8.0 |
| KDF params | `m = 32768 KiB`, `t = 3`, `p = 1`, `dkLen = 32`, salt = 16 random bytes |
| AEAD | AES-256-GCM via `node:crypto` (native, authenticated) |
| AEAD nonce | 12 random bytes per encryption; random is safe: one key, < 2^32 writes |
| AAD | domain-separated context strings (below) |
| Recovery code | 20 random bytes = 160 bits, base32 (RFC 4648), grouped, + 10-bit SHA-256 checksum |
| Key wrapping | the master key is the AEAD plaintext; the KDF output is the AEAD key |
| Wrapped-key layout | `nonce(12) ‖ ciphertext+tag(48)` base64 in `vault.json` |
| Snapshot layout | `"DKNVAULT" (8) ‖ format(1) ‖ nonce(12) ‖ ciphertext+tag` |

AAD strings:

- wrap: `dokan:vault:wrap:v1:<vaultId>:<passphrase|recovery>`
- snapshot: `dokan:vault:db:v1:<vaultId>`

Recovery-code checksum: `sha256(key)[0..10 bits]` encoded as two base32 chars,
appended after the 32 key chars. Parsing strips separators, rejects a bad
checksum before running Argon2id.

## Files

```
<dataDir>/
  vault/
    vault.json          plaintext, authenticated metadata + wrapped master keys
    state.json          plaintext, non-secret unlock throttle + replay queue
  dokan.db.enc          encrypted SQLite snapshot (the old dokan.db is migrated)
  dokan.db              legacy plaintext (deleted after a successful migration)
  backups/…             encrypted copies of dokan.db.enc
  logs/…                non-secret operational diagnostics (not encrypted)
```

Only the database container and its backups are encrypted; `vault.json` holds no
secret (wrapped keys only), `state.json` holds no secret (attempt counters), and
logs are engineered to never contain a secret. The running database is
in-memory; plaintext never touches disk. The WAL disappears entirely: the .enc
snapshot is the only database file.

## `vault.json`

```json
{
  "format": 1,
  "vaultId": "uuid",
  "createdAt": "…",
  "kdf": { "algorithm": "argon2id", "m": 32768, "t": 3, "p": 1, "dkLen": 32 },
  "wraps": [
    { "id": "uuid", "kind": "passphrase", "salt": "b64", "nonce": "b64",
      "ciphertext": "b64", "createdAt": "…" },
    { "id": "uuid", "kind": "recovery", "label": "01", "salt": "b64", "nonce": "b64",
      "ciphertext": "b64", "createdAt": "…" }
  ]
}
```

Exactly one `passphrase` wrap; 0–5 `recovery` wraps. Each recovery wrap unwraps
independently; using one leaves the rest valid.

## Unlock throttle

`state.json`: `{ failedAttempts, lockUntil, pendingEvents[] }`. Failures are
counted across passphrase and recovery attempts; the first 5 are free, then
`30s × 2^(n-5)` capped at 15 min. Reset on success. Failed attempts survive a
restart (replaces the in-memory phase-1 throttle for the vault). Failures are
replayed into the activity log once the database is open.

## Boot flows

### Headless / dev / e2e (HTTP gate)

The sidecar starts an HTTP server in *locked* mode: `/health`, `/health-token`
and `/api/vault/*` plus the static UI. The web app sees `mode=vault, state=locked`
and renders the vault gate. `POST /api/vault/unlock` derives, unwraps, mints an
in-process session token and returns it; the sidecar then builds the store,
auth, RPC and serves the app. `state=unconfigured` first runs `setup` and shows
the recovery key once. `DOKAN_VAULT=disabled` is the dev/e2e escape hatch
(plaintext phase-1 behaviour); the packaged shell never sets it.

### Desktop shell (Tauri)

The shell keeps its pre-boot gate: the window opens on the bundled UI (Tauri
origin), the gate calls `invoke("vault_state" | "vault_unlock" |
"vault_unlock_recovery" | "vault_setup" | "vault_ack_setup")`. For
`unlock`/`setup` the shell spawns the sidecar with `DOKAN_VAULT_STDIN=1`, writes
one JSON line to the child's stdin (passphrase or recovery key) and reads one
JSON line back. No secret touches argv or the environment. On success the child
starts HTTP; the shell health-probes it, puts the session token and boot token
in the URL fragment, and navigates. `setup` returns the recovery key on stdout;
the child waits for an `ack` line before serving so the key is shown exactly
once. Wrong secrets return the Arabic error from the same vault module.

## Plaintext migration (ADR-0008 §4.6, §4.5)

`setup()` on an install with a legacy `dokan.db`:

1. open it, `PRAGMA wal_checkpoint(TRUNCATE)`, `journal_mode = DELETE`,
   `quick_check`, schema-version gate (newer → refuse).
2. `serialize()` → `Database.deserialize()` (keeps `PRAGMA user_version`).
3. write `dokan.db.enc` (tmp + fsync + rename), then `vault.json` (tmp + rename),
   then delete the legacy `dokan.db{,-wal,-shm}`.
4. crash windows leave the plaintext file and no vault header → retried next
   boot; a vault header without the snapshot cannot exist (snapshot first).

## Persistence and durability

The runtime DB is `Database.deserialize()` of the decrypted snapshot. Persist =
`serialize()` → AES-GCM → tmp + fsync + rename. Flush points: after every
`withTransaction`/`withTransactionImmediate` COMMIT; after every mutating store
call (call + snapshot write inside one queue slot, so success is only reported
once the image is durable); `flush()` at bootstrap; `checkpoint()` on close and
before each backup copy. Version counters mean a failed write stays dirty and
is retried, and a snapshot write that still fails after retries is fail-stop:
main exits (the connection's `onFatalError` hook) rather than report a
committed unit as failed (a client retry would duplicate it). `close()` awaits
the persist queue before releasing the handle. There is no timer flush: nothing
is written that a committed unit did not trigger.

## Auth seam

In vault mode `requireSession` accepts ONLY the `x-vault-session` header
matching the in-process token minted at unlock; better-auth sessions are never
consulted and `/api/auth/*` is not mounted at all, so a legacy password account
cannot act as a second credential and no auth write can bypass the encrypted
store's dirty tracking. The plaintext build keeps the better-auth path
unchanged. Cross-origin requests cannot set the header without a preflight, and
the token is only ever sent to the local origin, so vault-unlocked owner access
is not CSRF-able. Employee logins are a future addition: when they arrive they
sign in after the vault is open and reuse the same guard.

## Tests

- unit: format (recovery code/checksum/header, KDF bounds), crypto round trips
  + nonce uniqueness + AAD binding + tamper/truncation, core (wrong/correct
  passphrase, recovery unlock, recovery set-passphrase, add/rotate/remove keys,
  last-key guard, persist-failure rollback), state throttle, encrypted
  connection round trip (`user_version` preserved, snapshot corruption class).
- integration: HTTP gate (fresh setup → recovery shown once → unlock → RPC with
  the vault session, wrong passphrase Arabic refusal, restart stays locked,
  copies decrypt on another dir = portability, legacy db migration).
- e2e: `tests/e2e/vault.spec.ts` boots an isolated API+web pair in vault mode and
  walks first-run → recovery key → owner setup → app; wrong passphrase; recovery
  unlock.
- Rust: broker protocol + vault-state + shell navigation URL tests.
