# 01: Persistence backbone (StorePort + sqlite adapter)

**What to build:** the app can store and retrieve every domain record through one port, and all later tickets hang off this. On first boot the database is created with all tables (including better-auth's user/session/account), a default category and default settings are seeded, and no code outside the adapter touches SQL.

**Blocked by:** None (can start immediately)

**Status:** claimed

**GitHub:** #3

- [ ] A single `StorePort` interface exists; no procedure or use case uses SQL or the driver directly
- [ ] bun:sqlite adapter creates/opens the database, applies the schema, enables WAL and foreign keys
- [ ] Driver is selected by config (`DOKAN_DB_DRIVER=sqlite`); an unknown driver fails with a clear message, callers unchanged (ADR-0003)
- [ ] Roundtrips for categories, items, parties, invoices, lines, payments, activities, settings and better-auth tables pass through the store seam against sqlite `:memory:`
- [ ] Seed: default category (عام) and default settings exist after first boot

## Answer

Implemented on `feat/01-persistence-backbone` (commit 08b4b54), local-only mode. `StorePort` seam in `apps/api/src/store/port.ts`, sqlite adapter `createDrizzleStore` on Drizzle + bun:sqlite. Typed drizzle selects with aliased camelCase columns; the single untyped aggregation (debt summaries) is cast once behind a SAFETY comment; every row entering and leaving the adapter is checked by its contracts zod schema. Config switch `DOKAN_DB_DRIVER` selects the driver (sqlite today, postgres adapter site in `db/connection.ts`). better-auth tables live in the schema for ticket 02. 14 store-seam tests green, oxlint/anti-slop clean, typecheck green. Evidence: .scratch/reviews/01/08b4b54-*.md. Greptile waived: no git remote (documented).

**Status:** resolved