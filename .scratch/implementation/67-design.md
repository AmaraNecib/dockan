# 67 — Items table shows category NAME instead of raw categoryId UUID

**Tier: Standard** (UI + API display fix, no money math). **Base SHA:** `f4d4674`.
**Branch:** `fix/67-items-category` (base `develop`).

## Problem

`apps/web/src/pages/items.tsx:427` renders `{item.categoryId}` — a raw UUID — in
the التصنيف (category) column. The store's `listItems`
(`apps/api/src/store/drizzle-store.ts:655`) returns `Item[]` with no category
name, so the UI has nothing to show.

## Design decision: Option A, scoped to `listItems` only

Join the category name in the store query so the API response carries it, and
render that field in the table. Chosen over:

- **Option B (client-side resolve)** — rejected because the task's TDD seam is
  "category name in listItems output", and the shared `Item` type should stay a
  persistence shape; also the dashboard already calls `itemsList` and gets the
  name for free.
- **Extending base `itemSchema`** — rejected. `itemSchema` is the output of
  `itemsCreate`, `itemsUpdate`, `itemsCreateWithStock`, `itemsLowStock`, and
  `catalogSearch` (`catalogMatchSchema.item`). Making `categoryName` required
  would force joins/lookups in create/update/barcode/catalog paths for zero UI
  gain; making it optional would weaken the base type.

Instead: a dedicated **list output schema** + a named type, so only the list
endpoint gains the joined field.

### 1. Contracts (`packages/contracts/src/core.ts`)

```ts
/** item rows as returned by listItems: the owning category's display name
 * comes pre-joined so the UI never renders the raw categoryId (issue 67). */
export const itemListItemSchema = itemSchema.extend({ categoryName: z.string().nullable() });
export const itemListOutputSchema = z.object({ items: z.array(itemListItemSchema) });
export type ItemListItem = z.infer<typeof itemListItemSchema>;
```

`categoryName` nullable: `LEFT JOIN` keeps an item listable even if its category
row is missing; the table renders a fallback.

### 2. App contract (`packages/contracts/src/app-contract.ts`)

`itemsList: oc.output(itemListOutputSchema)` (was a plain
`z.object({ items: z.array(itemSchema) })`).

### 3. Store seam (`apps/api/src/store/port.ts`)

`listItems(): Promise<ItemListItem[]>;` (was `Promise<Item[]>`). All other item
methods (`createItem`, `updateItem`, `getItemByBarcode`, `getItemsByIds`,
`listLowStockItems`) keep returning `Item`.

### 4. Drizzle implementation (`apps/api/src/store/drizzle-store.ts`)

```ts
async listItems() {
  return db
    .select({ ...itemCols, categoryName: categories.name })
    .from(items)
    .leftJoin(categories, eq(items.categoryId, categories.id))
    .orderBy(items.name);
}
```

`itemCols` already projects camelCase keys matching `Item`; the joined
`categoryName` completes the `ItemListItem` shape. `eq` is already imported.

### 5. Web (`apps/web/src/pages/items.tsx`)

- Line 415: annotate the map callback with `ItemListItem` (import from
  `@dokan/contracts`) so `item.categoryName` typechecks.
- Line 427: `<td className="p-3">{item.categoryName ?? "—"}</td>` —
  `"—"` matches the table's existing missing-barcode fallback.

Dashboard (`dashboard.tsx`) already reads `items.data.items` from the same
query; it only uses `.length`, so the extra field is inert.

## Dependencies

- `packages/contracts` (`core.ts`, `app-contract.ts`)
- `apps/api/src/store/port.ts`, `apps/api/src/store/drizzle-store.ts`
- `apps/web/src/pages/items.tsx`
- Tests: `apps/api/src/store/drizzle-store.test.ts`,
  `apps/api/src/rpc/router.test.ts`, `tests/e2e/items-categories.spec.ts`

No new deps. No DB migration (join is read-time).

## Tests

### Unit (TDD seam — `listItems` output)

- **Store test** (`drizzle-store.test.ts`, items describe): create a category
  with a known name + an item under it, call `listItems()`, assert the row's
  `categoryName` equals the category name (and `categoryId` is unchanged).
- **Router test** (`router.test.ts`): after creating an item via the client,
  `itemsList()` rows include `categoryName` — proves the orpc output schema
  carries the joined field end-to-end (no zod stripping).

### E2E (`tests/e2e/items-categories.spec.ts`)

The spec already creates a category `زيوت-{stamp}` and an item. Extend it to:

1. Explicitly select `زيوت-{stamp}` in the item form's category dropdown
   (`getByLabel("التصنيف")` + `selectOption`) so the seeded category
   assignment is deterministic;
2. Assert the saved row shows the category NAME (`زيوت-{stamp}`), not a UUID.

## Risks

- **Orpc output stripping**: if `oc.output` strips unknown keys, the joined
  field would be dropped. Mitigated by extending the output schema itself
  (the router test above proves the wire carries `categoryName`).
- **Type ripple**: confined to `listItems` because the base `itemSchema` is
  untouched; create/update/low-stock/catalog-search outputs are unchanged and
  their tests untouched.
- **Legacy rows**: `LEFT JOIN` + nullable keeps orphaned items visible; UI
  falls back to `—`.