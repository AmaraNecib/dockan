# Ticket 01 — Formal two-axis code review (aggregate)

Ran the code-review skill: two parallel reviewer sub-agents, Standards and Spec, against `git diff main...HEAD`, evidence generated after the review fixes.

## Standards

Correct: ADR-0003 port discipline holds (port exposes only contracts types; connection and drizzle-store are the only driver-aware files). logger.ts replaced the open dictionary with a fixed LogContext. errors.ts dropped the unbounded extra param. Contracts exports z.infer types only.

Findings, all fixed:

- Hard (low): ADR-0003 and comments presented DOKAN_DB_DRIVER as the swap switch, but config hardcoded sqlite. Fixed: config reads the env var, validates against a supported-driver list, errors on junk.
- Duplicated Code (judgement): enum tuples in schema.ts duplicated the contracts zod enums. Fixed: contracts exports the tuples once, zod enums are built from them, schema imports them.
- Speculative Generality (judgement): better-auth tables and the postgres branch sit unused. Kept by design: both are ticket 02 and ADR-0003 scope, documented in the design doc.
- Duplicated Code (judgement, minor): aliased selects and returning() mappers each list table fields. Accepted: typed selects are the point; a mapper layer would hide the enrichment.

## Spec

Correct: StorePort seam, setup idempotence, seed (عام + settings), WAL + foreign keys, unknown-driver throw, 14 roundtrips against :memory:.

Findings, all fixed:

- Missing (medium): DOKAN_DB_DRIVER switch was partial. Fixed in config as above; unknown-driver throw now reachable.
- Missing (low): main.ts opened raw SQLite for the smoke check, bypassing the seam. Fixed: main.ts now boots through openConnection + store.setup(); health reports driver and dbPath. No SQL outside the adapter anymore.
- Implemented but weak: debt summary coerced an unknown kind to PURCHASE silently. Fixed: throws on any value outside SALE/PURCHASE.
- Note (not fixed, recorded): debt grouping keys on COALESCE(id, name), so two parties sharing a name collapse. Accepted for MVP, flagged as a follow-up if the owner reports wrong groupings.

Scope creep (minor, accepted): logger/errors cleanup and the boot migration were within the ticket's cleanliness intent.

Each axis produced findings; none were blockers. All findings were addressed before this evidence was written, and the guard (typecheck, 14 tests, oxlint) is green on the final HEAD.