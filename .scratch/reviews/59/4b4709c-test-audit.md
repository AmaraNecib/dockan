# Test audit — returns & refunds (incl. settlement split)

Tier: High-assurance. Base SHA: `9b6ee41`. Head SHA: `4b4709c`.

Reviewers: reviewer subagents (edge-case hunter, coverage analyst, quality
reviewer — mission 53796ce2) plus the settlement-delta review (mission
2281d97f). Evidence updated for the split + freebie additions.

## Commands (at head)

- `bun test apps/api/src` — 398 pass / 0 fail
- `bun test` (apps/web) — 121 pass / 0 fail
- `DOKAN_PORT=4336 DOKAN_WEB_PORT=5191 bun run test:e2e -- --workers=1` — 18 pass

## Base-feature findings and dispositions (carried)

| Finding | Risk | Disposition |
|---|---|---|
| Reject-after-resale STOCK_NEGATIVE deadlock | 🔴 | Fixed (cab527a): clamped removal `[5,2,5,1,0]`. |
| Round-half drift on full returns | 🟡 | Fixed (cab527a): full-line exact. |
| Rounding/loss coverage: 0-price lines booking exact COGS | 🟡 | Regression added (parent add-on): free line books cogsExact exact −200. |
| Negative netTotal | 🟡 | Fixed (cab527a): defensive guard. |
| Rejected returns count toward the returnable cap | 🟡 | Accepted + documented (they physically came back). |
| Reject e2e coverage missing | 🟡 | Accepted: reject covered at router + web unit level; e2e covers accept. |
| Test-DB sharing across describes | ⚠️ | Pre-existing suite pattern; new tests assert scope/delta-safe values. |

## Settlement-delta test findings and dispositions

| Finding | Risk | Disposition |
|---|---|---|
| Deterministic parent scenario (1000 / 500 → cash 200 / debt 300 → debt 700) | 🔴 | Covered at the wire, exact numbers. |
| All-cash on fully unpaid invoice allowed (soft warning, no block) | 🔴 | Wire test + web warning test + e2e assertion. |
| Debt never negative; excess flows to cash | 🔴 | Wire test (all-debt 500 vs 300 debt → cash 200, remaining 0). |
| Sequential returns cap against debt AFTER prior offsets | 🟡 | Wire test (3 × 500 vs 2000 → remaining 500). |
| REFUND_SPLIT_INVALID (cash > value) refused atomically | 🟡 | Wire test (no return row persists). |
| Debt-offset store guard (boundary refused, exact settled) | 🟡 | Store test. |
| Legacy pre-split migration: ALTER + all-cash backfill + idempotent re-setup | 🟠 | Store test with a real legacy-shaped table and row. |
| Freebie return unwinds its loss (report back to baseline, stock back, no lingering loss) | 🔴 | Wire test `[1,0,1]` replay + report-delta assertions. |
| Rejected freebie keeps its loss (scrapped = real cost) | 🟠 | Wire test: report back to after-sale state, not baseline. |
| Custom-cash UI validation + presets + settled-cash warning | 🟡 | Web tests (custom sent, all-debt sends 0, over-cash refused, settled-cash warning). |
| Voucher renders cash now + debt offset | 🟡 | Web render + e2e assertions. |

## Quality (grade B)

Strong: behavior-stating test names, exact money/replay assertions, layered
seams (pure → store → wire → web → e2e), deterministic migration test.
Residual notes (accepted, non-blocking): React act() warnings mirror the
existing invoice.test.tsx pattern; web test fixture factory duplication is
test-only; the report's partial-return limitation is documented.

## Verdict

Every money/stock/debt invariant the decision added has a deterministic test
at the wire or store seam; no missing test that would break an invariant
remains.