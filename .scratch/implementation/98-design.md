# Issue #98 — Items flow: one-step stock, forgiving corrections (design)

Tier: **Standard**. Base: `origin/develop` @ `5f8b94e`.
Branch: `feat/98-items-flow`. Scope: **UI-only** in `apps/web`.

## Problem

The first customer is entering an existing shop. Four friction points:

1. Opening stock is gated behind a scan (`seed?.withStock`), so the most common
   task (new item + today's quantity) needs the scan dialog or two saves.
2. `StockForm` forgets the item's known cost and never shows its selling price.
3. `itemsUpdate` exists in the contract but is wired nowhere, so a typo in a
   price is permanent.
4. The add form and the stock form are stacked above the table; both jobs are
   buried in one column and the table is pushed below the fold.

Governance (owner steer): the field is always visible; **empty means zero**;
approximate values are valid; the positive delta correction stays available.
Give the one-step path without removing the two-step path — never restrict,
force, or hide either.

## Component interfaces

### `apps/web/src/pages/items.tsx`

`ItemsPage` gains a controlled, in-page tab state:

```ts
type ItemsTab = "products" | "add";
const [tab, setTab] = useState<ItemsTab>("products"); // table is the default
```

- `role="tablist"` with `aria-label={t("itemsTabsLabel")}`; each tab is a
  `<button role="tab">` with `aria-selected`, `aria-controls`, an `id`, and a
  roving `tabIndex` (active 0, inactive -1). ArrowLeft/ArrowRight/Home/End move
  focus **and** selection (automatic activation). Panels are
  `role="tabpanel"` + `aria-labelledby`, kept mounted and hidden with the native
  `hidden` attribute so an in-progress form draft survives a tab switch.
- Products panel: `CatalogSearch` + `ItemList` (the table).
- Add panel: `ItemForm` (one-step: new item, optional opening stock) +
  `StockForm` (two-step: stock onto an existing item).
- Unknown-scan `onCreate` / `onCreateWithStock` switch to the `add` tab and seed
  the barcode. `seed.withStock` still selects the "with stock" intent and
  focuses the opening-stock input; it no longer gates visibility.

`ItemForm` (signature unchanged: `{ seed, onSeedConsumed, onSaved }`):

- `initialStock` input is rendered **unconditionally**.
- Submit path:
  - blank or `0` → `itemsCreate` (plain item, quantity 0 — a deliberate value);
  - positive integer → `itemsCreateWithStock` (`stockOnHand`);
  - negative / fractional / non-numeric → `itemsStockInvalid` error.
- No floor/round logic; no "approximate" warning. `scanStockInvalid` stays the
  `sale.tsx` quick-add message (that path still requires ≥ 1).

`ItemList`:

- Adds `useQuery(orpc.categoriesList)` and `useMutation(orpc.itemsUpdate)`.
- One row at a time is editable. `editingId` + a draft
  `{ name, categoryId, cost, sell, threshold }`; the edit button seeds the draft
  from the row. Inline inputs replace the name/category/cost/sell cells; the
  profit cell recomputes live via the existing `profitPreview`.
- Save validates name non-empty, selling > 0, category chosen, threshold ≥ 0,
  then `itemsUpdate.mutate({ id, name, categoryId, costPrice, sellingPrice,
  lowStockThreshold })`. Success invalidates `itemsList`, `itemsLowStock`, and
  `dashboardSummary` (the name/threshold can move the low-stock list) and exits
  edit. Failure renders `role="alert"` above the table.
- Barcode stays read-only (out of the brief's five editable fields).

### `apps/web/src/pages/stock.tsx`

`StockForm`:

- `const selectedItem = items.data?.items.find((i) => i.id === selectedItemId)`.
- Shows the selling price for the selected item (`stock-selling-price`, DZD via
  `Amount`) and prefills `unitCost` from `selectedItem.costPrice` on selection
  change (a ref guard so a background refetch never clobbers an edit in
  progress). Both values stay editable; `stockAddManual` is unchanged, including
  the signed delta.

### i18n (`apps/web/src/lib/i18n.ts`)

New keys (all Arabic lives here): `itemsTabsLabel`, `itemsTabProducts`,
`itemsTabAddStock`, `itemsNewTitle`, `itemsEdit`, `itemsCancel`,
`itemsSaving`, `itemsNameRequired`, `itemsStockInvalid`, `stockSellingPrice`.

## Dependencies

None new. Uses the existing `Select`, `Skeleton`, `Amount`, tokens; `itemsUpdate`
already exists in the contract.

## Planned tests

Unit / component (`apps/web/src/pages/items.test.tsx`, `bun test`):

- add form: blank stock → `itemsCreate`; `0` → `itemsCreate`; `7` →
  `itemsCreateWithStock({ stockOnHand: 7 })`; negative → inline error, no call.
- stock form: on mount/select the selling price renders and the unit-cost input
  is prefilled from the item; selecting another item re-prefills.
- edit: changing name/price/threshold sends `itemsUpdate` and the refetched row
  shows the new values; empty name blocks the call.
- tabs: table is the default panel; ArrowRight selects the add panel and moves
  focus; `aria-selected` follows.

Playwright (`tests/e2e/items-flow.spec.ts`):

- create an item with opening stock in one submit and see it in the table;
- edit a price and see it persist after a reload;
- add stock to an existing item with the prefilled cost and the shown price;
- switch tabs with the mouse and with the arrow keys.

Existing specs that drive the add/stock forms now open the `add` tab first and
switch back to `products` before asserting table rows (the inactive panel is
`hidden`, so its controls are out of the accessibility tree).

## Risks

- **Existing E2E churn.** The default tab changes where the forms live. Handled
  with a shared `openItemsTab` helper and explicit switches; run the full suite.
- **Prefill clobber.** A ref guards the unit-cost prefill so a refetch cannot
  overwrite a typed value.
- **Inline edit + RTL table.** Inputs are narrow; verify at desktop widths and
  keep the existing column count.
- **Stale `itemsUpdate` handling.** Only five fields are sent; the contract is
  untouched, so no schema drift.

## Out of scope (deliberate)

- No `apps/api` or `packages/contracts` change.
- No barcode/delete editing; no money or stock calculation change.
- No visual redesign outside the items page; no dashboard/onboarding work.
