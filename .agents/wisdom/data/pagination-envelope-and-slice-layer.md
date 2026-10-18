# Pagination: one envelope, but slice at the right layer

**Date:** 2026-10-13 · **Ticket:** 163 · **Area:** packages/contracts/src/core.ts, apps/api/src/store, apps/api/src/rpc/router.ts, apps/web/src/lib/pagination.ts, apps/web/src/components/ui/pager.tsx

Server-side paging shipped one contract (`{limit, offset}` in, `{items, total}`
out, `resolvePagination` default 10, `pagedOutputSchema`). The traps worth
carrying forward:

1. **Not every list can slice in SQL the same way.** When the router already
   owns ordering (`sortExpenses` is a tested pure module) or the derived column
   is cumulative (`stockAfter` is a running balance), slice at the layer that
   owns that order/state. `LIMIT`/`OFFSET` before the sort repeats rows between
   pages; slicing a ledger before projecting restarts `stockAfter` at the page.
   Both are router-side slices here, and both are pinned by router tests.
2. **A paginated list read needs a separate unpaginated read for dropdowns.**
   `itemsList` now returns 10 rows; the item pickers/selects and `catalogSearch`
   still need the whole catalog, so `itemsAll` exists beside it. Do not let a
   table's page size silently shrink a `<select>`.
3. **oRPC TanStack query keys start with the path ARRAY, not a string.**
   `generateOperationKey(path, state)` returns `[path, { input, type }]`, and
   `path` is `["itemsList"]`. So `invalidateQueries({ queryKey: ["itemsList"] })`
   does NOT match; invalidate with the exact `orpc.x.queryKey({ input })` or
   app-wide. When a key gains page params, a mutation that only knows the old
   input can invalidate everything (the items page already does this on purpose).
4. **Pending-first ordering must move into the SQL.** The returns screen showed
   pending rows ahead of reviewed ones by re-sorting the response client-side;
   once the response is a page, that reorder only shuffles the page. The
   `ORDER BY CASE WHEN status = 'PENDING_REVIEW' THEN 0 ELSE 1 END` keeps a
   pending return reachable on page 1.
5. **The e2e suite is one shared database.** Specs about other features assume
   a complete list; the shared `signIn` preamble opens lists wide via the real
   `ui.pageSize` preference, and `pagination.spec.ts` sets it back to 10 so the
   paging test starts from a known state.
