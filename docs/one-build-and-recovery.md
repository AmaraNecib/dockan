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

**Decided at launch (not deferred)**
- **The portable vault.** Copying `data/` is a full takeover (§7), so the vault is not
  an optional extra. Ship it with the universal build, or explicitly accept the
  takeover risk. If shipped, document its own recovery model: a forgotten passphrase
  is unrecoverable, the recovery codes live inside it, and the vendor cannot decrypt it.

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

### 4.3 Recovery codes

- On account creation, generate **one** recovery code, show it once, ask the owner to
  save it.
- Store only a hash. **Decided: Argon2id** (the extra cost is negligible and it
  removes the "is SHA-256 enough?" question). Never store the plaintext.
- Rules: single-use; never expires while unused; **max 5** active codes.
- Using a code:
  - consumes it and, when it was the **last** active code, generates its replacement
    **in the same transaction** (a partial failure must not leave the owner with no
    active code); then
  - revokes every existing session (see 4.4).
- Generating more: only while authenticated as the owner (re-enter the password).
  At the 5-code limit, refuse with a clear message (or let the owner delete one).
- Never log a code; never show it again after the generation screen.
- **Entropy:** codes carry ≥ 128 bits, e.g. **26+ random base32 characters** (20 would
  be only 100 bits). Group them for transcription and add a checksum.
- **Hashing:** Argon2id; name the library and parameters in implementation (Bun's
  `Bun.password` or the better-auth hash — pick one).
- **Rate-limit, persisted:** attempts are limited **per install** and the counter is
  stored in the database (the existing in-memory throttle clears on restart). Backoff
  after 5 failures, shared across the code and token screens, failures written to the
  activity log.
- **Verify + consume are atomic:** a concurrent double-submit cannot redeem one code
  twice.
- **Invalidation:** changing the password invalidates all outstanding codes; using one
  code does not invalidate the others. At the 5-code limit, **refuse** with a clear
  message and let the owner delete one first.

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
  secret at boot), draining in-flight requests first. Migrations and the version stamp
  run in one transaction; if a post-swap migration fails, restore the backup.
- Version storage: use `PRAGMA user_version` (decided); a database with no version is
  treated as the oldest pre-universal format.

### 4.6 Portable vault (decided at launch)

A passphrase that encrypts the data folder (key derived from the passphrase, nothing
stored). Because copying `data/` is a full takeover (§7), this is **launch-blocking**,
not additive: either ship it with the universal build or explicitly accept the risk.
If shipped, document its own recovery model — a forgotten passphrase is unrecoverable,
the recovery codes live inside the vault, and the vendor cannot decrypt it.

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

- **Boundary (elevated):** the data (and the session secret) sit in plaintext on the
  stick, so anyone who copies `data/` can forge an owner session, edit the owner row,
  or re-run first-time setup — a full takeover, not just a read. The session secret is
  not the deciding control; the vault is. **Decided at launch** (§2): ship the vault,
  or explicitly accept the takeover risk.
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
