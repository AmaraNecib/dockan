# #213 — `suppliersResolveName` composes the lean reads, not `listParties`

Tier: **Standard** (read-path optimization that feeds a money screen; not a bug).
Base: `origin/develop` @ `8a7a7fa` (== HEAD, no local commits).

## Problem

#213 is a follow-up to #183 / #184. #183 added names-only reads —
`listPartyNames` and `listSupplierAccountSummaries` — so the opening-balance page
stops paying for the **invoice aggregate** that `listParties` computes (a
`LEFT JOIN invoices` + `GROUP BY`). #184 then added `suppliersResolveName`,
whose candidates are still built from `deps.store.listParties("supplier")`. The
read-only resolve path therefore reintroduces exactly the cost #183 removed.

The current reuse is *correct*: the resolver needs name + entry count, and it
gets exactly those. This is an optimization, not a bug fix, and it must not
change behaviour.

## Contract (unchanged)

`suppliersResolveName(input) -> { supplier: { id, name, accountEntryCount } | null }`.
The rule still lives once in `opening-balance-resolver.ts`
(`resolveOpeningDestination` / `pickOpeningSupplier`); this change only swaps the
data source that feeds `NamedSupplierCandidate[]`.

## Decision

In `apps/api/src/rpc/router.ts`, the `suppliersResolveName` handler composes:

- `deps.store.listPartyNames("supplier")` — identity (`id`, `name`), ordered by
  name, no invoice join;
- `deps.store.listSupplierAccountSummaries()` — `accountEntryCount` per supplier
  that carries an entry. A supplier absent from the summary has no entry, so its
  count defaults to `0` — the exact value `listParties` produced via
  `accountEntryCount ?? 0`.

The two reads run concurrently (`Promise.all`), matching the existing pattern at
`categoriesList` and the profit report. Both use `safeWhole(...)` for the count
(`drizzle-store.ts`), so the composed value is bit-identical to `listParties`'.

No new store method, no contract change, no web change. `listParties` is
untouched (other screens still use it).

### Why compose in the router and not a new store seam

The issue explicitly asks for the composition. A new store method would be a
third lean seam to maintain and test, and would have to duplicate the
`id -> count` default. Keeping it at the call site makes the two source reads
visible to a caller-level test.

## Planned tests (TDD)

Added to `apps/api/src/rpc/router.test.ts`, next to the #184 resolve tests. The
#184 tests are the oracle and are **not edited**.

1. **Cost pin (the whole point).** A counting `StorePort` counts `listParties`
   calls and records the exact resolve reads. Assert `listParties === 0` and the
   reads are exactly `["names:supplier", "summaries"]`. This fails if the
   aggregate creeps back in.
2. **Empty store.** A store whose lean reads both return `[]` and whose
   `listParties` throws: the resolve must return `null`, proving the composition
   handles zero suppliers without touching the aggregate.
3. **No-match name.** With real data, a freshly typed unique name resolves to
   `null` (already covered by #184, but re-asserted against the lean path so the
   filter over `listPartyNames` is pinned).
4. **Byte-identical output over the oracle cases.** The existing #184 tests run
   through the new composition unchanged; if any expectation changes, behaviour
   changed.

An equivalence argument at the store level already exists
(`drizzle-store.test.ts`, #183): `listSupplierAccountSummaries` agrees with
`listParties` on `accountEntryCount`, including a **net-zero** account (count 2,
balance 0), which is the case a `HAVING balance <> 0` regression would silently
drop.

## Risks

- **Entry-count drift.** `listParties` counts via the invoice join's party rows;
  the summary counts `supplier_account_entries` directly. Both call `safeWhole`
  and the same signed-amount expression (#176/#183); the store equivalence test
  pins net-zero. Mitigated.
- **Order dependence.** `pickOpeningSupplier` / `lowestById` are order
  independent; `listPartyNames` keeps the same `ORDER BY name`, and the summary
  has no order requirement (looked up by id). Filtering order cannot change the
  winner.
- **Two reads instead of one.** The resolve path now issues two cheap queries
  instead of one expensive one. Acceptable; concurrency keeps latency flat and
  neither query touches invoices.
- **Collision with sibling #204** on `supplier-opening-balance.tsx`. Out of
  scope; no web file is edited.
