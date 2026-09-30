## Review — STANDARDS AXIS (PR #105, `d6da3fc`, base `0b4d5a1`)

### Blocker / hard violations

**1. Review evidence SHA ≠ reviewed HEAD** — `docs/engineering-workflow.md`: *"Evidence filenames must contain the exact reviewed HEAD SHA; any later reviewable-file change makes evidence stale."* The diff adds `.scratch/reviews/98/4c0a264...-code-review.md`, but HEAD is `d6da3fc`, and `d6da3fc` ("fix(web): close PR #105 scan, partial-write, and stale-cost gaps") changes reviewable source (`items.tsx`, `stock.tsx`, `use-barcode-scanner.ts`). Evidence is stale for HEAD → gate requirement unmet.

**2. Capture listener never removed** — `apps/web/src/lib/use-barcode-scanner.ts:92`:
```
-    window.addEventListener("keydown", onKeyDown);
+    window.addEventListener("keydown", onKeyDown, true);
     window.addEventListener("blur", reset);
     return () => {
       window.removeEventListener("keydown", onKeyDown);
```
`removeEventListener` omits the `true` capture flag, so it does not match the capture-phase registration added at line 89 — the global keydown listener leaks on unmount (re-registered per mount). Functional defect, not a style call.

### Judgement calls (Fowler baseline; no documented standard overrides)

- **Duplicated Code** — money validation is copy-pasted: `items.tsx:355-378` (create `submit`) vs `591-608` (`saveEdit`). Same `sellText === "" || !Number.isSafeInteger(...)` / `costText` / `thresholdText` guards in both, differing only in `< 0` vs `<= 0`. Inconsistent messages for the same rule: `items.tsx:362` `t("itemsSellAboveCost")` vs `592` `t("itemsSellInvalid")`.
- **Data Clumps** — `ItemEditDraft.baseline` (`items.tsx:30-40`) restates five top-level draft fields (`name/categoryId/costPrice/sellingPrice/lowStockThreshold`); the diff-vs-baseline comparison at `~618-624` is the only consumer.
- **Test-coupling / Mysterious Name** — production behaviour is keyed to test attributes: `items.tsx:538` `document.querySelector<HTMLInputElement>('[data-testid="edit-name"]')?.focus()` and `547` `(active.dataset.testid ?? "").startsWith("edit-")`. A rename of a `data-testid` silently changes app behaviour.
- **stock.tsx:44-50,69** — `freshAfterRef`/`items.dataUpdatedAt` couples prefiling to React Query internals with a three-branch guard; correct but hard to reason about (Divergent Change risk if refetch timing changes).

### Correct (meets documented standards)

- WCAG-AA baseline (`.github/copilot-instructions.md`): new `role="alert"` on error nodes (`items.tsx:687`, `stock.tsx:177`); proper tab pattern — `role="tablist/tab/tabpanel"`, `aria-selected`, `aria-controls`, roving `tabIndex` (`items.tsx:146-175`); inline inputs carry `aria-label`.
- `invalidateItems()` (`items.tsx:47-53`) is a genuine de-duplication win over the two previous `Promise.all` blocks and correctly adds `dashboardSummary`.

**Residual risk:** evidence re-generation must name `d6da3fc`; the leaked listener needs `removeEventListener(..., true)`.