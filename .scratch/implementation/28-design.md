# Ticket 28. Catalog search & barcode scanning: design

- **branch:** `feat/28-catalog-search`
- **base SHA:** `3bbad9c` (merge-base with origin/develop)
- **review tier:** Standard
- **issue:** github #28 — catalog search and barcode scanning (parent map #19)

## Scope decisions up front

- Single-admin stays the enforcement point (ADR-0004). No RBAC work here.
- Sale/purchase flows do not exist yet (tickets #29/#30). The unknown-scan dialog renders
  all four required choices today; wiring is honest per choice (below). Manual-line is the
  only deferred action and it never creates data silently.
- Shop-scale catalogs are hundreds of rows: ranking happens in memory over
  `listItems()`/`listCategories()`, not in SQL. One pure function, trivially unit-testable,
  and the store port stays shallow.

## Public interfaces

### contracts (`packages/contracts/src`)

`core.ts` gains:

```ts
/** loose normalized ASCII barcode: printable ASCII, no spaces, 3..64 chars */
export const barcodeSchema = z.string()
  .trim().regex(/^[\x21-\x7E]{3,64}$/, "expected a printable ASCII barcode");

export const catalogSearchInputSchema = z.object({
  query: z.string().trim().min(1).max(128),
  limit: z.number().int().min(1).max(50).optional(), // default 20
});

export const catalogMatchKindSchema =
  z.enum(["BARCODE_EXACT", "BARCODE_PARTIAL", "NAME", "CATEGORY"]);

export const catalogMatchSchema = z.object({
  item: itemSchema,
  category: categorySchema.nullable(),
  matchedBy: catalogMatchKindSchema,
});

export const catalogSearchOutputSchema = z.object({
  /** the single exact-barcode hit when one exists; ui adds it immediately */
  exact: catalogMatchSchema.nullable(),
  /** selectable results, ranked: partial-barcode > name > category */
  matches: z.array(catalogMatchSchema),
});
```

Shared normalizer exported from contracts (one implementation for api + web):

```ts
export function normalizeBarcode(raw: string): string | null;
```

NFC-normalize, strip zero-width/soft-hyphen junk, uppercase, drop inner spaces; returns
null when the result is not printable ASCII. Arabic keyboard/IME output therefore can
never masquerade as a barcode — the field rejects it instead of storing mojibake.

Name/category matching normalizes with a separate text key: NFC, lowercase, collapse
whitespace, strip tatweel (ـ) and Arabic diacritics. Arabic queries match Arabic names.

`itemSchema` gains `barcode: z.string().nullable()`; `itemCreateInputSchema` gains
`barcode?: string`; `itemUpdateInputSchema` gains `barcode?: string | null`.
`app-contract.ts` gains:

```ts
catalogSearch: oc.input(catalogSearchInputSchema).output(catalogSearchOutputSchema),
```

### store port (`apps/api/src/store/port.ts`)

```ts
getItemByBarcode(barcode: string): Promise<Item | undefined>;
```

Uniqueness is a sqlite UNIQUE index on `items.barcode`; create/update catch the violation
and the router maps it to `CONFLICT("BARCODE_EXISTS")` like CATEGORY_EXISTS.

### schema migration (`apps/api/src/db/schema.ts`)

DDL for new databases adds `barcode TEXT` (nullable UNIQUE index). Existing dev databases
get the column via an idempotent step in `setup()`: check `pragma table_info(items)`,
`ALTER TABLE items ADD COLUMN barcode TEXT` when missing, then
`CREATE UNIQUE INDEX IF NOT EXISTS idx_items_barcode ON items(barcode)`. Uncoded items
remain valid (NULL barcode).

### ranking (`apps/api/src/lib/catalog-search.ts`) — pure function

```ts
export function rankCatalog(
  items: Item[], categories: Category[], rawQuery: string, limit?: number,
): { exact: CatalogMatch | null; matches: CatalogMatch[] };
```

Order: exact barcode → partial barcode (prefix first, then substring) → normalized name →
category name. Exact hit goes in `exact` AND is excluded from `matches`.

### rpc router (`apps/api/src/rpc/router.ts`)

```ts
catalogSearch: guardedInput(async ({ query, limit }) =>
  rankCatalog(await deps.store.listItems(), await deps.store.listCategories(), query, limit)),
```

`itemsCreate`/`itemsUpdate` accept barcode; conflict → `CONFLICT("BARCODE_EXISTS")`;
update clearing barcode sends `barcode: null`.

### web (`apps/web/src`)

- `lib/use-barcode-scanner.ts` — `useBarcodeScanner(onScan: (code: string) => void)`.
  Window-level keydown listener. A burst whose inter-key gaps stay under ~35 ms is a wedge
  scan; the terminating Enter commits it. Slow/gapped keys (a human, an IME composing
  Arabic) pass straight through to the focused element — scanning never needs focus.
  Duplicate protection: an identical code committed again within 800 ms is dropped.
  Buffer resets on gap timeout or blur, so a half-burst never leaks into a form field.
- `components/catalog/item-picker-dialog.tsx` — manual catalog picker; debounced
  (150 ms) `catalogSearch` via react-query; renders `matchedBy` badges; keyboard
  navigable, RTL-aware. Used standalone on items page and importable by later ticket
  flows (#29/#30).
- `components/catalog/unknown-scan-dialog.tsx` — fired when a scan has no exact match.
  Four explicit choices: إنشاء منتج (opens the item form prefilled with the scanned
  barcode), إنشاء منتج مع مخزون (same form + initial-stock field, committed through the
  existing `setItemStockAndCost` seam in one transaction), سطر يدوي (explicit toast:
  "يُربط بمسار الفواتير لاحقاً — لم يُنشأ أي شيء", closes; no data created), إلغاء.
  Nothing auto-creates. Follow-up: connect manual-line to the invoice builder in #30.
- Items page: search box bound to the same `catalogSearch`, plus scanner listening while
  the page is mounted.

## Dependencies

- contracts → consumed by api + web (existing workspace pattern).
- No new packages. react-query, radix dialog (via shadcn), sonner already in.
- Schema change touches `drizzle-store.test.ts` fixtures (new column).

## Tests

Unit — `bun run test` (bun:test):

- `packages/contracts`: barcode normalizer — ASCII accepted/case-folded, Arabic/IME
  strings rejected, whitespace/junk stripped, length bounds; catalog schemas reject bad
  barcodes.
- `apps/api/src/lib/catalog-search.test.ts`: ranking precedence (exact > partial-prefix >
  partial-substring > name > category), limit, exact excluded from matches, Arabic name
  match with tatweel/diacritic noise, empty results.
- `apps/api/src/store/drizzle-store.test.ts`: barcode round-trip, NULL barcode valid,
  UNIQUE violation surfaces, `getItemByBarcode` miss → undefined, migration adds the
  column to a legacy database created with the old DDL.

Router — `apps/api/src/rpc/router.test.ts`: `catalogSearch` requires session; ranking
integration through the real store; itemsCreate duplicate barcode → CONFLICT key.

E2E — `tests/e2e/ticket28.spec.ts` (login-first pattern, session-authed):

- exact-barcode search auto-highlights the single match; partial + name + category paths
  show selectable results in rank order.
- picker dialog finds an item typed by Arabic name.
- wedge simulation: `page.keyboard.type(code, { delay: 5 })` + Enter with focus outside
  any input → item found; repeated immediately (duplicate) → single handling.
- unknown scan → dialog appears, cancel creates nothing; create-item path prefills the
  scanned barcode and lands on the saved item.

## Implementation risks

- Legacy-db migration: `ALTER TABLE` path must be proven by the old-DDL fixture test;
  UNIQUE index creation fails if existing rows share a barcode (impossible today — column
  is new — but the index step is still ordered after the backfill-free alter).
- Wedge timing heuristics: 35 ms/char threshold tuned for typical wedges; too tight
  misses slow scanners, too loose eats fast typists. Mitigation: constant extracted,
  duplicate window separate, both covered by e2e timing-based tests.
- IME composition events during scans could split keys — listener ignores
  `isComposing` keydowns entirely.
- Mixed LTR barcode text inside RTL layout — isolate with `dir="ltr"` spans in badges.
