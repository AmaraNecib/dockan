# Issue 191 — design: the sale save can hang 30s waiting for `invoicesCreate`

- Tier: **Standard** (spec-only change; no production code touched)
- Base: `origin/develop` @ `da44b502d39c79a1368e9848542d9a25fac301fc`
- Branch: `fix-191-receipts-ack`
- Evidence: `.scratch/reviews/191/<sha>-{debate,test-audit,code-review}.md`

## The reported failure

`gh run 38464745468` (56 tests, 1 worker, 5.3m): 55 passed, 1 failed.

```
tests/e2e/receipts.spec.ts:22 → Error: page.waitForResponse: Test timeout of 30000ms exceeded.
  at waitForRpc (rpc-helpers.ts:16) → actAndAck (rpc-helpers.ts:35) → receipts.spec.ts:60:11
```

Line 60 is the #185 replacement: arm `invoicesCreate`, click `sale-save`, read the
server-issued invoice number from the ack. No artifact from that run survives (the
e2e job uploads nothing), so nothing beyond the log line above can be recovered.

## What the app actually does (read + measured, not assumed)

From `apps/web/src/pages/sale.tsx`:

- `quickSubmit()` calls **`itemsCreateWithStock`** whenever an opening stock is
  given (the spec fills stock 2 → this procedure, never `itemsCreate`) and adds the
  cart line **only from that call's `onSuccess` response** (sale.tsx:445-450). There
  is no optimistic line, and the row is keyed on the server-assigned
  `item.id` (`name={`quantity-${line.item.id}`}`, sale.tsx:584).
- The checkout bar — `sale-total` **and** `sale-save` — renders only when
  `lines.length > 0` (sale.tsx:595), so the spec's `sale-total` assert already
  proves a cart line exists.
- `sale-save` is `disabled={createInvoice.isPending || createItem.isPending ||
  createWithStock.isPending}` (sale.tsx:608): the *save* is gated on the
  *quick-add's* write. `submit()` refuses client-side, and records it in
  `data-testid="sale-error"`, only for: empty cart, a party that needs picking, an
  invalid or over-total paid amount, an invalid discount, an invalid override, an
  invalid quantity (sale.tsx:322-407).

Measured with a temporary instrumented copy of the spec that dumped the DOM at the
instant `sale-total` reads 900 (the pre-click state), plus `/api/rpc` request and
response timings:

| condition | runs | pre-click state | save ack |
|---|---|---|---|
| local, `--workers=2`, repeat-each | 120 | 1 line, total 900, paid 500, pct 56, no `sale-error`, `sale-save` **enabled** | 92–274ms |
| forced 3s delay on `itemsCreateWithStock` | 3 | identical | 92–122ms |
| last spec of a full 56-test suite (grown DB) | 1 | identical | 135ms |

What this rules out:

- **No unresolved item id**: the line exists only after the server answered, so the
  id is always resolved, and the cart row is keyed on it.
- **No observed disabled window**: 0 of 120 runs showed `saveDisabled:true` while
  `sale-total` read 900. React Query calls the mutation's `onSuccess` *before* it
  dispatches the `success` update that clears `isPending`
  (`@tanstack/query-core@5.101.4` mutation.js:160), but the two updates land in one
  React commit in practice, so the window is sub-frame at most.
- **No client-side refusal**: `sale-error` was empty in every run, so the refusal
  paths are not what CI hit.
- **No server slowness**: `invoicesCreate` answered in 92–135ms even at the end of a
  full suite with the accumulated e2e database.
- **CI is not uniformly slower**: the same 56-test suite takes 5.2m locally vs 5.3m
  in CI.

## Root-cause verdict (honest scope)

The app does not block, refuse or stall this save; the issue's hypothesis is
disproven as stated (there is no optimistic line with an unresolved id, and the save
is never refused). The CI stall itself is **not definitively attributable** from the
surviving evidence. Two explanations remain, and this change addresses the defect
they have in common rather than pretending to pick one:

1. the pre-save phase consuming the 30s per-test budget (`playwright.config.ts:20`)
   so the clock expires inside whichever wait is outstanding — a `page.waitForResponse`
   timeout is emitted by *any* outstanding wait, and says nothing about whether the
   request was sent; or
2. a transport/scheduling stall in that one run.

