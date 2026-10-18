# Code review — issue #96 round 2, `b7038b5...7fd7aea`

Reviewer: review subagent (two axes, per `.agents/skills/code-review/SKILL.md`).
Range: `git diff b7038b5...7fd7aea` (1 commit: `7fd7aea fix(web): gate the invoice-returns action on kind and the rendered form (#96)`).
Spec source: `D:/projects/mani-project/.scratch/sessions/crew/briefs/issue-96-round2.md` + the Greptile findings quoted in it.
Standards sources: `AGENTS.md`, `docs/engineering-workflow.md`, the round-1 design/decisions files, plus the skill's smell baseline.
Review-only: no source file was edited.

Files in the diff: `apps/web/src/pages/invoice.tsx`, `apps/web/src/lib/i18n.ts`, `apps/web/src/lib/i18n.test.ts`, `apps/web/src/pages/invoice-returns.test.tsx`, `tests/e2e/96-returns-supplier-action.spec.ts` (new), `tests/e2e-selection.map.json`, `.scratch/implementation/96-design.md`, `.scratch/reviews/96/decisions.md`, 2 screenshots.

## Standards

No documented-standard breach found. The change keeps the repo's conventions: all display text goes through `apps/web/src/lib/i18n.ts` (5 new keys, `i18n.ts:562-575`), the new copy is asserted to be real Arabic by the extended key list (`i18n.test.ts:300-304`), existing `data-testid`s (`returns-empty`, `returns-empty-action`, `returns-form`, `returns-done`) are preserved so earlier specs keep working, and each new branch carries an `// #96 round 2` comment naming the api guard it mirrors. `overrides` on `makeInvoice` is test-only.

Judgement calls (smell baseline, none blocking):

- **Duplicated Code** — `apps/web/src/pages/invoice.tsx:588-620`: the three new `EmptyState` branches repeat `testId="returns-empty" className="mt-2" title={t("returnsEmpty")}`. The variable part is hint + action; a shared object/const would leave one copy. Round-1 shape was a single branch; round 2 tripled it. Low.
- **Nested ternary** — `apps/web/src/pages/invoice.tsx:663`: `{!isSale || returnsUnavailable ? null : savedReturn !== null ? <SuccessCard…> : <form…>}` is three-way inline. Readable only with care; an extracted `panelFooter` const would read better. It does follow the existing `savedPayment !== null ? … : …` shape, so this is consistency, not a defect. Low.
- Long single-line `<Link>` at `apps/web/src/pages/invoice.tsx:603` (peer of the long lines already there, e.g. `:605`). Cosmetic.

Not run by me: `bun run lint`, `bun run typecheck` (implementer-reported; no evidence of a problem in the changed lines).

## Spec

### Finding 1 — purchase invoice offered a return that can never be saved: **fixed**

- The api guard is real and exactly as quoted: `apps/api/src/rpc/router.ts:1505-1508` throws `RETURN_NOT_SALE` when `invoice.kind !== "SALE"`.
- The panel now derives `isSale` (`invoice.tsx:419`) and branches the whole body on it (`:590`). For a purchase invoice the customer-return form is **not rendered at all** (`:666` `!isSale || returnsUnavailable ? null : …`), so the empty state's action cannot focus a field in a form that is refused.
- The offered path is the supplier account: `Link to="/suppliers/$partyId" params={{ partyId: supplierAccountId }}` (`:603`), with `supplierAccountId = invoice.counterpartyId` (`:420`). That field really is the supplier on a purchase invoice — the api asserts it: `detail.kind !== "PURCHASE" || detail.counterpartyId !== input.supplierId` (`router.ts:772`, `:834`, `:972`).
- Both routes exist: `/suppliers` → `router.tsx:86`, `/suppliers/$partyId` → `router.tsx:90` (`SupplierDetailRoutePage`), and the destination screen carries the `supplier-balance` test id the e2e asserts (`apps/web/src/pages/party-detail.tsx:122`).
- The no-supplier variant is not speculative: `counterpartyId` is nullable (`packages/contracts/src/core.ts:427ff`, written as `input.counterpartyId ?? null` at `router.ts:1244`), and it routes to `/suppliers` with distinct copy (`invoiceReturnsPurchaseNoPartyHint`). Every button added leads somewhere real.
- Hint copy is honest: `invoiceReturnsPurchaseHint` literally says purchase returns are recorded from the supplier account statement, not from the purchase invoice (`i18n.ts:565`).

### Finding 2 — the action survives the save and focuses nothing: **fixed**

- Action condition is now `savedReturn === null && hasReturnableLine` (`invoice.tsx:602`), and the hint swaps to `invoiceReturnsJustSavedHint` when `savedReturn !== null` (`:604`).
- This is the `PaymentPanel` pattern the brief pointed at, not a second invention: `remaining === 0 || savedPayment !== null ? undefined : <Button data-testid="pmt-empty-action">` with the `pmtEmptyJustSavedHint` cascade (`invoice.tsx:188-196`).
- Root cause addressed, not the symptom: the gate is on `savedReturn` (whether the form is rendered), not on the stale list's total.

