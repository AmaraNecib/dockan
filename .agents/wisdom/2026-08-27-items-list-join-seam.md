# Items list: join display names at the list seam, never widen the base entity schema

**Date:** 2026-08-27 · **Issue:** 67 · **Area:** packages/contracts + apps/api/src/store + apps/web/src/pages/items.tsx

The items table rendered the raw `categoryId` UUID because `listItems` returned
`Item` with no category name. The tempting fix — adding `categoryName` to the
shared `itemSchema` — ripples: that schema is the output of `itemsCreate`,
`itemsUpdate`, `itemsLowStock`, and `catalogSearch` (`catalogMatchSchema.item`),
which would all suddenly need the joined field or weaken the base type.

**Always:**
- Add joined display fields to a **dedicated list output schema**
  (`itemListItemSchema = itemSchema.extend({ ... })` + `itemListOutputSchema`),
  not to the entity schema. Only the list endpoint gains the field; create/
  update/low-stock/catalog-search shapes and tests stay untouched.
- Extend the orpc **output schema** when the handler returns the joined field —
  `<x>OutputSchema` naming convention; orpc/zod strips unknown keys otherwise
  and the field silently dies on the wire (caught by a router-seam test).
- Test the joined name at **three seams**: store (`listItems` SQL join), RPC
  (wire survival — the structural-stripping trap), and E2E (rendered cell shows
  the name, not a UUID).
- `LEFT JOIN` + nullable keeps orphaned rows listable; the UI falls back with
  the table's existing `"—"` convention. Don't add a raw-SQL orphan test — the
  store-seam test doctrine forbids SQL, and without a category-delete feature
  the path is unreachable.