# #339 — API production files, `no-non-null-assertion` burn-down (lane slice)

## Scope

Four `apps/api` production files that carry an `oxlint.config.ts` override for
`typescript/no-non-null-assertion`:

- `apps/api/src/rpc/router.ts`
- `apps/api/src/lib/port-record.ts`
- `apps/api/src/lib/stock-posting.ts`
- `apps/api/src/lib/vault/reclaim-retry.ts`

Nothing else. No `apps/web`, no `*.test.ts` override, no `packages/`, `scripts/`,
`tests/`, `tools/`.

## Measure

The override count in `oxlint.config.ts`: **75 → 71**. A file loses its override
only in the same commit that leaves it genuinely clean — the rule then protects
it for good.

## Review tier

**Standard.** The intended change is a type-level narrowing, not a behaviour
change: every value the assertions guarded was already proven present by the
surrounding code, and the rewrite makes the proof visible to the compiler.

**Escalation:** if an assertion turns out to hide a value that can really be
absent at runtime, the fix is an explicit refusal plus a test, and that case is
**High-assurance** (money math for `stock-posting.ts`).

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

1. **The rewrite changes behaviour.** The parsers and the retry schedule have
   edge cases (an empty IPv6 half, a single-spec posting batch, a schedule
   that is exhausted). The existing tests pin them; a silent change would show
   up there.
2. **An assertion was load-bearing.** Then the "honest fix" is a refusal, not a
   cast, and the refusal needs a test that is red on the parent.
3. **Router.ts is 2410 lines with 31 assertions.** It is taken in batches, one
   commit per batch, so a reviewer can read it a section at a time. If it
   hides real bugs in a dozen places, the small files land first and the rest
   is reported as measured-but-open.
