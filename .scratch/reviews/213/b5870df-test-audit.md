# Test audit — #213 at `b5870df1cc3c1a69a8844dc8bb904261acbde217`

Reviewed code SHA at audit time: `92fe41d` (first implementation), fixes applied
in `8d9d9bd`, one code-review note applied in `b5870df`. Three parallel
read-only sub-agents (edge-case hunter, coverage analyst, test-quality reviewer)
audited the diff `git diff 8a7a7fa...92fe41d` plus the surrounding #184 oracle
tests and the store seam.

## Acceptance criteria vs coverage

1. **Output byte-identical (#184 oracle).** The #184 resolve tests run unedited
   through the new composition. The store level already pins
   `listSupplierAccountSummaries == listParties` on `accountEntryCount` incl. a
   net-zero account (`drizzle-store.test.ts`). **Fix applied:** a new router-level
   equivalence test re-derives the classic `listParties` candidate set and asserts
   the resolver names the same id and count, incl. net-zero (`accountEntryCount
   === 2`, balance 0) — the case a balance-keyed regression would drop.
2. **Pins that the resolve path no longer calls `listParties`.** The counting
   store asserts `listPartiesCalls === 0` and the exact read set
   (`{names:supplier, summaries}`); the empty-store test booby-traps `listParties`
   to throw. **Fix applied:** the read set is asserted order-independently (the
   `Promise.all` order is an implementation detail), and the empty-store test now
   counts both lean reads so an early `null` cannot pass vacuously.
3. **No behaviour change to which supplier resolves.** Covered by the #184
   tie-break / entry-count / signature-holder tests plus the equivalence test.

## Findings and disposition

| # | Finding (agent) | Risk | Disposition |
|---|---|---|---|
| 1 | Cost pin guards the method name, not the SQL: a regression that re-joins invoices *inside* the lean reads would pass. Suggest capturing `db.all` SQL. | 🟠 | **Dismissed by repo standard.** `drizzle-store.test.ts` states persistence is "verified through StorePort against sqlite, **never SQL**". The aggregate is proven gone by (a) `listParties` never called and (b) the store test pinning `listPartyNames` to `{id, name}` keys only. |
| 2 | No router-level byte-identical comparison against `listParties`. | 🟠 | **Fixed** — new equivalence test. |
| 3 | Net-zero account (count 2, balance 0) not pinned at the router. | 🟠 | **Fixed** — equivalence test asserts `accountEntryCount === 2` for a net-zero supplier. |
| 4 | Id-join key type (`String(id)`) untested. | 🟠 | **Fixed indirectly** — the equivalence test pins count 2, so a lookup miss (which would report 0) is unambiguous. |
| 5 | Empty-store test is synthetic and `reads` unasserted there. | 🟡 | **Fixed** — both lean reads are counted (1 each). Kept synthetic because the shared file DB is never empty. |
| 6 | No-match test duplicates #184's fresh-name test. | 🟡 | **Kept** — the brief explicitly asks for no-match coverage and the test is cheap; it is the lean-filter pin. |

Test-quality reviewer graded the suite **B+/A−**, noted the cost pin "fails for
the right reason" and found **no vacuous passes**. The only over-pin
(`reads).toEqual([...])` on `Promise.all` order) was relaxed per its
recommendation.

## Evidence that the aggregate is gone, not merely cheaper

- `listPartiesCalls === 0` for a matching resolve.
- The empty-store path throws if `listParties` is reached, and issues exactly
  one `listPartyNames` + one `listSupplierAccountSummaries`.
- `listPartyNames` returns only `{ id, name }` (`drizzle-store.test.ts`), so no
  aggregate field can ride along.

## Commands

```
apps/api: bun test src/rpc/router.test.ts            # 238 pass, 0 fail
apps/api: bun test src/rpc/router.test.ts -t "issue 213"  # 4 pass, 0 fail
```
