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
- Password reset works without a per-customer build and without a readable secret on
  the stick.
- Old installs remain resettable forever.

**Non-goals (for now)**
- Encrypting the whole portable folder. The stick is the boundary; an optional
  passphrase vault is a later, additive feature.
- Multiple user accounts. The model below is owner-centric and extends cleanly.

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

### 4.2 First run

- On a fresh database, generate a strong random **session signing secret** and store
  it in `settings` (e.g. `auth_secret`). Never regenerate it on later runs.
- If the database is copied/restored, the secret comes with it → sessions survive.
- The secret is a normal row in the portable database; the stick is the boundary
  (see §7).

### 4.3 Recovery codes

- On account creation, generate **one** recovery code, show it once, ask the owner to
  save it.
- Store only a hash (Argon2id preferred; SHA-256 is acceptable for a long random
  code — decide in implementation). Never store the plaintext.
- Rules: single-use; never expires while unused; **max 5** active codes.
- Using a code:
  - consumes it (mark used), then
  - if it was the **last** active code, immediately generate and show a replacement.
- Generating more: only while authenticated as the owner (re-enter the password).
  At the 5-code limit, refuse with a clear message (or let the owner delete one).
- Never log a code; never show it again after the generation screen.

### 4.4 Vendor fallback (challenge–response)

1. The app shows a **device challenge**: random nonce + install id + the key versions
   this build accepts.
2. The owner sends it to the vendor.
3. The vendor signs it with the matching **private** key and returns a **reset token**
   (includes `keyVersion`, single-use, short expiry, e.g. 24h).
4. The app verifies the token with the embedded public key for that version and lets
   the owner set a new password.

**Key versioning.** The vendor keeps every private key, forever. A new build embeds
the current public key version; older builds keep their own. To reset an old install,
the vendor signs with the key version that install accepts. Rotating a key never
breaks the ability to reset an old install.

### 4.5 Schema version and import

- Store a **schema version** in the database (`PRAGMA user_version` or a `settings`
  row). Bump it with each forward change.
- On open: older → apply forward `ALTER`s (the existing pattern) and stamp the new
  version; newer → refuse with a clear Arabic message; run `PRAGMA quick_check` on an
  imported file first.
- Import is a first-class action: back up the current database, verify integrity,
  check the version, show a preview, then swap.

### 4.6 Optional later: portable vault

A passphrase that encrypts the data folder (key derived from the passphrase, nothing
stored) for owners who carry the stick around. Additive; not part of this change.

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
- Removal: `apps/desktop/scripts/secrets.ts`, `sidecar-freshness` crate,
  `apps/desktop/.env*` handling, `DOKAN_CUSTOMER_SLUG`, the freshness stamp and its
  TS/Rust golden, the related tests.

## 6. Tests

- Unit: code generation/hash/verify; the 5-code rule; single-use; last-code
  replacement; reset-token verify per key version (valid, wrong version, expired,
  reused).
- Integration: fresh DB generates one signing secret; a copied DB keeps sessions;
  schema-version gate (older migrates, newer refuses).
- E2E: first-run shows a recovery code; reset with a code; reset with a signed token.

## 7. Risks / open questions

- **Boundary:** the data (and the secret) sit in plaintext on the stick. Accepted;
  the optional vault (§4.6) is the mitigation. Decide whether to offer it at launch.
- **Key custody:** the vendor must keep every private key. Document an offline backup
  and a rotation runbook.
- **Code hashing:** Argon2id vs SHA-256 — decide in implementation (long random codes
  make SHA-256 defensible; Argon2id is safer if codes are shorter).
- **Existing installs:** how a shop currently on a per-customer build moves to the
  universal build (migration path and session invalidation).

## 8. Alternatives considered

- **Keep per-customer builds** — rejected: the update cost is the whole problem.
- **OS-bound secret (DPAPI)** — rejected: breaks portability.
- **Vendor fallback as a hash** — rejected: a hash needs no secret, so anyone could
  forge a reset.
- **Encrypt the whole database** — deferred: it just moves the key-storage problem.
