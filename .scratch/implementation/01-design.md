# Ticket 01 — Persistence backbone: design

- **mode:** local-only (no GitHub)
- **ticket:** `.scratch/dokan-mvp/issues/01-persistence-backbone.md`
- **base SHA:** `8614c5c` (claim commit on `feat/01-persistence-backbone`)
- **review tier:** Standard
- **stack:** Bun workspaces; no build step; oRPC/Drizzle/Zod from `packages/contracts`

## Public interface

`StorePort` (in `apps/api/src/store/port.ts`) — the one persistence seam (ADR-0003).
Procedures and use cases depend on it; no SQL or driver names escape it.
Implemented by `createDrizzleStore(conn)` over bun:sqlite today, postgres later
behind `DOKAN_DB_DRIVER`. Config gains `db.driver` + `db.path`.

## Dependencies and ownership

- `db/connection.ts` owns the driver handle (bun:sqlite `Database` + Drizzle), WAL, foreign keys, checkpoint (backup), close.
- `db/schema.ts` owns table definitions + `SCHEMA_DDL` (CREATE TABLE IF NOT EXISTS + seed in `setup()`).
- Store owns all persistence behavior: entities, lists, filters, transactions, debt grouping, settings, backup copy.
- better-auth tables (`user`, `session`, `account`, `verification`) land in the schema now; the adapter wiring is ticket 02.

## Tests (TDD at agreed seams — spec: seam 2)

`apps/api/src/store/drizzle-store.test.ts` against sqlite `:memory:`:
setup+seed, better-auth tables exist, categories, items (create/update/low-stock/getByIds),
parties, invoice+line+payment insert + detail read + lastInvoiceNumber,
invoice list filters (kind/status/date), debt grouping both directions,
activities newest-first, settings upsert, backup copy opens standalone.

## Risks / constraints

- drizzle row-shape quirks on bun-sqlite (`db.get` returned array-shaped rows for single-column selects → read through `db.all`→`[0]` helper `g`).
- Single-connection transactions: `withTransaction` runs on the same bun:sqlite connection; revisit when the postgres adapter lands.
- No migration tooling yet (MVP `CREATE TABLE IF NOT EXISTS`); changes = additive DDL.
- Local-only: no push/PR. Evidence under `.scratch/reviews/01/`.