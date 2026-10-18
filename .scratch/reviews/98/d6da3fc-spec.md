# Spec-axis review — PR #105 / issue #98 (`d6da3fc`, base `0b4d5a1`)

Spec: `.scratch/implementation/items-flow-issue.md`, `.scratch/sessions/crew/98-items-flow-brief.md`, `98-steer.txt`, `98-steer2.txt`, `98-round2.txt`.

## Correct
- Brief #1 "always-visible optional field": `items.tsx` diff removes `{seed?.withStock === true && (` and renders the `initial-stock` label unconditionally; steer 2 "never behind a toggle" holds.
- Steer 1 "An item with zero stock goes through the plain create path": `if (stockText !== "" && stock > 0) void createWithStock.mutate({ ...base, stockOnHand: stock }); else void create.mutate(base);` — blank/`0` → `itemsCreate`, no forced stock procedure.
- Brief #2 selling price + prefill: `stock-selling-price` paragraph plus the guarded prefill effect keyed on `{ itemId, cost }` — closes round2 ISSUE 1 ("refresh the prefill when the known cost changes, without overwriting a value the operator has edited").
- Brief #4 tabs: `role="tablist"/"tab"/"tabpanel"`, `aria-selected`, `aria-controls`, roving `tabIndex`, Arrow/Home/End, default `products`.
- All new copy lands in `apps/web/src/lib/i18n.ts`; no literal Arabic in the `.tsx` hunks. No `apps/api`/`packages/contracts` files in the diff ("**UI-only**").

## Blocker
- `apps/web/src/lib/use-barcode-scanner.ts` — the listener is added in capture phase but removed without the flag, so it is never detached:
  `-    window.addEventListener("keydown", onKeyDown);` → `+    window.addEventListener("keydown", onKeyDown, true);` while cleanup still reads `window.removeEventListener("keydown", onKeyDown);`. Spec: "**Do not regress the sale screen's scan flow**, which shares the item form." `removeEventListener` requires a matching `capture` flag; the capture-phase handler survives unmount and keeps calling `onScanRef.current` with state setters of an unmounted page.

## Scope creep
- The same hook's `event.stopPropagation()` + capture-phase change is a behaviour change to a shared scanner used by `sale.tsx`, not one of the brief's four changes; defensible under steer 2 #8 ("If any path you touch today assumes a scanner, fix it") but it is the hunk that carries the Blocker. Fixing it is preferable to reverting it.
- `items.tsx` table header rewritten from `t("dashboardItemsCount")` to `t("itemsStock")` plus a 9th column. Threshold editing justifies the column; the header relabel is unrelated polish, and the design doc's own risk note concedes the table "goes 8 → 9 columns".

## Note
- Brief: "Evidence filenames must contain the exact reviewed HEAD SHA." Both evidence files are named `4c0a26439bd3d57246ff98ff7c1666a37898b1f5-{code-review,test-audit}.md`, i.e. commit `4c0a264`, while reviewed HEAD is `d6da3fc` — and `d6da3fc` itself edits `apps/web`. Evidence is stale for the reviewed SHA.
- `items.tsx` `saveEdit` blocks on `if (!draft.categoryId) setEditError(t("itemsChooseCategory"))`, the same shape as round2 ISSUE 2 (zero-price items uneditable). If `ItemListItem.categoryId` is nullable, an uncategorized item can take no correction at all. I did not verify the contract field's nullability — needs one look, not fix-by-assumption.
- Gates (`typecheck`, `lint`, unit, `test:e2e`) were not run: read-only task.
