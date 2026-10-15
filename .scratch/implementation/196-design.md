# Issue 196 — design: apply the quick-add ack/gate hardening to the eight sibling specs

- Tier: **Standard** (test-only; no app, contract, or schema change)
- Base: `origin/develop` @ `f75721133f25bfe29766266381893520e48d6bb0`
- Branch: `test-196-e2e-ack-sweep`
- Evidence: `.scratch/reviews/196/<sha>-{test-audit,code-review}.md`
- Depends on #191 (merged): `tests/e2e/rpc-helpers.ts` and the `receipts.spec.ts` shape exist.

## Problem

After a quick-add save, eight specs still assert the rendered line inside
Playwright's default 5 s `expect` window instead of awaiting the write's server
ack. When the app refuses synchronously (unpicked category, rejected stock, bad
price, needs-choice party) the spec sends nothing and the failure surfaces as an
anonymous `page.waitForResponse: Test timeout of 30000ms exceeded` (#191's
failure mode) rather than a named failure in the 5 s window.

#191 converted one site (`receipts.spec.ts`, sale quick-add with stock). This
issue extracts that shape into a helper and applies it across the sibling specs.

## Public API — one function in `tests/e2e/rpc-helpers.ts`

```ts
export type QuickAddProcedure = "itemsCreateWithStock" | "itemsCreate";

export interface QuickAddSave {
  /** The procedure the form actually calls for THIS spec's inputs. */
  procedure: QuickAddProcedure;
  /** The quick-add form's save control; asserted enabled before the click. */
  save: Locator;
  /** Where the form records a synchronous client-side refusal. */
  error: Locator;
  /** The line table the created item lands in. */
  lines: Locator;
  /** The created item's name; scopes the line-key assertion. */
  itemName: string;
  /** The line-quantity input's aria-label suffix ("الكمية"). */
  quantityLabel: string;
}

export async function saveQuickAdd(page: Page, options: QuickAddSave): Promise<{ id: string }>;
```

Contract, in order:

1. `expect(options.save).toBeEnabled()` — a disabled save can never send the
   request the ack waits for; a stale gate must fail here by name.
2. `actAndAck(page, options.procedure, …)` around the click, and inside the
   action `expect(options.error).toHaveCount(0)` — the synchronous-refusal guard.
3. `expect(options.lines.getByLabel(`${itemName}: ${quantityLabel}`)).toHaveAttribute("name", `quantity-${id}`)`
   — the line is added only from the create response and is keyed on the id the
   server issued; this turns "the item exists" into a server fact.

Returns the server-issued id so a caller can use it further if it wants.

### Procedure routing — why `procedure` is a parameter, not hardcoded

`apps/web/src/pages/sale.tsx` routes `quickSubmit()` on the resolved opening
stock: a positive quantity takes `itemsCreateWithStock`, a blank/zero one takes
`itemsCreate`. `apps/web/src/pages/purchase.tsx` has no with-stock path at all —
its quick-add always calls `itemsCreate`. #191 proved that arming the wrong
procedure hangs the full test budget by construction.

So the helper takes the procedure the form actually calls for the spec's own
inputs. The sale-with-stock sites pass **`itemsCreateWithStock`** (the case the
brief's rule is about); the plain-sale and purchase sites pass `itemsCreate`.
Hardcoding `itemsCreateWithStock` would hang `items-flow`, `learnability`,
`purchase-intake`, and `settings` — exactly the failure #191 warned against.

## Sites converted

| Spec | Site(s) | Procedure | Line after conversion |
|---|---|---|---|
| `sale-checkout` | 4 quick-add writes (3 with a following `sale-lines` poll + the oversell item) | `itemsCreateWithStock` | `expect(sale-lines)` kept |
| `expense-reports` | 1 | `itemsCreateWithStock` | kept |
| `invoice-payments` | 1 | `itemsCreateWithStock` | kept |
| `items-flow` | 1 (zero-price, blank stock) | `itemsCreate` | kept |
| `learnability` | 2 (`addStockedLine` sale; `addQuickStockLine` purchase) | `itemsCreateWithStock` + `itemsCreate` | kept |
| `purchase-intake` | 1 | `itemsCreate` | kept |
| `returns` | 2 | `itemsCreateWithStock` | kept |
| `settings` | 1 | `itemsCreate` | kept |

Not converted: the sale-checkout validation refusals (blank/0/-1 stock) — these
send nothing by design, already assert their Arabic message by name, and arming
an ack there would hang.

## Preserved assertions

Each existing `await expect(lines).toContainText(itemName)` stays; the helper
converts a wait, it does not weaken a check.

## Tests (fail-by-name proof)

No new spec: the proof is that at least two converted sites go red **by name**
when the write is broken, within the 5 s expect window — not the 30 s budget.
Plan: temporarily `page.route("**/api/rpc/itemsCreateWithStock", …)` with a
synchronous refusal (or a reverted assertion), run the spec, record the named
failure, then restore. Evidence in `.scratch/reviews/196/`.

## Risks

- `expect(error).toHaveCount(0)` could mask a *legitimate* pre-existing error if
  a spec leaves one on screen. Verified: `useQuickAdd.submit` calls
  `setError(null)` synchronously at the top of every submit, and every converted
  site starts from a clean error state.
- The `itemsCreate` sites are purchase/plain; arming `itemsCreateWithStock`
  there would hang. Mitigated by the required `procedure` parameter.
- Shared-DB / port collisions with sibling lanes: run e2e on an isolated pair
  that avoids `4399`/`5174` and only one lane at a time.
- No timeout increase anywhere.
