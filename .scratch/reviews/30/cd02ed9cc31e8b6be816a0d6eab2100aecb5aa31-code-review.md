# Code review — Sale checkout (issue #30, PR #42)

- **Head reviewed:** cd02ed9cc31e8b6be816a0d6eab2100aecb5aa31
- **Axes:** Standards (repo standards + Fowler smell baseline) and Spec (issue #30 + design doc), run as parallel sub-agents; UI skills (web-design-guidelines, accessibility, frontend-design, vercel-react-best-practices, shadcn, playwright-best-practices) applied by the lane.

## Standards axis

1. **ADR-0002 stale vs FIFO implementation — fixed.** New ADR-0005 documents the split (costAtSale = FIFO-weighted cost of consumed layers; live `items.costPrice` keeps ADR-0002 replay) and ADR-0002 is amended with a pointer. The design doc + wisdom had it, but ADRs are the durable record.
2. **Misplaced axis comment — fixed** (stock-ledger.ts: ADR-0002 comment now on `averageCostAfter`).
3. **Duplicated legacy-subtotal heuristic ×3 — fixed** via one `normalizeInvoiceLegacy` helper used by `toInvoice`, `getInvoiceDetail`, `listInvoices`.
4. **Dead duplicate integer checks ×4 — fixed** in contracts (`.int()` already enforces); percentage bounds kept.
5. **Smell, accepted:** `SalePriceInput` and sale-page `actualPrice` mirror server math — intentional client preview; server is authoritative and submit re-validates.
6. **Smell, dismissed:** `{type,value}` data clumps are intentionally separate (one is line price, one invoice discount); shared schema would obscure the two domains.
7. Process: evidence naming now follows `<head-sha>-<gate>.md` in `.scratch/reviews/30/`; `.scratch` is non-reviewable per guard.

## Spec axis

- (a) Missing/partial: none blocking. Design text "known items can be quick-added with stock" is satisfied as create-with-stock (new item with known stock lands in the cart); adding stock to an EXISTING item from `/sale` is a new feature → follow-up. Per-line gross shown in the cart while net/discount is shown once at invoice level — matches acceptance "show the invoice discount once".
- (b) Scope creep: minimal and justified (`DISCOUNT_ONLY_SALE` guard; additive-column migration; atomic numbering hardening retain notes).
- (c) Implemented-but-wrong: only the empty-override free-line bug (below) and the dormant `discountValueSchema` comment — both fixed.

## UI / accessibility / performance pass (sale.tsx)

- **Critical bug found & fixed:** choosing an override type with an empty value submitted `priceOverride {type, value: 0}` → the line billed at 0 DZD while the preview showed the default price (`Number("") === 0`). Now rejected pre-submit (`overrideInputInvalid`) with unit + E2E coverage.
- "−0 دج" discount line corrected to "0 دج".
- Pass: native `<button>`/`<label>`/`<table>` semantics, aria-labels on quantity/select/remove, `role="alert"` error, `inputMode="numeric"`, disabled-while-pending save, RTL root (`<html lang="ar" dir="rtl">`), `dir="ltr"` barcode field, heading hierarchy, empty state, scanSeqRef staleness guard.
- Notes (not changed, match app-wide patterns): per-field `aria-invalid` + focus-first-error not implemented (error banner announces via role=alert); no `Intl.NumberFormat` grouping (repo hardcodes "دج"); no `tabular-nums` (minor); dialog focus trap is #38-owned (unchanged, per lane seam).
- React: cart + totals are O(n) per render on a handful of lines; no layout reads; state updates batched; no obvious effect churn in the diff.

## Verdict

Standards: pass after fixes. Spec: complete. One money bug fixed (empty override),
one infra test flake fixed (backups date collision), zero picker-seam changes.