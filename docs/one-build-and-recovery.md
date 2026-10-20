# One universal build: secrets, recovery, and portable data

Design document for ADR-0008. This replaces the per-customer secret baking in PR
#117. Read the ADR first; this file is the detail.

## 1. Problem

- The build bakes a **per-customer** session-signing secret and provisioning secret
  into the sidecar. One shop = one build = one installer.
- Updating the app therefore means rebuilding and re-sending per shop.
- The baked secret is extractable from the binary anyway, so it does not protect
  against a local user.
- The app is **portable**: with `portable.marker`, everything lives in `data/` beside
  the exe, so the USB is the trust boundary. A secret bound to the machine (e.g. OS
  DPAPI) cannot work here — the secret must travel with the stick.

## 2. Goals / non-goals

**Goals**
- One build for every shop; one artifact per release.
- Updates never change the shop's credentials.
- Copying/restoring the portable data preserves data **and** sessions.
- Password reset works without a per-customer build and without shipping signing
  material.
- Old installs remain resettable forever.

**Non-goals**
- Multiple user accounts. The model below is owner-centric and extends cleanly.

**Decided: the unified vault**
- The data folder is encrypted with a **master key**. The owner unlocks it with a
  **passphrase**, and the same passphrase signs them in — one step, no separate login.
- The master key is also wrapped by a **recovery key** (a long random value shown once
  at first run). Either the passphrase or the recovery key unwraps the master key, so a
  forgotten passphrase is recoverable **by the recovery key**, not by the vendor.
- If both the passphrase and the recovery key are lost, the data is cryptographically
  unrecoverable. This must be stated plainly at first run.

## 3. Domain model

Terms to add to `CONTEXT.md` (glossary only, no implementation):

- **Session signing secret** — the key that signs login sessions. Generated per
  install, not shipped.
- **Recovery code** — a single-use code the owner saves to regain access. Only its
  hash is stored.
- **Device challenge** — a non-secret value the app shows when the owner has lost
  every recovery code and the password.
- **Reset token** — a signed, single-use, short-lived token the vendor produces from
  a device challenge.
- **Reset signing key** — the vendor's key pair. The private half never ships; the
  public half is embedded in the build. It carries a **version**.
- **Schema version** — a number stored in the database that identifies the data
  format.

## 4. Design

### 4.1 Build

- No secret is baked. `DOKAN_AUTH_SECRET` / `DOKAN_BUILD_SECRET` and the per-customer
  `.env.<slug>` files disappear from the release path.
- The build embeds the **public** reset keys: a small map `{ keyVersion → publicKey }`.
  Public keys are not secret; embedding them does not force per-customer builds.
- `main.ts` no longer refuses to boot on a sentinel signing secret; instead it reads
  the secret from the database (4.2).
- **Provisioning gate.** Today `config.buildSecret` guards `firstTimeSetup` and
  `resetAdminPassword`; removing it removes that gate. Replacement: first-run
  provisioning (creating the owner account) is allowed **only on an empty database**;
  a non-empty database with no owner refuses it, and reset goes through the recovery
  paths (§4.3/§4.4). `DEV_AUTH_SECRET` and the sentinel boot guard are removed.

### 4.2 First run

- On a fresh database — **or an existing database with no stored secret** (a shop
  migrating from a per-customer build) — generate a strong random **session signing
  secret** and store it in `settings` (e.g. `auth_secret`). Never regenerate it once
  present. A migration therefore invalidates old sessions exactly once.
- **The migration never hands out a recovery code at first boot.** After the owner logs
  in on the migrated database, the app offers to generate a code (the normal §4.3
  flow). Nobody who merely holds the stick gets a takeover code.
- If the database is copied/restored, the secret comes with it → sessions survive.
- The secret is a normal row in the portable database; the stick is the boundary
  (see §7).
