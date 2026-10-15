# Issue 196 — test audit (Standard tier, test-only) — round 2

- Reviewed source SHA: `e85cf6bb36da0758049780135e3da766ad138bf9`
- Base: `f75721133f25bfe29766266381893520e48d6bb0` (`origin/develop`)
- Audit shape: 3 fresh-context reviewer sub-agents (edge-case hunter, coverage
  analyst, quality reviewer) against `git diff f757211...e85cf6b`, each reading
  the helper, the 9 converted specs, and the app source of truth
  (`apps/web/src/pages/sale.tsx`, `apps/web/src/pages/purchase.tsx`,
  `apps/web/src/lib/use-invoice-draft.ts`). No writer access.
- Round 2 adds `completion-screens.spec.ts` to the round-1 set (parent-confirmed
  issue-listed).

## Coverage verdict — every acceptance criterion met

| Criterion (brief + parent decision) | Verdict | Evidence |
|---|---|---|
| One helper in `tests/e2e/rpc-helpers.ts` | covered | `saveQuickAdd`, `rpc-helpers.ts:91-113` |
| Arms the form's actual create procedure | covered | 9 with-stock sites pass `itemsCreateWithStock`; items-flow + 3 purchase sites pass `itemsCreate` (routing verified at `sale.tsx:355-361`, `purchase.tsx:167`) |
| Binds the server-issued id and asserts the row key | covered | `rpcOutput<{id}>` + `toHaveAttribute("name", \`quantity-${created.id}\`)`, `rpc-helpers.ts:106-109` |
| Asserts the save control enabled before the click | covered | `rpc-helpers.ts:92` |
| Asserts no client-side refusal inside the action | covered | `rpc-helpers.ts:99` |
| Applied to the brief's eight + `completion-screens` | covered | 14 call sites: sale-checkout 75/120/171/198, expense-reports 210, invoice-payments 38, items-flow 166, learnability 34/88, purchase-intake 63, returns 45/164, settings 55, completion-screens 35 |
| Existing assertions preserved | covered | every prior `toContainText(itemName)` retained |
| No timeout increases | covered | no `{ timeout: … }` added anywhere in the diff |

## Per-spec audit question: would this still pass if the feature were broken?

No conversion is a no-op. A replaced/renamed line key or wrong id fails on
`toHaveAttribute`; a silent client-side refusal fails by name on the error
surface (proven in `e85cf6b-verification.md`, proofs A/B); a disabled save fails
on `toBeEnabled`; an uncreated item fails the line lookup. The three purchase
sites and items-flow previously had no server ack, so the id-bond assertion is
genuinely new coverage there.

## Findings and disposition

| # | Finding (severity) | Disposition |
|---|---|---|
| 1 | 🟠 The post-ack line-key assertion (`rpc-helpers.ts:106-109`) uses the default 5 s `expect` window, so under extreme CI load the render could still outlast it. | Inherent to the #191-endorsed shape (await the ack, then assert the render). The ack removes the *write* round-trip from the window; only the React commit remains, and Playwright retries it for 5 s. Not changed. |
| 2 | 🟠 Claim that items-flow passes `sale-error`/`sale-lines` while on the items tab, making the guard vacuous. | **Refuted:** items-flow navigates to `/sale` for the quick-add (`items-flow.spec.ts:151-171`) and only goes to `/items` afterwards. The locators are correct. |
| 3 | 🟠 `expect(error).toHaveCount(0)` could pass before React flushes a refusal; a hypothetical silent refusal (never calls `setError`) is not caught. | Measured in proofs A/B: the guard fires within 5 s against a failing write. Every refusal branch in `sale.tsx:330-362` / `purchase.tsx:157-172` sets an error; no silent branch exists. Residual risk recorded. |
| 4 | 🟡 Refusal cases are not routed through `saveQuickAdd` by the suite (sale-checkout blank/0/-1). | Correct by design: those clicks send nothing, so arming an ack there would hang. #191 guidance excludes them. |
| 5 | 🟡 A wrong `procedure` still hangs the full budget. | `procedure` is a required typed parameter and every call site was verified against the form's branch; a bounded ack timeout would reintroduce the #179 CI flake — rejected. |
| 6 | 🟡 `quantityLabel` is invariant at all 14 sites; the returned id is unused; the per-form `error`/`lines` pair repeats (Data Clump / Duplicated Code / Speculative Generality, judgement calls). | **Considered, kept deliberate** (parent-accepted). Explicit locators keep the generic `rpc-helpers.ts` free of page-testid coupling beyond the documented `quantity-<id>` key convention and make each spec's assertions self-documenting. The return is the brief's named deliverable ("binds the server-issued item id"). |
| 7 | 💡 `receipts.spec.ts:55-70` still inlines the pre-extraction shape. | Out of scope: `receipts.spec.ts` already gates correctly (#191) and the brief says do not churn it. Consolidation noted as an optional follow-up. |

No finding was classified 🔴 would-break or "Fix it".
