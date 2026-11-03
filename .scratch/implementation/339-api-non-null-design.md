# #339 — API production files, `no-non-null-assertion` burn-down (lane slice)

## Scope

Four `apps/api` production files initially carried an `oxlint.config.ts` override for
`typescript/no-non-null-assertion`:

- `apps/api/src/rpc/router.ts`
- `apps/api/src/lib/port-record.ts`
- `apps/api/src/lib/stock-posting.ts`
- `apps/api/src/lib/vault/reclaim-retry.ts`

The overrides for `port-record.ts`, `stock-posting.ts`, and `reclaim-retry.ts`
have since been removed. `router.ts` still has its override. #339 remains a
partial burn-down.

The final API slice also includes the defensive refusal-copy repair and its tests in
`apps/web/src/lib/i18n.ts` and `apps/web/src/lib/i18n.test.ts`. No other
`apps/web` files, no `*.test.ts` override, no `packages/`, `scripts/`, `tests/`,
or `tools/`.

## Measure

At the #339 baseline (`e601939`), `oxlint.config.ts` had **75** per-file overrides.
Current HEAD has **72**, so three have been removed. The `router.ts` override
remains. This is progress, not completion of #339. A file loses its override
only in the same commit that leaves it genuinely clean — the rule then protects
it for good.

## Review tier

**High-assurance.** This slice touches sale and purchase posting, FIFO stock
snapshots, and weighted-average cache updates. A bad item resolution could post
stock against the wrong item or valuation; type-level narrowing does not lower
that write-path risk.

## Public interfaces

Unchanged. No export is added, removed or re-shaped:

- `port-record.ts` — `isWildcardBindHost`, `probeHostFor`, `portIsReachable`,
  `withPortFileLock`, `writeRegistryEntry`, `readRegistryEntry`,
  `recomputeCanonical`, `publishPort`, `forgetPort`.
  `parseIpv4Quarter` is module-private; its return type narrows from
  `number[] | null` to `readonly [number, number] | null`, which is the point:
  the tuple says "two words or nothing" in the type, not in a comment.
- `stock-posting.ts` — `recordStockMovements`, `recordStockMovement`,
  `itemStockProjection`, `StockItemMissingError`.
- `reclaim-retry.ts` — `ReclaimRetry`, `ReclaimRetryOptions`,
  `ReclaimAttemptResult`, `ReclaimTimerHandle`,
  `DEFAULT_RECLAIM_BACKOFF_MS`.
- `router.ts` — the oRPC router; its procedure set is unchanged.

## Dependencies

None added. No new package, no new module, no new seam.

## Planned tests

- Every touched module already has a unit test that covers the touched code
  (`port-record.test.ts`, `stock-posting.test.ts`, `reclaim-retry.test.ts`,
  `router.test.ts`). Those run at every commit.
- A behaviour change needs a test that **fails before the change**. Only an
  assertion that was hiding a real absence qualifies, and that fix is an
  explicit refusal with its own test.
- No new Playwright spec: nothing in this slice changes a user-facing flow.

## Risks

1. **The retry schedule is a construction-time snapshot.** Mutating the
   caller's array before `start()` or after a timer is armed does not change the
   cadence. An empty schedule still fails at construction. Runtime retuning is
   not supported; it would need an explicit API. Tests pin both mutation points,
   cap repetition, and cancellation.
2. **An assertion was load-bearing.** Then the "honest fix" is a refusal, not a
   cast, and the refusal needs a test that is red on the parent.
3. **Router.ts is 2410 lines with 31 assertions.** It is taken in batches, one
   commit per batch, so a reviewer can read it a section at a time. If it
   hides real bugs in a dozen places, the small files land first and the rest
   is reported as measured-but-open.
