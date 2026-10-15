# Issue 196 — test audit (Standard tier, test-only)

- Reviewed source SHA: `e2d40c91fae892092f3974c00dc4a8b634ee6b1c`
- Base: `f75721133f25bfe29766266381893520e48d6bb0` (`origin/develop`)
- Audit shape: 3 fresh-context reviewer sub-agents (edge-case hunter, coverage
  analyst, quality reviewer) against `git diff f757211...e2d40c9`, each reading
  the helper, the 8 converted specs, and the app source of truth
  (`apps/web/src/pages/sale.tsx`, `apps/web/src/pages/purchase.tsx`,
  `apps/web/src/lib/use-invoice-draft.ts`).
- Reviewer model: inherited parent tier (fresh context). No writer access.

## Coverage verdict — every acceptance criterion met

| Criterion (brief) | Verdict | Evidence |
|---|---|---|
| One helper in `tests/e2e/rpc-helpers.ts` | covered | `saveQuickAdd`, `rpc-helpers.ts:96-113` |
| Arms `itemsCreateWithStock` on the with-stock path (not `itemsCreate`) | covered | 8 with-stock sites pass `itemsCreateWithStock`; routing verified at `sale.tsx:349-362` |
| Binds the server-issued id and asserts the row key | covered | `rpcOutput<{id}>` + `toHaveAttribute("name", \`quantity-${created.id}\`)`, `rpc-helpers.ts:105-110` |
| Asserts the save control enabled before the click | covered | `rpc-helpers.ts:97` |
| Asserts no client-side refusal inside the action | covered | `rpc-helpers.ts:99-104` |
| Applied to the 8 brief specs | covered | 12 call sites incl. 4 in sale-checkout |
| Existing assertions preserved | covered | every prior `toContainText(itemName)` retained |
| No timeout increases | covered | diff touches no timeout/config; only imports + call swaps |

## Per-spec audit question: would this still pass if the feature were broken?

- A **server refusal** now fails by name through `expectRpcOk` (`<procedure>
  failed with HTTP <status>`) instead of burning the budget.
- A **line replaced by a different item** fails by name on the `name` attribute
  (`quantity-<server id>` mismatch), not on a generic containment poll.
- A **synchronous client refusal** fails by name on `sale-error`/`purchase-error`
  at the helper call site within the 5 s expect window (proven red in
  `e2d40c9-verification.md`, proofs A and B).
- No conversion is a no-op: each site now depends on a response the server
  actually issued, and a broken write cannot satisfy the id-keyed line assert.

## Findings and disposition

| # | Finding (severity) | Disposition |
|---|---|---|
| 1 | 🟠 `expect(error).toHaveCount(0)` is a negative assertion; if polled before React flushes a refusal it could pass vacuously, and a hypothetical silent no-op refusal (returns without `setError`) is never caught. | **Measured, not theoretical.** Proof A/B route a 500 through the form; the app renders `sale-error`/`purchase-error` and the guard fails by name in 5 s (see verification). Every refusal branch in `sale.tsx:330-362` / `purchase.tsx:157-172` sets an error, so no silent branch exists. Residual risk recorded, no code change. |
| 2 | 🟡 Refusal path is not routed through `saveQuickAdd` by the suite (the blank/0/-1 sale-checkout cases stay raw). | Correct by design: those clicks send nothing, so arming an ack there would hang. #191 guidance explicitly excludes them. |
| 3 | 🟡 No server-rejection case drives `expectRpcOk`'s reject path on quick-add. | Covered out-of-band by the two temporary 500 routes (proofs A/B); adding a permanent negative test would require changing the spec's own inputs and is out of the brief's scope. |
| 4 | 🟡 A wrong `procedure` still hangs the full budget with no procedure-mismatch message. | The helper makes the procedure a required, typed parameter and documents the routing; every call site was verified against the form's actual branch. A bounded ack timeout would reintroduce the #179 CI flake — rejected. |
| 5 | 🟡 `getByLabel` is substring, not exact. | All fixture item names carry a unique `Date.now()` stamp and no converted name is a prefix of another line in the same spec; strict mode would surface any collision. |
| 6 | 🟡 Teardown: `actAndAck` only swallows the armed wait when the action throws. | Pre-existing `rpc-helpers.ts` behavior, unchanged by this issue. |
| 7 | Structure: the per-form `error`/`lines` pair and inert `quantityLabel` repeat at every call site; the returned id is unused (Fowler: Data Clump / Duplicated Code / Speculative Generality, judgement calls). | **Considered, kept deliberate.** The explicit locators keep the generic `rpc-helpers.ts` free of page-testid coupling beyond the documented `quantity-<id>` key convention, and make each spec's assertions self-documenting. The reviewers graded this "borderline, not a blocker" and "non-blocking". The return is the brief's named deliverable ("binds the server-issued item id"). No churn. |

No finding was classified 🔴 would-break or "Fix it".