### Third gate of the same class — **fixed** (in scope, not creep)

`returnsUnavailable = returnsQuery.isError && returnsQuery.data === undefined` (`invoice.tsx:402`) withholds both the action and the form when the read that supplies the per-line cap failed (`:666`), with its own honest hint (`i18n.ts:575`). This is the round-1 lesson applied consistently ("branch on the dependency's state"), and the brief's class instruction explicitly asked for the class, not the two lines. Copy/hint are truthful: with no history there is no known remaining quantity to type against.

### Payments sweep (`pmt-*`) — **swept, and correctly left alone**

Verified independently, matching `.scratch/implementation/96-design.md` (round-2 §Sweep):

- **Kind hole does not apply.** `invoicesPay` has no kind guard, and a paid purchase invoice is a first-class flow: the handler wires the supplier ledger when `detail.kind === "PURCHASE" && detail.counterpartyId !== null` (`router.ts:1460-1462`). A payment form on a purchase invoice is a path that completes, not a dead end.
- **Stale-after-save hole does not apply.** `PaymentPanel` already hides the action while `savedPayment !== null` and the card replaces the form (`invoice.tsx:188-196`, `:240`).
- **No second-query hole.** The payment cap (`invoice.remainingAmount`) comes from the invoice detail read — the same read that renders the panel — so there is no failing dependency to branch on. No `returnsUnavailable` analogue is needed, and none was invented.

### Nothing invented, no dead end left

- Every new control has a real destination (routes and test ids verified above); the two deliberate no-action states (purchase with no supplier is still actionable via `/suppliers`; failed read is copy-only) are copy, not fake buttons.
- Ordering check on the new first branch: on a purchase invoice the `!isSale` branch replaces the history table, so a purchase invoice with existing returns would show "no returns yet" above its own counts row. **Unreachable today** — customer returns can only be created through `returnsCreate`, which refuses non-SALE (`router.ts:1505-1508`); supplier returns live in a separate record (`insertSupplierReturn`, `router.ts:871`) and are not in `returnsForInvoice` (`router.ts:1642-1646` `listReturns({ invoiceId })`). Worth a comment if a future writer ever links a purchase return to its invoice.
- `returnsUnavailable` also suppresses the completion card (`invoice.tsx:663`). Reachable only via a post-save refetch that fails with no cached list; after a successful save the query has data, and react-query retains `data` on refetch error, so `returnsUnavailable` stays false. No evidence of reachability; noted as fragility, not a defect.

### Tests

- `apps/web/src/pages/invoice-returns.test.tsx:324-370` — 4 new cases: purchase + supplier (no `returns-empty-action`, no `returns-form`, link to `/suppliers/$partyId` with the supplier id), purchase with no supplier (link to `/suppliers`), post-save stale window driven through the **real** form submit with the mocked history still pre-save, and failed history read. Assertions use `i18n.t(key)`, not hard-coded Arabic, matching the repo convention.
- **Base-red proof:** I verified this by reading the base source rather than executing it (`git show b7038b5:apps/web/src/pages/invoice.tsx`, lines 580-592): on the base, a purchase invoice with a returnable line renders `returns-empty-action` **and** the form with `invoiceReturnsEmptyHint`, and none of the four new i18n keys exist — so all four new cases fail there on their first assertion. Running them against `b7038b5` would need a second checkout with `node_modules`; not executed.
- `tests/e2e/96-returns-supplier-action.spec.ts` (new, 164 lines): real screen path — purchase invoice via inline supplier create, asserts no `returns-empty-action`/`returns-form`, follows the link and asserts `supplier-balance`; second spec holds the post-save `returnsForInvoice` response open with `page.route` (deterministic, not timing-based), asserts card + no action + just-saved copy, then releases the gate to prove the end state. Registered in `tests/e2e-selection.map.json:144`. Not executed here (the brief allots one e2e slot).
- I did run the touched unit suites (below): 70 pass, 0 fail.

## Evidence

- `bun test src/pages/invoice-returns.test.tsx src/lib/i18n.test.ts` in `apps/web` → **70 pass, 0 fail, 809 expect() calls, 6.6s** (run with `apps/web/bunfig.toml`'s happydom preload; running the same files from the repo root fails on `document is not defined`, which is a harness detail, not a test defect).
- `git diff --stat b7038b5...7fd7aea` → 10 files, +379/-7.
- Screenshots present and non-empty: `.scratch/reviews/96/screenshots/round2/purchase-returns.png` (48 678 B), `saved-return-stale.png` (51 612 B). Not visually inspected.

VERDICT: clean
- note / low — Duplicated Code across the three `EmptyState` branches, `apps/web/src/pages/invoice.tsx:588-620`.
- note / low — three-way nested ternary for the card/form branch, `apps/web/src/pages/invoice.tsx:663`.
- note / low — purchase branch precedes the `returns.length === 0` branch, so a purchase invoice with returns would hide its history; unreachable today (only SALE invoices can own returns), `apps/web/src/pages/invoice.tsx:590`.
- note / low — `returnsUnavailable` also suppresses the completion card; no reachable path found, `apps/web/src/pages/invoice.tsx:663`.
