# Ticket 12 — Activity log view (shop trace) — design

## Goal
The owner sees a chronological trace of what happened in the app (sales,
purchases, payments, edits), newest first, Algeria-local timestamps, Arabic RTL.

## Data model
No schema change. The `activities` table already exists and real flows write
into it (`insertActivity` from categories/items/stock-adjust/auth flows).
`store.listActivities(limit)` exists (newest-first by `at` DESC, rowid DESC
tiebreak). Contract schemas exist in core.ts:
`activityListInputSchema { limit?: 1..200 }`, `activityListOutputSchema
{ items: Activity[] }`, and `app-contract.ts activitiesList`.

## RPC surface
Implement the `activitiesList` stub in `apps/api/src/rpc/router.ts`:

```ts
activitiesList: os.activitiesList.handler(
  guardedInput(async ({ limit }) => ({ items: await deps.store.listActivities(limit ?? 50) })),
),
```

- Session guard comes free via `guardedInput`.
- Default limit 50 when omitted; zod clamps 1..200.
- Output shape `{ items }` matches the contract exactly.

## UI
New page `apps/web/src/pages/activity.tsx` at route `/activity`
(`apps/web/src/router.tsx`), nav link in the header nav.

- `useQuery(orpc.activitiesList.queryOptions({ input: { limit: 100 } }))`
- Table (reuse plain Tailwind table styling used on items page): time, type
  badge, summary, ref id shortened when present.
- Loading skeleton, empty state ("لا توجد حركات بعد").
- Type labels via i18n keys `activityType_<TYPE>` for all 11 enum values.

## i18n keys (Arabic)
`navActivity`, `activityTitle`, `activityEmpty`, `activityTime`,
`activityType`, `activityType_LOGIN`, `activityType_PASSWORD_RESET`,
`activityType_CATEGORY_CREATED`, `activityType_ITEM_CREATED`,
`activityType_ITEM_UPDATED`, `activityType_PARTY_CREATED`,
`activityType_SALE_CREATED`, `activityType_PURCHASE_CREATED`,
`activityType_PAYMENT_RECORDED`, `activityType_BACKUP_CREATED`,
`activityType_STOCK_ADJUSTED`.

## Test plan
1. Router wire-seam tests (apps/api/src/rpc/router.test.ts):
   - unauthed call rejected UNAUTHORIZED
   - newest-first ordering after creating category → item → stock adjustment
   - limit clamps output length
2. E2E smoke `tests/e2e/ticket12.spec.ts`: setup+login, create a category with a
   UNIQUE name (parallel-spec DB rule from wisdom #4), open /activity, assert
   the CATEGORY_CREATED entry appears.

## Out of scope
Filtering by type/date, pagination beyond the limit clamp, ref deep-links
(needs invoice screens — later tickets).
