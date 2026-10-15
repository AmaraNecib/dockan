# Issue 196 — test audit (Standard tier, test-only) — round 2, final

- Reviewed source SHA: `8e67761`
- Base: `f75721133f25bfe29766266381893520e48d6bb0` (`origin/develop` merge-base)
- Audit shape: 3 fresh-context `reviewer` sub-agents (edge-case hunter, coverage
  analyst, quality reviewer) against the saved diff
  (`.scratch/reviews/196/8e67761-diff.patch`), the helper, the 10 converted
  specs, and the app source of truth. No writer access.
- Round 3 delta: `receipts.spec.ts` folds its inline #191 block into
  `saveQuickAdd` (parent decision), keeping its id binding and number checks.

## Coverage verdict — every acceptance criterion met

| Criterion (brief + parent decision) | Verdict | Evidence |
|---|---|---|
| One helper in `tests/e2e/rpc-helpers.ts` | covered | `saveQuickAdd`, `rpc-helpers.ts:89-113` |
| Arms the form's actual create procedure | covered | 11 with-stock sites `itemsCreateWithStock`; 4 purchase/plain sites `itemsCreate` (routing verified `sale.tsx:330-364`, `purchase.tsx:157-180`) |
| Binds the server-issued id and asserts the row key | covered | `rpcOutput<{id}>` + `toHaveAttribute("name", \`quantity-${created.id}\`)` |
| Asserts the save control enabled before the click | covered | `rpc-helpers.ts:92` |
| Asserts no client-side refusal inside the action | covered | `rpc-helpers.ts:99` |
| Every quick-add ack site has one shape | covered | 15 `saveQuickAdd` call sites in 10 specs (sale-checkout 4, returns 2, learnability 2, expense-reports/invoice-payments/items-flow/purchase-intake/settings/completion-screens/receipts 1 each) |
| Receipts folded in, assertions preserved | covered | `receipts.spec.ts:60-72`; `invoiceNumber` regex + `sale-saved-number` intact |
| No timeout increases | covered | no `{ timeout }` added anywhere; `playwright.config.ts` unchanged |

### Remaining inline quick-add save clicks (independently enumerated)

`sale-checkout.spec.ts:56, 62, 69` are the only inline clicks on a quick-add save
button left (`حفظ المنتج وإضافته`). All three are the "refuses a blank or zero
quantity" test: `resolveOpeningStock` refuses synchronously on the with-stock
path (`sale.tsx:341`), sends no request, and asserts the Arabic message by name.
They are **deliberate refusal/no-request paths**, not ack sites — arming an ack
there hangs by construction (#191). No inline `منتج جديد سريعاً` clicks remain.
Conclusion: **every quick-add ack site now shares the one `saveQuickAdd` shape;
0 inline ack sites remain.**

## Per-spec question: would this still pass if the feature were broken?

No conversion is a no-op. A wrong line key or id fails `toHaveAttribute`; a
disabled save fails `toBeEnabled`; a silent refusal fails on the error surface
(proven by the manual route-injection proofs A/B in `8e67761-verification.md`);
an uncreated item fails the line lookup.

## Findings and disposition

| # | Finding (severity) | Disposition |
|---|---|---|
| 1 | 🟠 Wrong `procedure` still hangs the full budget; no durable test drives the helper's negative paths. | Accepted: `procedure` is a required typed parameter verified against each form's branch; a bounded ack timeout would reintroduce the #179 CI flake. Proofs A/B exercise the negative path manually. Deferred durable regression noted below. |
| 2 | 🟠 The synchronous-refusal branch is never triggered through `saveQuickAdd` by a committed test. | Same shape as #1; the manual proofs cover it. No repo test asserts a *successful* passing of the refusal guard, only the happy path. |
| 3 | 🟠 `lines.getByLabel(\`${itemName}: ${quantityLabel}\`)` is non-exact; a name prefixing another line's name could strict-mode-fail. | Residual, cosmetic today (unique stamped names). `{ exact: true }` noted as a possible hardening in a follow-up, not fixed here to keep the reviewed helper byte-stable. |
| 4 | 🟡 `expect(error).toHaveCount(0)` may be near-vacuous where an error node renders behind `lines.length === 0`. | Nuanced: `sale-error`/`purchase-error` also render behind `error` alone (`sale.tsx:513`, `purchase.tsx:395`), so a refusal after the first line still shows. Pre-existing #191 shape; not changed. |
| 5 | 🟡 `quantityLabel` invariant at all 15 sites; returned id unused except receipts; per-form `error`/`lines` pair repeats. | **Considered, kept deliberate** (parent-accepted). Explicit locators keep the helper free of page-testid coupling beyond the documented `quantity-<id>` convention. |
| 6 | 🟡 Receipts re-asserts `name="quantity-<id>"` after the helper already did. | Deliberate: the parent decision was to keep receipts' existing assertions intact. Harmless second read. |
| 7 | 💡 Comment says "every other quick-add site now uses" the helper. | Defensible: every quick-add **ack** site does; the three inline clicks are deliberate refusal paths. No change. |
| 8 | 💡 `receipts.spec.ts:55-70` inlined the pre-extraction shape (round-2 finding). | **Resolved this round** by `8e67761`. |

No finding was classified 🔴 would-break or "Fix it".

## Quality grade: B

Mechanically correct, matches the design, and preserves every required
assertion. Deductions: the redundant id-key re-assertion in receipts and two
comment statements ("every other quick-add site", stale "an ack armed for
`itemsCreate` would never fire") that no longer describe the mechanism
precisely. No blocker.

## Deferred (follow-up candidates, not this PR)

- A durable test for the helper's negative paths (wrong procedure / disabled
  save / silent refusal) instead of manual route-injection proofs.
- `{ exact: true }` on the helper's line lookup.
