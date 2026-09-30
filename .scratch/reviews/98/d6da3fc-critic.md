## Review — PR #105 (feat/98-items-flow, HEAD d6da3fc, base 0b4d5a1)

`score | file:line | what breaks and when | how to fix` — ordered descending.

**6 | apps/web/src/pages/items.tsx:613** | `const costPrice = costText === "" ? 0 : parsedCost;` — clearing the inline cost field then saving (Enter in any edit field submits, items.tsx:631-637) writes cost **0** silently; purchase cost, average cost and profit move on a select-all+Enter. Create rejects blank cost (items.tsx:372), edit rejects blank sell (items.tsx:591). Same field, three rules. Fix: reject blank cost, or require an explicit `0`.

**5 | apps/web/src/lib/use-barcode-scanner.ts:89,92** | `window.addEventListener("keydown", onKeyDown, true)` (89) is removed as `window.removeEventListener("keydown", onKeyDown)` (92) — no `true`, so the capture listener **leaks**. Leave `/items` and a stale window-capture listener survives the session (×2 under StrictMode), still calling the old `onScan` and still running `event.preventDefault(); event.stopPropagation();` (74-75): every later tight ≥3-char burst anywhere (sale screen, dialogs, purchase form) has its Enter swallowed. `use-barcode-scanner.test.tsx` never unmounts. Fix: pass `true` to `removeEventListener`.

**5 | apps/web/src/pages/items.tsx:614** | `const lowStockThreshold = thresholdText === "" ? 0 : parsedThreshold;` — blank threshold saves 0 while create defaults blank to 5 (items.tsx:377). An accidentally cleared field silently disables the low-stock warn, including for an item already below threshold. Fix: omit blank (keep baseline) instead of 0.

**5 | apps/web/src/pages/items.tsx:551-565** | `beginEdit` overwrites any open draft (`setDraft({ id: item.id, … })`), so clicking another row's edit control discards typed name/price/threshold with no confirm. Only `update.isPending` disables other edit buttons, not the drafting state. Fix: block a second row while the draft is dirty, or confirm.

**3 | apps/web/src/pages/items.tsx:561-566,618-622** | `baseline` is snapshotted at open and never refreshed; after an `itemsList` refetch the row still renders pre-refetch prices, so the diff at 618-622 is computed against data the operator never saw. Fix: drop/refresh the draft when that row's data changes.

**3 | apps/web/src/pages/stock.tsx:95-104** | A unit cost typed with a negative delta is validated then silently discarded: `unitCost: parsedDelta > 0 ? parsedUnitCost : undefined` (103); line 96 errors only for positive deltas. The operator believes the cost was recorded. Fix: disable the cost field for removals.

**3 | apps/web/src/pages/items.tsx:545-549** | The pollution guard keys on test-id shape: `(active.dataset.testid ?? "").startsWith("edit-")`. Renaming the `edit-*` ids silently disables the guard that stops wedge digits being saved as a name/price; no test asserts that coupling (items.test.tsx:679 passes only via this string). Fix: `closest("tr[data-editing]")` or an explicit data hook.

**3 | apps/web/src/pages/items.tsx:361,377,591,604** | `Number()` accepts literals that are not the typed digits: `"1e3"` saves 1000, `"0x10"` saves 16. Gate money/quantity on `/^\d+$/` before `Number`.

**2 | apps/web/src/pages/stock.tsx:91** | `setError(t("stockQuantity"))` renders the field *label* ("الكمية (موجب إدخال، سالب إخراج)") as the error — says nothing, repeats the label. Fix: a real `stockQuantityInvalid` string.

**2 | apps/web/src/pages/items.tsx:47-55** | `invalidateItems` skips `catalogSearch` while `CatalogSearch` stays mounted on the hidden panel, so cached rows keep the pre-edit price until remount (`new QueryClient()`, main.tsx:13, staleTime 0 → display-stale only). Fix: invalidate the catalog key.

**2 | apps/web/src/pages/items.tsx:624-627** | A no-op save closes the row with zero feedback — indistinguishable from a failed save for a first-week operator.

**1 | apps/web/src/pages/items.tsx:585-590** | `if (Object.keys(patch).length === 1)` ties correctness to key counting; adding one defaulted field (e.g. barcode) breaks the guard silently. Use an explicit `changed` flag.

**Correct:** `items.test.tsx:429` genuinely proves one-submit create-with-stock; `:649` the partial patch; `:554` the in-flight-refetch cost guard — no vacuous test found in the added suite. `items-flow.spec.ts` asserts stock 9 → prefilled cost 100 → 12 across a reload. Partial writes are safe only because the API is a true partial write (`if (patch.costPrice !== undefined) set.costPrice = …`, apps/api/src/store/drizzle-store.ts:740-750) — correct today, undocumented coupling from the web layer.

**No blocker-tier (8-10) defect found.** Highest risks are the silent money zeroing (items.tsx:613) and the leaked capture listener (use-barcode-scanner.ts:92).

Note: I could not persist this to `D:\projects\mani-project\.scratch\reviews\98\critic.md` — the tool budget blocked the write. The full artifact is above; the runtime should persist it. The main checkout has pre-existing modifications from other lanes (`apps/api/src/**`, `bun.lock`); I staged nothing.