Both are invisible because of the **actual defect**: the spec arms an unbounded wait
for a request it has no independent evidence about, and asserts none of the state the
app already surfaces (`sale-lines`, `sale-save`'s disabled state, `sale-error`). Any
of a refused submit, a click the browser drops, a stuck write or an exhausted budget
degrades into the same unattributable 30s message. That is also why this issue was
hard to root-cause in the first place.

Reproduction attempts, recorded as negative results:

- 120 instrumented runs and a full-suite run never produced the symptom.
- A naive "slow CI" emulation cannot produce it either: CDP CPU throttling
  (`Emulation.setCPUThrottlingRate` 6 and 10 on the pre-fix spec verbatim) fails
  first at an earlier 5s `expect().toBeVisible()`, not at the ack. Uniform client
  slowness is therefore *not* the profile; the reported signature needs either
  several seconds of action-level delay per step (under the 5s assert caps, summed
  past 30s) or a single stalled request.

## The fix (spec-only)

`tests/e2e/receipts.spec.ts`:

1. Ack the quick-add's own write before touching the rest of the form:
   `actAndAck(page, "itemsCreateWithStock", …)`. This makes the cart's `itemId` a
   server fact rather than a render guess — the created `id` is now actually used,
   asserting the cart row is keyed on it (`name="quantity-<id>"`) — and removes the
   last writer of `sale-save`'s disabled state before the click.
   The correct procedure is `itemsCreateWithStock`, **not** `itemsCreate` as the
   brief suggested: the form takes the with-stock path whenever a quantity is given,
   and an ack armed for the wrong procedure hangs the full budget by construction.
2. Assert the pre-click state the app already surfaces — the created row, its
   value, the server-issued id, and `sale-save` enabled — so a stuck cart or a stale
   disabled state fails *here* by name.
3. Assert inside each action that no client-side refusal was recorded
   (`sale-error` count 0). `submit()`/`quickSubmit()` record a refusal synchronously
   and send nothing, so this keeps "refused, so no request" a named ≤5s failure
   instead of an unattributable wait.
4. Keep the #179 pattern for the save and keep taking the invoice number from the
   response body.

No app change. The app already exposes both states it needs to (a `disabled`
attribute and a `sale-error` alert), so the issue's requirement 3 — "surface that
state so the spec can assert on it" — is met by asserting it. The client-side block
is real (saving while an item write is in flight would omit the just-created item
from the invoice), so it is asserted against, not removed. Spec-only keeps the tier
at Standard; the brief pins High-assurance to app-code changes.

## Interfaces

None. Test-only change; no public API, component or contract is touched.

## Dependencies

- `itemsCreateWithStock`'s contract output is `itemSchema` (an `Item`,
  `packages/contracts/src/app-contract.ts:111`), so the created row's `id` is
  readable from the ack (`{ id: string }`, same shape as
  `tests/e2e/invoice-print-a4.spec.ts:145-151`).
- `actAndAck` / `rpcOutput` / `waitForRpc` in `tests/e2e/rpc-helpers.ts` are used
  unchanged (issue 179).
- Cart-row locators follow the existing convention (`sale-lines` +
  `getByLabel("<name>: الكمية")`, as in `sale-checkout.spec.ts:122`).

## Planned tests

- The spec is the test: it is the failing artifact. Verified by 6 clean sequential
  `--workers=2` runs on the final content plus Guard Phase 2's full-suite run.
- The temporary instrumented spec and the pre-fix reproduction copy are deleted
  before commit; their measurements are the evidence, not shipped artifacts.

## Review outcomes (what the pipeline changed)

- **Debate (critic)**: BLOCKER that the disabled-click mechanism is unreachable and
  unproven. Accepted — the commit message and comments no longer claim a mechanism;
  the verdict above is what the evidence supports. Also flagged that the added acks
  would turn a *refusal* regression into a 30s hang; addressed by the in-action
  `sale-error` asserts (fix item 3).
- **Debate (defender)**: confirmed the procedure name, the no-optimistic-line claim
  and the disabled gate from source.
- **Test audit**: `rpcOutput<{id: string}>` was computed and discarded; the id is now
  asserted against the cart row, and the pre-click `sale-error` check (which could
  not catch a post-click refusal) is replaced by in-action asserts.
- **Code review (Standards)**: comment style, testids, Arabic labels and commit
  convention all conform; no timeout was loosened.
- **Code review (Spec)**: confirmed `itemsCreateWithStock` is the correct procedure
  and that the crew brief's `itemsCreate` would have hung by construction.

## Risks and follow-ups

- The rest of the suite has the same shape: 8 specs click the quick-add save and
  rely on a 5s UI poll with no ack (`sale-checkout`, `invoice-payments`, `returns`,
  `expense-reports`, `completion-screens`, `learnability`, `items-flow`, plus the
  unstaged siblings of the same flow). Out of scope for a single-issue fix, and
  handed to the parent as a tracked follow-up in the lane report (no silent
  deferral).
- The 30s budget for this spec stays thin (~10.5s locally). It is not loosened; the
  new asserts make an overrun attributable instead.
