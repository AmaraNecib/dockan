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