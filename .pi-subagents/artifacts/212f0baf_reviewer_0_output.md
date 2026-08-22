## Review

Reviewed diff `main...HEAD` restricted to `apps/api/src/**`, `packages/contracts/src/**`, `oxlint.config.ts`, package.json, against CONTEXT.md + ADR-0001..0003 + README. Ran `bun test` on the store seam: 14 pass / 0 fail. plan.md/progress.md don't exist at repo root.

**Correct (evidence):**
- ADR-0003 port discipline holds: `port.ts` exposes only contracts types; `connection.ts`/`drizzle-store.ts` are the only driver-aware files. `drizzle-store.ts:5` doc confirms "the only place that knows the driver."
- `logger.ts` replaces the `[key: string]: unknown` free dictionary with a fixed `LogContext` + nested `context` — directly removes an unsafe-dictionary antipattern.
- `errors.ts` drops the unbounded `extra` param; `contracts/core.ts` adds `z.infer` types (API imports types, never z).

**Hard violation — doc standard mismatch (low):**
- ADR-0003 and comments (`connection.ts:42`, `port.ts:27`) present `DOKAN_DB_DRIVER` as the swap switch, but `config.ts:27` hardcodes `driver: "sqlite"` and never reads `DOKAN_DB_DRIVER`. Setting the env var is a no-op. The comment "Swap via DOKAN_DB_DRIVER…" is misleading; either wire it or soften the comment.

**Baseline smells (judgement calls):**
- **Duplicated Code** — `schema.ts:6-24` enum tuples `invoiceKinds/paymentMethods/activityTypes` duplicate the zod enums in `contracts/core.ts`; comment says "keep these tuples in sync with core.ts when an enum grows." Two sources of truth needing manual sync (also a Divergent-Change risk).
- **Speculative Generality** — `schema.ts:113+` better-auth tables (`user/session/account/verification`) added to drizzle schema *and* `SCHEMA_DDL`, created at boot and asserted in tests, yet unused by any store code ("ticket 02 wires the adapter; schema lands here now").
- **Speculative Generality** — `connection.ts:14-43`: `if (driver === "sqlite"){…} throw` dead branch; ADR-0003 itself says the port is "real the day the second adapter lands," and config can only yield `"sqlite"`.
- **Duplicated Code** (minor) — `drizzle-store.ts` `*Cols` aliases + `to*` mappers (toItem/toInvoice/toCategory…) each repeat a table's field list in tandem.

**Notes:**
- `main.ts` still boots on the raw smoke sqlite and doesn't wire the new store/connection into startup — backbone not connected to boot yet (remaining work, not a violation).
- `AppConfig.db.driver` is a `"sqlite"` literal union — harmless now.

No blockers.