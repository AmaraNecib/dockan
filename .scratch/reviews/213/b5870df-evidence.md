# Evidence — #213 at `b5870df1cc3c1a69a8844dc8bb904261acbde217`

- **Issue:** #213 — `suppliersResolveName` should use the lean reads, not
  `listParties`.
- **Tier:** Standard (read-path optimization feeding a money screen; not a bug).
- **Base:** `origin/develop` @ `8a7a7fa` (merge-base == HEAD at start; brief's
  pinned base).
- **Reviewed code HEAD:** `b5870df1cc3c1a69a8844dc8bb904261acbde217`.
- **Branch:** `feat-213-resolver-lean-reads` (local, **not pushed**).
- **Design:** `.scratch/implementation/213-design.md`.

## Commits (vs base)

| sha | subject |
|---|---|
| `92fe41d` | perf(api): resolve the opening-balance name from the lean reads (issue 213) |
| `8d9d9bd` | test(api): close the #213 test-audit gaps |
| `b5870df` | test(api): fold-assert the #213 equivalence fixture ← reviewed code |
| (this docs commit) | docs(reviews): #213 test-audit, code-review and guard evidence |

## Files changed vs base

```
 apps/api/src/rpc/router.ts          (suppliersResolveName composes the two lean reads)
 apps/api/src/rpc/router.test.ts     (4 new tests; #184 expectations untouched)
 .scratch/implementation/213-design.md
 .scratch/reviews/213/b5870df-test-audit.md
 .scratch/reviews/213/b5870df-code-review.md
 .scratch/reviews/213/b5870df-evidence.md
 .agents/wisdom/2026-10-15-cost-pin-proves-the-call-not-the-query.md
```

No contract, store, schema, or web change. `apps/web/src/pages/supplier-opening-balance.tsx`
is untouched (sibling #204 lane owns it).

## What changed

`suppliersResolveName` built its candidates from `deps.store.listParties("supplier")`,
so the read-only resolve path paid the invoice `LEFT JOIN` + `GROUP BY` that
#183 introduced the names-only reads to avoid. It now composes
`listPartyNames("supplier")` (identity) with `listSupplierAccountSummaries()`
(entry count) under `Promise.all`; a supplier absent from the summary defaults
to 0 — the exact `accountEntryCount ?? 0` the old read produced. The resolver
rule (`resolveOpeningDestination` / `pickOpeningSupplier`) and the output shape
are unchanged.

## Guard Phase 1 — pre-commit

| command | result |
|---|---|
| `bun run typecheck` | exit 0 (3 successful) |
| `bun run lint` | exit 0 |
| `bun run test` | exit 0 |

## Guard Phase 2 — pre-push (final tree)

| command | result |
|---|---|
| `bun run typecheck` | exit 0 (3 successful) |
| `bun run lint` | exit 0 |
| `bun run test` | exit 0 — **api 911 pass / 0 fail** (3004 expect calls); web 1044 pass / 0 fail (unchanged, cached) |
| `bun run test:e2e` | **73 passed / 0 failed / 0 not run** |
| working tree | clean of source changes |

E2E ran on an isolated pair with all four ports set:
`DOKAN_PORT=4671 DOKAN_WEB_PORT=5571 DOKAN_VAULT_PORT=4672
DOKAN_VAULT_WEB_PORT=5572 bun run test:e2e` → 73 passed in 6.8m, **no flaky
spec, no rerun needed** (no contention this run). The generated `.dokan-port`
marker was restored to its committed value `4317`.

Rust Core not touched, so no cargo step.

## Issue asks

1. **Compose the lean reads.** `listParties` is gone from the resolve handler;
   the two names-only seams carry identity + entry count.
2. **Byte-identical output (#184 oracle).** The #184 resolve tests are unedited
   and pass. Added a router-level equivalence test that re-derives the classic
   `listParties` candidate set and asserts the same id + count, incl. a net-zero
   account (count 2, balance 0).
3. **Pin that the aggregate cannot creep back.** Counting store asserts
   `listPartiesCalls === 0` and the read set; the empty-store test booby-traps
   `listParties` to throw and counts both lean reads.
4. **Empty-store and no-match paths.** Covered (empty store → `null` with both
   lean reads invoked; no-match → `null`).

## Reviews

- **Test audit:** `.scratch/reviews/213/b5870df-test-audit.md` (3 parallel
  sub-agents). Two 🟠 gaps fixed (net-zero equivalence, empty-store read count);
  the SQL-capture suggestion was dismissed under the repo's "never SQL" store
  testing decision.
- **Code review:** `.scratch/reviews/213/b5870df-code-review.md` (Standards +
  Spec, 2 parallel sub-agents). Both axes pass; the one test-quality note was
  applied in `b5870df`.
- **Greptile (CLI):** not run. `greptile whoami` and
  `greptile review --json --branch 8a7a7fa` both fail with
  `error: refresh failed: access_denied` — the CLI is not authenticated in this
  lane, and `greptile login` needs an interactive browser flow. The brief pinned
  local Guard 1 + Guard 2 as the gate and forbade pushing, so no PR-hosted review
  exists either. Re-run the CLI on an authenticated checkout before merge.

## Evidence staleness

This evidence names the final reviewed **code** SHA `b5870df`. The evidence and
wisdom are committed in a docs-only commit after it; `git diff b5870df..HEAD`
touches only `.scratch/` and `.agents/wisdom/`, so no reviewable code changed.

## Deferred items

- The cost pin guards the read-only resolve path only. A future `listParties`
  reintroduction on the guarded bulk-write path is out of #213's scope.
- No new browser-level test: the change is server-internal and the existing
  `supplier-adjustment.spec.ts` issue-184 flows exercise the resolve path end to
  end; no UI flow changed.
