## Review

Scope reviewed: `apps/api/src/**` and `packages/contracts/src/**`. Other files (tools/, .scratch/, docs/, anti-slop) ignored per instructions as they are outside source scope.

**Correct**
- `StorePort` seam (`apps/api/src/store/port.ts`) is a clean interface; `drizzle-store.ts` is the only driver owner (ADR-0003). Typed aliased selects + `satisfies` mappers are coherent.
- setup() applies `SCHEMA_DDL` idempotently and seeds default category `عام` + `storeName`/`storePhone` (`drizzle-store.ts` setup). Matches ticket: "Seed: default category (عام) and default settings exist after first boot."
- WAL + foreign keys enabled in `connection.ts`; unknown driver throws a clear message. Roundtrips are covered by 14 `drizzle-store.test.ts` tests against `:memory:`.

**Missing / partial**
- Ticket: *"Driver is selected by config (`DOKAN_DB_DRIVER=sqlite`)"*. `config.ts` hardcodes `driver: "sqlite"` and never reads `process.env.DOKAN_DB_DRIVER`; `AppConfig.db.driver` is typed `"sqlite"` (a literal, not an enum). The unknown-driver throw in `connection.ts` is unreachable because config can never produce a non-sqlite value. The requirement is only partially wired — the env switch does not exist yet. Severity: medium.
- Ticket: *"no procedure or use case uses SQL or the driver directly"* + ADR-0003 *"no code outside the adapter touches SQL."* `main.ts` still opens `new Database(...)` and runs a `smoke` table insert/select directly, bypassing the seam. This is pre-existing (diff only adds a SAFETY comment), but it contradicts the ticket's "one seam / no outside SQL" claim and was not migrated. Severity: low.

**Implemented but questionable**
- `debtSummaries()` groups by `COALESCE(counterparty_id, counterparty_name)` — two distinct parties sharing a name collapse into one row, and a party keyed by id is never merged with a same-named id-less row. Matches "grouped by person" only loosely; acceptable for MVP but worth a follow-up.
- `kind: r.kind === "SALE" ? ("SALE" as const) : ("PURCHASE" as const)` silently coerces any unexpected value to PURCHASE (schema constrains it, but the hard fallback hides data corruption).

**Scope creep (minor):** `AppError.extra` removal and the `logger.ts` `LogContext` refactor are cleanup not called for by ticket 01; harmless but extra surface.

No blockers. Recommendations: read `DOKAN_DB_DRIVER` in config (ticket requirement) and migrate/remove the `main.ts` smoke bootstrap out of the seam.