- **Phase-1 interim exposure.** Until the vault lands, `auth_secret` is a plaintext
  row in the database and therefore in every backup copy. Anyone who can read the
  portable data folder can forge sessions; the vault (§4.6) is what closes this.
- **Phase 1 has no password-reset path.** The build-secret reset is removed before the
  recovery paths (§4.3/§4.4) exist, so a forgotten password is permanent until this
  lane lands (restore a backup, or wait for recovery). Phase 1 is not a general
  release for shops that depend on reset.

### 4.3 Recovery key

- At first run, generate a **recovery key** (≥ 128 bits, e.g. 26+ base32 characters),
  show it **once**, and ask the owner to save it. It unwraps the master key (§4.6), so
  it recovers a forgotten passphrase.
- Store only the **wrapped** master key, never the plaintext passphrase or key.
- The owner may rotate the recovery key from settings (after unlocking) and keep up to
  **5**, each able to unwrap the master key; using one does not invalidate the others,
  and generating more requires the vault to be unlocked.
- Never log it; never show it again after the generation screen.
- **Entropy:** ≥ 128 bits; group for transcription and add a checksum.
- **Passphrase derivation:** Argon2id; name the library and parameters in
  implementation.
- **Rate-limit, persisted:** attempts are limited **per install** and the counter is
  stored in the database (the existing in-memory throttle clears on restart). Backoff
  after 5 failures, shared across the unlock and recovery screens, failures written to
  the activity log.

### 4.4 Vendor fallback (challenge–response)

1. The app shows a **device challenge**: random nonce + install id + the key versions
   this build accepts.
2. The owner sends it to the vendor.
3. The vendor signs it with the matching **private** key and returns a **reset token**
   (includes `keyVersion`, single-use, short expiry, e.g. 24h).
4. The app verifies the token with the embedded public key for that version and lets
   the owner set a new password.

