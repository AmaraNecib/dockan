# One universal build — Phase 1 design

Contract: `docs/adr/0008-one-universal-build-and-recovery.md` and
`docs/one-build-and-recovery.md`. Phase 1 only: no vault, no recovery key, no
vendor reset tool, no import UI.

Base: `origin/develop` (ce1fd0e). Note: PR #117 (`feat/release-secret-defaults`)
is NOT merged, so its extra machinery (`secrets.ts`, `.env.<slug>`, the
`sidecar-freshness` crate, the secret-hash stamp) does not exist here. The
removal list is applied to what the base actually contains; the freshness check
is added secret-free so the end state matches the design.

## Public interfaces

- `apps/api/src/lib/session-secret.ts`
  - `SESSION_SECRET_SETTING_KEY = "auth_secret"`
  - `generateSessionSecret(): string` — 32 random bytes, base64url.
  - `ensureSessionSecret(store: StorePort): Promise<string>` — generate + store
    in one `withTransactionImmediate` unit only when the key is absent/empty;
    an existing value is never replaced.
- `apps/api/src/lib/schema-version.ts`
  - `CURRENT_SCHEMA_VERSION = 1`
  - `readSchemaVersion(raw: Database): number` (`PRAGMA user_version`)
  - `assertSchemaVersionSupported(raw): number` — newer than the app throws
    `UnsupportedSchemaVersionError` with the Arabic refusal.
  - `stampSchemaVersion(raw): void`.
- `StorePort.databaseIsEmpty(): Promise<boolean>` — true only when every
  shop-record table is empty (items, invoices, invoice_lines, payments,
  customers, suppliers, expenses, returns, return_lines, stock_movements,
  stock_links). Seed rows (categories, expense categories, settings, sequences,
  migration markers, activities) do not count.
- `createAuth(db, config, sessionSecret: string)` — the API signs sessions with
  the database-backed secret.
- `firstTimeSetup` input loses `secret`; `authResetPassword` and
  `resetAdminPassword` are removed (recovery is a later lane).

## Behavior

- Boot order: `openConnection` refuses a newer database; `store.setup()` applies
  the forward `ALTER`s and stamps `user_version`; `ensureSessionSecret` then
  runs before `createAuth`.
- `needsSetup` = no owner AND `databaseIsEmpty()`.
- `firstTimeSetup` refuses `SETUP_ALREADY_DONE` when an owner exists,
  `SETUP_DATABASE_NOT_EMPTY` when shop records exist without one; both checks
  repeat inside the provisioning transaction.
- A pre-universal DB (user_version 0, owner present) migrates silently: the
  signing secret is generated once (old sessions invalidate) and no recovery
  credential is handed out.

## Dependencies

No new packages. `crypto.randomBytes` for the secret; existing better-auth,
drizzle, bun:sqlite.

## Planned tests

- Unit: `session-secret.test.ts` (generated strength, never regenerated,
  concurrent convergence, no recovery credential emitted).
- Unit: `schema-version.test.ts` (0 read, stamp, newer refuses with Arabic,
  older DB migrates through `setup()` and is stamped).
- Unit: store `databaseIsEmpty` (seed-only DB true, any shop record false).
- Wire: router `firstTimeSetup` on empty DB provisions; on non-empty ownerless
  DB refuses and writes no user; race/rollback unchanged minus the secret.
- E2E: setup form no longer has the secret field (`auth-helpers.ts`).
- Desktop: `requestedTarget` unit tests; `bun run typecheck && lint && test`.

## Risks

- Empty-DB detection must exclude seed rows or provisioning would be impossible
  (daily backup activity, seeded categories/settings). Fixed table list above.
- `PRAGMA user_version` on a fresh DB is 0, which is also the "oldest" marker:
  stamping after setup is what separates fresh-pre-migration from migrated.
- Removing the reset path removes the only password-recovery route until the
  recovery lane lands; that is the scoped decision, stated in the docs.
- Freshness check in `build.rs` is added (PR #117 absent): rerun-if-changed on
  API/contract/lock inputs plus a source+binary fingerprint stamp, no secrets.
