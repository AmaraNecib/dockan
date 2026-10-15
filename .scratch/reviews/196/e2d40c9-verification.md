# Issue 196 — verification (fail-by-name proofs + command log)

- Source SHA under test: `e2d40c91fae892092f3974c00dc4a8b634ee6b1c`
- Base: `f75721133f25bfe29766266381893520e48d6bb0` (`origin/develop`)
- Tier: Standard (test-only)
- Runner: Playwright, isolated ports `DOKAN_PORT=4387 DOKAN_WEB_PORT=5187`
  (avoids 4317/5173 shared with sibling lanes and 4399/5174 hardcoded by
  `vault.spec.ts`). `workers: 1`.

## 1. Converted specs pass

```
$ DOKAN_PORT=4387 DOKAN_WEB_PORT=5187 bunx playwright test \
    sale-checkout expense-reports invoice-payments items-flow \
    learnability purchase-intake returns settings --reporter=line
22 passed (1.9m)                                        # exit 0
```

## 2. Guard Phase 1

```
$ bun run typecheck                                      # exit 0  (3 successful)
$ bun run lint                                           # exit 0  (oxlint)
$ bun run test                                           # exit 0  (958 pass, 0 fail)
```

Targeted `tsc` over the changed e2e files reports only one pre-existing
strict-mode error unrelated to this change (`expense-reports.spec.ts:333`).

## 3. Fail-by-name proofs (temporary route-level write failure, then restored)

The pre-fix failure mode is `page.waitForResponse: Test timeout of 30000ms
exceeded`. Each proof below drives the write to fail and shows the converted
site instead fails **by name inside the 5 s expect window**.

### Proof A — sale-checkout, with-stock site (`itemsCreateWithStock`)

Temporary: `page.route("**/api/rpc/itemsCreateWithStock", (route) =>
route.fulfill({ status: 500, contentType: "application/json", body: "{}" }))`
inserted before the `sale-quick-stock` 3 write. Removed after.

```
$ DOKAN_PORT=4387 DOKAN_WEB_PORT=5187 bunx playwright test sale-checkout \
    -g "refuses a blank or zero quantity" --reporter=line
  1) sale-checkout.spec.ts:13:1 › scan create-with-stock refuses ...

  Error: expect(locator).toHaveCount(expected) failed
    Locator:  getByTestId('sale-error')
    Expected: 0
    Received: 1
    Timeout:  5000ms
    at rpc-helpers.ts:96
    at actAndAck (rpc-helpers.ts:37:5)
    at saveQuickAdd (rpc-helpers.ts:92:5)
    at sale-checkout.spec.ts:77:3                    # exit 1
```

### Proof B — purchase-intake site (`itemsCreate`)

Temporary: `page.route("**/api/rpc/itemsCreate", (route) => route.fulfill({
status: 500, contentType: "application/json", body: "{}" }))` inserted before
the quick-add quantity write. Removed after.

```
$ DOKAN_PORT=4387 DOKAN_WEB_PORT=5187 bunx playwright test purchase-intake --reporter=line
  1) purchase-intake.spec.ts:13:1 › purchase intake: picker lines, quick-add, save ...

  Error: expect(locator).toHaveCount(expected) failed
    Locator:  getByTestId('purchase-error')
    Expected: 0
    Received: 1
    Timeout:  5000ms
    at rpc-helpers.ts:96
    at actAndAck (rpc-helpers.ts:37:5)
    at saveQuickAdd (rpc-helpers.ts:92:5)
    at purchase-intake.spec.ts:64:3                   # exit 1
```

Both failures name the error surface and the exact helper call site, and land in
5 s — the synchronous-refusal guard firing, not an anonymous budget timeout.
`grep -rn "TEMP PROOF" tests/e2e/` returns nothing after restore; the converted
specs pass again (section 1 was run after restore).

## 4. What was not changed

- No timeout raised anywhere (test budget, expect timeout, or `waitForResponse`).
- No app, contract, or schema change.
- `completion-screens.spec.ts:32` remains unconverted: issue #196 lists it, the
  lane brief's authoritative eight do not. Flagged for the parent rather than
  decided silently.
- `.dokan-port` (a tracked runtime artifact written by the API at boot) was
  restored to `4317` after the isolated-port runs; it is not part of the change.
