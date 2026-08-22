# Ticket 01 — Code review (Standards + Spec, local diff main...HEAD)

Diff reviewed: git diff main..HEAD (docs + scaffold + store). Key findings, all fixed in-tree:

1. FK enforcement was absent: SCHEMA_DDL created tables without REFERENCES, so the FK test exposed a real gap. Fixed by adding REFERENCES to items, invoice_lines, payments, session, account. Test now requires the rejection.
2. Same-second activity ties sorted by random id. Fixed with insertion-order rowid tiebreak.
3. drizzle `.get()` row shape was array-like on bun-sqlite; all reads moved to typed select builders, which also removed every raw-row cast, the snake-to-camel mapping, and the `unknown` plumbing. Rows now parse through zod at the adapter boundary (anti-slop requirement).
4. `updateItem` accepted a patch where the caller also passes the id; guard for zero returned rows returns undefined, which the test asserts.
5. Transaction scope: `withTransaction` runs on the single bun:sqlite connection; documented in the design as a postgres-adapter revisit point (ADR-0003).

Remaining notes: invoice page returns at most 200 rows with no cursor; invoice-number lexicographic limits beyond 9999; both are MVP-scope calls recorded in the spec, not defects.

Standards axis: matches CONTEXT.md vocabulary, ADRs 0001-0003 respected, StorePort seams held (no SQL outside the adapter). Spec axis: all five acceptance criteria of ticket 01 have a passing test or a schema assertion (better-auth tables exist, config driver switch, seed, roundtrips, backup copy).