**Vendor verification (must-fix).** Signing a challenge is not authentication: anyone
could submit a challenge and get a token. The vendor signs **only after verifying the
requester out-of-band** (the registered owner's phone/record), deny by default. The
signed payload binds `installId + nonce + keyVersion` so a token cannot be moved to
another install or key. Use a fixed algorithm (Ed25519) with the version inside the
payload, never selected by a header.

**Key versioning.** A build embeds a **map of the public keys it accepts**
(`{ keyVersion → publicKey }`), not only the current one. The vendor keeps every
private key; to reset an old install it signs with a version that install accepts.
Rotating a key never breaks the ability to reset an old install.

**Key custody.** Every private-key version is backed up offline with redundancy (e.g.
2-of-3 escrow), and a rotation runbook is written. A lost key is recoverable by
shipping an upgrade that accepts a new version; a version held only by un-upgraded
installs and then lost strands them.

**Legacy installs.** Pre-universal (per-customer) builds trust their baked
`DOKAN_BUILD_SECRET`, not this scheme. Keep those build secrets until every shop has
migrated, or provide an upgrade-first reset runbook.

**Single-use challenges.** The app stores the challenge nonce it displayed and accepts
a matching signed token **once**; a consumed nonce is rejected, so a still-valid token
cannot be replayed. Challenges expire and are cleaned up; tokens carry a short expiry
(e.g. 24h) with a stated clock-skew allowance. The portable clock is settable, so
expiry is a bound, not a guarantee.

**Compromised keys.** If a private key is compromised, the vendor stops signing with
that version for new builds but must keep it to reset the existing installs that trust
it; because a token is only accepted against a live, single-use challenge, the window
is bounded. Document this trade-off in the rotation runbook.

**Session revocation.** Both recovery paths revoke **every** existing session when the
password changes — someone holding a pre-reset session must not keep access.

### 4.5 Schema version and import

- Store a **schema version** in the database (`PRAGMA user_version` or a `settings`
  row). Bump it with each forward change.
- On open: older → apply forward `ALTER`s (the existing pattern) and stamp the new
  version; newer → refuse with a clear Arabic message; run `PRAGMA quick_check` on an
  imported file first.
- **Import sequence (order matters):** back up the current database; `PRAGMA
  quick_check` **and** `PRAGMA foreign_key_check`; read the version; show a preview
  (invoice count, version direction, whether sessions survive); **checkpoint the WAL
  while the connection is still open**, then close it; write the new file to a temp
  path and **rename** it into place (crash-safe on a USB); **delete the stale
  `dokan.db-wal` / `dokan.db-shm` sidecars**; then **restart the process or fully
  re-init** the store, auth and router (they capture the connection and the signing
  secret at boot), draining in-flight requests first. Migrations and the version
  stamp run in one transaction **on import**; the ordinary boot migration is a
  sequence of idempotent, marker-gated steps with the version stamped last, so an
  interrupted boot re-runs them safely. If a post-swap migration fails, restore the
  backup.
- Version storage: use `PRAGMA user_version` (decided); a database with no version is
  treated as the oldest pre-universal format.

### 4.6 Unified vault (decided)

- **Master key:** random, generated at first run. It encrypts the data folder with an
  AEAD (e.g. XChaCha20-Poly1305).
- **Passphrase:** `Argon2id(passphrase, salt)` unwraps the master key **and** signs the
  owner in — one step, no separate login. The owner row stays for store settings; it is
  no longer a separate credential.
- **Recovery key:** unwraps the master key too (§4.3), so a forgotten passphrase is
  recoverable. Recovery is for the vault, not a separate login.
- **Lost both:** the data is unrecoverable — say this plainly on the first-run screen.
- **Sessions:** the session-signing secret lives inside the encrypted database, so it
  travels and is protected. Employee accounts (later) log in after the vault is open.
- **Vendor cannot decrypt.** The vendor fallback can authorize a reset of the app
  login, but it can never recover a lost vault key.

### 4.6.1 Implementation decisions (phase 2)

**Exact cryptography.** Master key: 32 random bytes (`node:crypto`). KDF:
Argon2id (`@noble/hashes`), m=32768 KiB, t=3, p=1, 16-byte random salt,
32-byte output. AEAD: AES-256-GCM (`node:crypto`) with a fresh random 12-byte
nonce per encryption and domain-separated AAD
(`dokan:vault:wrap:v1:<vaultId>:<kind>` for wraps; the snapshot context is per
envelope, below). A wrapped master key is `nonce ‖ ciphertext+tag` base64 in
`vault.json`. Recovery keys: 20 random bytes (160 bits) rendered as 32 base32
characters plus a 10-bit SHA-256 checksum, grouped for transcription; a bad
checksum fails before the KDF.

**Snapshot envelope: two versions, v2 is what the live writer produces.** Both start with the 8-byte
magic `"DKNVAULT"` and a one-byte version.

- **v1 — read, never written.** `"DKNVAULT" ‖ 1 ‖ nonce ‖ ciphertext+tag`,
  sealed with AAD `dokan:vault:db:v1:<vaultId>`. Every released vault is in
  this shape, so it stays readable. It carries no writer stamp, so a former
  holder's bytes cannot be told from the current holder's.
- **v2 — what every new write of the live snapshot produces.** `"DKNVAULT" ‖ 2
  ‖ stampLen ‖ stamp ‖ nonce ‖ ciphertext+tag`, sealed with AAD
  `dokan:vault:db:v2:<vaultId>:<stamp>`. The stamp is the writing process's
  `vault.lock` token (1..64 bytes), kept in the clear and bound into the AAD:
  swapping it fails the GCM tag, and a reader learns the bytes are not its own
  before decrypting. A v1 file is rewritten fenced on the holder's first write.
  A foreign-stamped file is not rewritten *by being opened* — opening only reads
  the fence and reports it — it is rewritten by the first write after that open,
  which in production is the boot's `store.setup()`: `drizzle-store.ts` marks
  the image dirty and persists there, so every boot repairs the fence. A caller
  that opens a connection and never writes leaves the foreign bytes in place.
  The one exception is a
  RESTORE: `extractVaultBackup()` writes the live snapshot from the bundle
  verbatim. The restore DOES hold the single-writer lock — it calls
  `acquireVaultLock(dataDir)` and `lock.assertHeld()` around the write — so it
  has a token. But a token alone is not enough: the bundle's snapshot was
  sealed under whatever master key produced it, and the restore has no master
  key to re-seal it under, so it cannot stamp a fresh envelope; it can only
  copy bytes. A restored
  live snapshot is therefore whatever the bundle carried — a v1 envelope from a
  legacy conversion, or a v2 carrying the dead session's stamp. The next holder
  reads it, reports the fence it cannot verify, and rewrites it fenced on its
  first write, which is the same path a legacy vault already takes.
  Do not "fix" this exception by stamping the lock token onto a restored
  snapshot: that would break restores of legacy bundles, which is the case the
  exception exists for. The lock being held is not the gating condition; the
  missing master key is.
- **v1 in a backup bundle is not a fault.** `encryptLegacyBackups()` converts a
  plaintext `backups/*.db` into a `.dknvbak` bundle by calling
  `buildEncryptedSnapshot` with no stamp, so the enclosed image is a v1
  envelope. A backup is a point-in-time copy that no process ever holds a lock
  for, so there is no writer token to bind and nothing to fence; the bundle is
  written once and read once. Do not treat a v1 envelope inside a `.dknvbak` as
  malformed or as an un-migrated live snapshot.

Both snapshot contexts and the wrap context are frozen string literals in
`format.ts`. The `v1` and `v2` are written out rather than interpolated from a
version constant, so a later format bump adds a builder instead of moving a
context that released bytes are sealed under. The v2 envelope makes the
machine-detectable half of the #280 window ADR-0012 leaves open — "the new
owner can briefly believe in a version it does not hold on disk" — by making
the writer's stamp testable after the rename; the lock's `assertHeld()` and the
write guard are the other half. ADR-0008 §4.5 owns the format canon, so the
second envelope is recorded here rather than in an ADR of its own.

**What is encrypted.** The database is the only shop-data file: the runtime is
an in-memory SQLite image and every persisted byte is an encrypted snapshot
(`dokan.db.enc`), so there is no plaintext database and no WAL on disk. Daily
and manual backups write a self-contained bundle (the encrypted snapshot plus
the `vault.json` key wraps) so the file unlocks on another install; validation
decrypts the embedded snapshot and runs `PRAGMA quick_check`. `vault/vault.json`
holds only
wrapped keys and format metadata; `vault/state.json` holds only the unlock
throttle counters. Logs remain plaintext operational diagnostics and are
engineered never to contain a secret or a wrapped key; the stick-takeover
threat model is about the data, and logs are excluded deliberately.

**Single writer (issue #142).** The vault data folder is guarded by an
exclusive lock file (`vault.lock`, created with `O_CREAT | O_EXCL` — atomic on
NTFS, SMB/UNC shares and local POSIX filesystems) acquired before any vault
file opens and held for the process lifetime. The holder records
`{pid, host, startedAt, heartbeatAt, token}` and heartbeats every 10s; a second
instance serves an Arabic "data in use" page and never touches the data. A lock
left by a hard-killed process is reclaimed once the same-host PID is gone, or —
for a stick moved to another machine — once the heartbeat is quiet for 60s. A
lock file that cannot be created (read-only media, permissions) fails the boot
loudly instead of silently running unlocked, and losing the lock while running
is fail-stop.

**Migration.** A legacy plaintext `dokan.db` is checkpointed out of WAL,
`quick_check`ed, schema-gated (newer refuses), serialized, adopted into memory,
written as the encrypted snapshot, and only then is the vault header committed;
the plaintext files are deleted last. `PRAGMA user_version` travels inside the
image, so the schema version is preserved. A crash before the header commit
leaves the plaintext install untouched and retryable.

**Persistence.** Every committed store unit and every mutating store call
serializes → encrypts → writes the snapshot through a temp file + fsync +
rename; `close()` awaits the persist queue and checkpoints it, and backup copies
write a **self-contained bundle** (key wraps + snapshot) so an exported backup
unlocks on another install. A failed write stays dirty and is retried; if it
still fails, the process fails stop (never reporting a committed unit as
failed, which a retry would duplicate). A missing snapshot and a torn/damaged
one are distinct Arabic refusals (`VAULT_DATABASE_MISSING`, `VAULT_CORRUPT`) with
restore guidance, never a wrong-passphrase message. Legacy plaintext cleanup is
retried on every unlock until the file is gone.

**Recovery flow.** A forgotten passphrase is fixed from the recovery key alone:
`POST /api/vault/reset-passphrase` unwraps the master key with the recovery code
and re-wraps a new passphrase, no current passphrase required. The last recovery
key cannot be deleted, and changing the passphrase or deleting a key rotates
the in-process session token (the pre-rotation token is refused).

**Round-3/4 hardening.** Migration converts historical plaintext backups
under `backups/` to `.dknvbak` bundles (only each candidate's 16-byte magic is
read; converted names are never rescanned, so unlocks stay fast on a large
history; a file that cannot be converted is reported back and shown in the
setup screen, never silently ignored). A first-run attempt whose header write
failed is resumable (`resumeSetup`), but only after the requester proves the
pending passphrase, so an unauthenticated caller can never receive the first
owner's recovery key or session token. The first daily backup runs after the
header commit. Logout revokes the server-side session token, so a copied token
dies immediately. The app distinguishes a legacy build (404 on the status
route) from an unreachable vault API, which shows a retry screen instead of the
legacy login.

**Gate transport.** Dev and e2e use the same-origin HTTP gate (`/api/vault/*`)
served by the locked sidecar; the desktop window opens on the vault screen and
the app routes and the store start only after unlock. In a packaged build the
shell launches the sidecar with `DOKAN_VAULT_STDIN=1` and carries the
pre-boot prompt over the child's stdin pipe through Tauri IPC commands
(`vault_unlock`, `vault_setup`, `vault_unlock_recovery`, `vault_status`, plus a
key-saved acknowledgement): the API then refuses the HTTP credential routes
(`VAULT_BROKER_REQUIRED`), so the one secret that decrypts everything never
crosses the network stack, argv, the environment or disk. The status route
advertises `broker: true` and the gate UI uses IPC whenever it sees that flag
(the browser keeps HTTP). A recovery-authorised reset also has a pipe command
(`vault_reset_passphrase`) because settings needs it while the HTTP route is
refused. The setup reply carrying the one-time recovery key is written BEFORE
the legacy plaintext sweep, and the sweep verdict follows as a second framed
message on its own, longer budget (`vault_setup_warning`): confirmed clean,
confirmed remaining paths, or UNKNOWN when the sweep threw or the shell never
heard back. Unknown keeps the owner warned with a manual-verification message
and never masquerades as a clean result, so a slow sweep can neither cost the
key nor hide plaintext data. Logout replaces the one-shot
child with a freshly verified sibling (`vault_logout`), so the reloaded gate
can unlock over the pipe again without an app restart, and every respawn
repeats the reservation plus token/registry identity checks the first launch
performs. The reply wait is bounded by a timeout and never holds the state
lock, so a silent child cannot block shutdown; a shutdown flag makes launch and
shutdown mutually exclusive, so a respawn that races window close cannot leave
an orphan sidecar holding the vault lock. Keeping all cryptography in one
implemented module (rather than duplicating Argon2id in Rust) is what makes the
transports provably identical.

**Owner identity seam.** Unlocking mints an in-process session token returned to
the client; the router accepts it over the `x-vault-session` header as the
owner. The auth layer itself is unchanged for the legacy build, and employee logins can later sign in after
the vault is open without touching the vault.

**Dev/e2e escape hatch.** `DOKAN_VAULT=disabled` keeps the phase-1 plaintext
path for development and the existing e2e suite; the packaged desktop shell
never sets it, and any value other than the exact string `disabled` keeps
encryption on.

## 5. Interfaces / files (indicative)

- `apps/api/src/lib/recovery.ts` — generate/verify codes, hashing, the 5-code rule.
- `apps/api/src/lib/reset-token.ts` — verify a signed reset token against embedded
  public keys.
- `apps/api/src/lib/schema-version.ts` — read/write/compare the schema version.
- `apps/api/src/db/schema.ts` — `recovery_codes` table (or `settings` entries);
  `schema_version`.
- `apps/api/src/config.ts` / `main.ts` — read the signing secret from the DB; drop the
  baked-secret boot guard.
- Vendor tooling (repo `tools/`): `reset-tool` — sign a challenge with a private key,
  versioned. Ships to the vendor only; the private keys are never committed.
- Removal (complete): `apps/desktop/scripts/secrets.ts`; the per-customer `.env*`
  handling; `DOKAN_CUSTOMER_SLUG`; `config.buildSecret` / `config.authSecret` /
  `DEV_AUTH_SECRET`; the `main.ts` sentinel boot guard and inline-secret fills;
  `auth/admin.ts`'s build-secret checks; the `firstTimeSetup` / `resetAdminPassword`
  handlers that require it; `playwright.config.ts`'s `DOKAN_BUILD_SECRET`; `docs/ci.md`
  and `docs/development-workflow.md` §5 references; `release.ts` validation; the
  related tests; the `.gitignore` entries.
- **Keep** the build-time sidecar freshness check (cargo `rerun-if-changed` on the API
  and contract sources, plus the binary hash) — stale-sidecar bundling is a separate
  bug class. Remove only its **secret** coupling (the secret-hash stamp and
  `rerun-if-env-changed` on secret vars). The ADR should say "secret stamp", not
  "freshness stamp".

## 6. Tests

- Unit: code generation/hash/verify; the 5-code rule; single-use; last-code
  replacement; reset-token verify per key version (valid, wrong version, expired,
  reused).
- Integration: fresh DB generates one signing secret; a copied DB keeps sessions;
  schema-version gate (older migrates, newer refuses).
- E2E: first-run shows a recovery code; reset with a code; reset with a signed token.
- Also: persisted rate limiting; session revocation after reset; import swap/reopen
  with stale WAL; per-customer-DB migration; the entropy floor; legacy reset; vendor
  issuance abuse (a token for another install/version is rejected).

## 7. Risks / open questions

- **Boundary (resolved):** the unified vault (§4.6) encrypts the data folder, so a
  copied stick is useless without the passphrase or the recovery key. This closes the
  takeover path. The residual is the forgotten-passphrase case, mitigated by the
  recovery key and stated plainly at first run.
- **Key custody:** the vendor must keep every private key, with offline redundant
  escrow and a rotation runbook (§4.4).
- **Code hashing:** decided — Argon2id (§4.3).
- **Existing installs:** a shop on a per-customer build already has a `data/` folder
  with no stored session secret. On first open of an existing database the universal
  build generates and stores the secret if missing (invalidating old sessions once)
  and offers a recovery code **only after the owner logs in** (§4.2).

## 8. Alternatives considered

- **Keep per-customer builds** — rejected: the update cost is the whole problem.
- **OS-bound secret (DPAPI)** — rejected: breaks portability.
- **Vendor fallback as a hash** — rejected: a hash needs no secret, so anyone could
  forge a reset.
- **Encrypt the whole database** — deferred: it just moves the key-storage problem.
