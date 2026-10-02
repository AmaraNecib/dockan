# One universal build: first-run secrets, recovery codes, and a versioned reset key

The release pipeline currently bakes a per-customer session-signing secret and a
per-customer provisioning secret into the sidecar at build time. That forces a
separate build and a separate installer for every shop, and it makes each update a
per-shop rebuild. The secrets are also extractable from the binary, and the app is
**portable** (with `portable.marker`, all data lives in `data/` beside the exe), so
the USB stick — not the build — is the real trust boundary.

We decided:

- Ship **one universal build with no baked secrets**.
- Generate the **session-signing secret at first run** and store it in the database
  (`settings`), so it travels with the portable data. Copying or restoring the
  database preserves sessions.
- Recover access with **single-use recovery codes** (max 5, only their hashes
  stored, shown once when generated; using the last one generates a replacement;
  generating more requires the owner's password).
- Keep a **vendor fallback**: a challenge–response where the app shows a device
  challenge and the vendor signs it with a **versioned** private key. The app ships
  the matching **public** keys (not secret), so this does not reintroduce
  per-customer builds. The vendor keeps every private-key version forever, so an old
  install can always be reset with the key version it accepts.
- Store a **schema version** in the database and gate imports on it (older →
  migrate forward; newer → refuse with a clear message).

Consequences worth remembering: one build serves every shop and updates are a single
artifact; the per-customer `.env` files, the **secret-hash** sidecar stamp, and the
"inherited vs explicit secret" detection are removed (the build-time source/binary
freshness check stays); copying the portable data folder is a full takeover, so the
**passphrase vault is a launch decision, not a later option**; and the vendor becomes
the custodian of a set of signing keys that must never be deleted.
