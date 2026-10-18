# Defender — PR #105 / issue #98 (HEAD d6da3fc, base 0b4d5a1)

**D1 — Tabs keep both jobs alive (items.tsx:147,171,175).** Panels are `hidden`-toggled, not unmounted: `hidden={tab !== "products"}` / `hidden={tab !== "add"}`. A half-typed add-item draft survives the browse/adjust round trip the owner actually performs — the items-flow e2e relies on exactly that. Confidence 9.
**D2 — Roving tabIndex + automatic activation (items.tsx:110,147).** Arrows/Home/End move focus *and* selection with `tabIndex={tab === entry.id ? 0 : -1}` — the WAI-ARIA tab pattern verbatim, pinned by an e2e that asserts focus-by-arrow plus `aria-selected`. Confidence 9.
**D3 — Only-changed-fields write (items.tsx:37,561,604+).** `baseline` exists solely so `saveEdit` sends a minimal `ItemUpdate`; the test mutates `costPrice` mid-draft and asserts the patch is `{id, sellingPrice}`. It also fixes the zero-price case: a name-only edit of a sale-created item no longer rewrites `sellingPrice`. Confidence 9.
**D4 — Blank-vs-zero is one coherent rule.** Empty opening stock ⇒ `itemsCreate`; `0` ⇒ also `itemsCreate` (deliberate "not counted yet"); positive ⇒ `itemsCreateWithStock` (items.tsx:396). Blank cost/threshold ⇒ 0 on edit, default 5 on create — the issue's "empty means zero" steer. Confidence 8.
**D5 — Money guards reject garbage instead of coercing (items.tsx:361,372,378,396,591,604,608).** `Number.isSafeInteger` closes the 2^53+1 case where `Number()` silently rounds a value the operator never typed, with a test named for it. Confidence 8.
**D6 — Enter is claimed by the wedge, not the form (use-barcode-scanner.ts, capture phase + `stopPropagation`).** With inline editors hosting Enter handlers, a scan's trailing CR would otherwise save a half-typed row; capture phase is the correct layer and is pinned by a falsifiable test. Confidence 8.
**D7 — Stale-cost hold in the stock form (stock.tsx:44,50,69).** `freshAfterRef` guards the window where React Query still serves the pre-movement list; `prefilledRef` guards typed values. Together: prefill follows a cost correction, typed value wins, no spurious write. Confidence 8.

**False alarms I expect from the critic**
1. *"582 lines in items.tsx is bloat."* Mostly the 9-column table's inline inputs; the logic is two tiny pure helpers plus one mutation.
2. *"Two focus-restoring effects are redundant."* They fire on disjoint transitions (open vs. close), each with its own test.
3. *"Blank stock defaulting to 0 on create is a bug."* It is the owner's explicit governance rule, echoed by the issue.
4. *"Partial patches break the contract."* No contract change; `itemUpdateInputSchema` already accepts partials, and the mock was tightened to mirror it.

Residual risk: the scan-drops-draft heuristic keys on `data-testid` prefixes (items.tsx:545) — narrow, but test-pinned.
