# Issue 163 — Pagination for every table (design)

Tier: **Standard**. Base: `origin/develop` @ `c0794b7` (merge-base = `c0794b7`).
Branch: `feat/163-pagination`.

## Problem

Every flat, growing list currently returns the whole table in one response.
Only `invoicesList` carried a `totalCount` (and an implicit `.limit(200)`) and
`activitiesList` a `limit` clamp. The shop's records grow forever, so every
list screen eventually ships more rows than the screen can use.

Decided shape (issue #163): **server-side offset/limit**. One envelope for
every list — `{ limit, offset }` in, `{ items, total }` out. Default page size
**10**. Pager hidden when `total <= pageSize`. Page-size presets **20 / 25 / 50
/ 100** plus «مخصّص…» manual input. Offset resets to 0 when a search or filter
changes; the chosen page size persists.

## Public interfaces

### Contracts (`packages/contracts/src/core.ts`)

```ts
export const DEFAULT_PAGE_SIZE = 10;
export const PAGE_SIZE_PRESETS = [20, 25, 50, 100] as const;
export const MAX_PAGE_SIZE = 500;

export const paginationInputSchema = z.object({
  limit: z.number().int().min(1).max(MAX_PAGE_SIZE).optional(),
  offset: z.number().int().min(0).optional(),
});
export type PaginationInput = z.infer<typeof paginationInputSchema>;

/** The one list envelope. */
export const pagedOutputSchema = <T extends z.ZodType>(item: T) =>
  z.object({ items: z.array(item), total: z.number().int().min(0) });

/** Apply the server defaults. */
export function resolvePagination(input?: PaginationInput): { limit: number; offset: number };
```

Applied to the list inputs/outputs:

| Endpoint | Input | Output |
|---|---|---|
| `invoicesList` | `invoiceListInputSchema` (filters + pagination) | `pagedOutputSchema(invoiceSchema)` (`totalCount` → `total`) |
| `itemsList` | `itemListInputSchema` (pagination) | `pagedOutputSchema(itemListItemSchema)` |
| `expensesList` | `expenseListInputSchema` (filters + pagination) | `pagedOutputSchema(expenseSchema)` |
| `activitiesList` | `paginationInputSchema` | `pagedOutputSchema(activitySchema)` |
| `returnsList` | `returnsListInputSchema` (invoiceId + pagination) | `pagedOutputSchema(returnDetailSchema)` |
| `suppliersReturnsList` | `supplierReturnsListInputSchema` (supplierId + pagination) | `pagedOutputSchema(supplierReturnSchema)` |
| `itemsHistory` | `{ itemId }` + pagination | `{ movements, total, stockOnHand }` |

`itemsAll` (new, `oc.output(z.object({ items: z.array(itemListItemSchema) }))`)
is the **unpaginated** read the item dropdowns and `catalogSearch` use; it keeps
`stock.tsx` and `supplier-return-panel.tsx` selects complete.

### Store port (`apps/api/src/store/port.ts`)

Paginated list reads return the envelope and take an optional pagination; when
omitted they return every row (internal full reads stay simple):

- `listItems(pagination?) -> { items, total }`
- `listActivities(pagination?) -> { items, total }`
- `listReturns(filters, pagination?) -> { items, total }`
- `listSupplierReturns(filters, pagination?) -> { items, total }`
- `listInvoices(filters) -> { items, total }` (adds `offset`; key renamed)
- `listExpenses` / `listStockMovements` stay array-returning primitives.

Two lists cannot be sliced in SQL without changing an existing tested contract:

- **expenses** — `sortExpenses` (pure module) owns ordering, so the router sorts
  first, then slices; `total` is the sorted length.
- **item history** — `stockAfter` is cumulative (`historyWithRemaining`), so
  slicing before projection would print wrong balances. The router projects the
  full ledger (as today) and slices the projected rows; `total` comes from
  `countStockMovements`, which already exists.

Both are still server-side from the client's point of view: the client only
ever sends `limit`/`offset` and receives `{ items, total }`.

### Web

- `apps/web/src/lib/pagination.ts` — pure helpers: `DEFAULT_PAGE_SIZE`,
  `PAGE_SIZE_PRESETS`, `isPageSize`, `clampPageSize`, `pageCount`,
  `clampOffset`, `pageRange`, `parsePageSize`, `serializePageSize`. Pure so the
  offset/page math is unit-testable without a DOM.
- `apps/web/src/hooks/use-pagination.ts` — `usePagination()`: owns `offset`,
  reads/writes the persisted `ui.pageSize` preference through `usePreference`,
  exposes `pagination` (`{ limit, offset }` for the query) and
  `resetOnFilterChange()`. This is the single implementation of the
  "offset resets to 0 when a filter changes" rule.
- `apps/web/src/components/ui/pager.tsx` — the one `<Pager>`: hidden when
  `total <= pageSize`, «عرض X–Y من Z», numbered pages with ellipsis,
  prev/next, size selector with the presets + «مخصّص…» input. RTL, theme tokens
  only, `tabular-nums`.
- i18n: Arabic-first keys (`pagerRange`, `pagerPrev`, `pagerNext`,
  `pagerSize`, `pagerCustom`, `pagerCustomApply`, `pagerCustomInvalid`,
  `pagerPage`).

Pages wired: `invoices`, `items`, `expenses`, `activity`, `returns`
(customer + supplier tabs), `stock` history. Each passes `input: {...filters,
...pagination}` and renders `<Pager>` from the response `total`.

## Dependencies

- No new packages. `usePreference` (existing) persists the page size.
- Contracts first (types), then store, then router, then web.

## Planned tests

- **Store unit** (`drizzle-store.test.ts`): LIMIT/OFFSET + `total` for items,
  invoices, activities, returns, supplier returns — first page, second page,
  past-the-end empty page, exact-boundary page, `total` unaffected by the page.
- **Router unit** (`router.test.ts`): invalid `limit` (0, > MAX) rejected;
  `itemsList` no longer returns more than the default page; `itemsAll` returns
  everything; expenses slice after sort with a stable `total`; activity
  pagination; returns pagination.
- **Web unit**: `lib/pagination.test.ts` for the page math; `pager.test.tsx` for
  hidden at `total <= pageSize`, range copy, numbered pages, preset change,
  custom size, invalid custom size; page tests updated for the new envelope.
- **Playwright** (`tests/e2e/pagination.spec.ts`): invoices list — pager appears
  once more than 10 rows exist, changing the page size changes the row count, a
  kind filter resets to page 1, and the chosen page size survives a reload.

## Implementation risks

- **Selects must not shrink.** `itemsList` is now paginated. `itemsAll` backs the
  two selects and `catalogSearch` reads the full list unchanged.
- **Cumulative history.** Slicing before projection would corrupt `stockAfter`;
  the router projects first (see above).
- **Expenses ordering.** Slicing before `sortExpenses` would make pages overlap;
  the router sorts first (see above).
- **Money paths untouched.** No write/settlement path reads a paginated list;
  party-detail settle/pay panels keep the full `partyDetail` payload.

## Deferred (follow-up issue proposed, not silently dropped)

The **party-detail tabs** (customer/supplier invoices and payments) and the
**supplier account entries** list are still returned whole by `partyDetail`.
They are coupled to the in-page settle/pay panels and the delete guard, which
must keep the full invoice set for a correct money distribution; paginating
them needs dedicated money-safe reads (`partyInvoices`, `partyPayments`,
`supplierEntries`). Out of this change to keep the money paths untouched.
