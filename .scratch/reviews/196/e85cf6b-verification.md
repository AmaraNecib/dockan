# Issue 196 — verification (fail-by-name proofs + command log)

- Reviewed source SHA: `e85cf6bb36da0758049780135e3da766ad138bf9`
- Base: `f75721133f25bfe29766266381893520e48d6bb0` (`origin/develop`)
- Tier: Standard (test-only)
- Runner: Playwright, isolated ports `DOKAN_PORT=4387 DOKAN_WEB_PORT=5187`
  (avoids 4317/5173 shared with sibling lanes and 4399/5174 hardcoded by
  `vault.spec.ts`). `workers: 1`.
- Scope: 9 specs — the brief's eight plus `completion-screens`, added after the
  parent accepted the deviation analysis and confirmed it is issue-listed.

## 1. Converted spec added this round

```
$ DOKAN_PORT=4387 DOKAN_WEB_PORT=5187 bunx playwright test completion-screens --reporter=line
1 passed (7.4s)                                          # exit 0
```

The first cold run of that single spec raced the freshly booted API (the auth
gate did not render within 5 s); it passed on the immediate re-run and inside the
full suite. Cold-start artifact, not the conversion — the conversion itself is
exercised below the auth gate.

## 2. Converted specs pass together

```
$ DOKAN_PORT=4387 DOKAN_WEB_PORT=5187 bunx playwright test \
    sale-checkout expense-reports invoice-payments items-flow \
    learnability purchase-intake returns settings --reporter=line
22 passed (1.9m)                                         # exit 0
```

## 3. Guard Phase 1

```
$ bun run typecheck                                      # exit 0  (3 successful)
$ bun run lint                                           # exit 0  (oxlint)
$ bun run test                                           # exit 0  (958 pass, 0 fail)
```

Targeted `tsc` over the changed e2e files reports only one pre-existing
strict-mode error unrelated to this change (`expense-reports.spec.ts:333`).

## 4. Guard Phase 2 — full suite

The first full run during this round failed 5 specs (login, pagination,
purchase-intake, supplier-adjustment, vault) with `2 did not run`; crew_status
showed sibling lanes `feat-183`, `feat-184` and `test-193` all active at the
time, and the failures were the scattered auth-gate/load pattern the wisdom
(`2026-10-15-concurrent-lane-e2e-ports.md`, `2026-10-13-e2e-stale-server-and-checksum-flake.md`)
attributes to a concurrent full-suite run (plus vault's hardcoded 4399/5174).
With the box quiet (no listeners on any of the six ports, no sibling e2e
process) the immediate re-run was clean:

```
$ DOKAN_PORT=4387 DOKAN_WEB_PORT=5187 bun run test:e2e -- --reporter=line
57 passed (6.3m)                                         # exit 0
```

## 5. Fail-by-name proofs (temporary route-level write failure, then restored)

The pre-fix failure mode is `page.waitForResponse: Test timeout of 30000ms
exceeded`. Each proof drives the write to fail and shows the converted site
fails **by name inside the 5 s expect window**.

`git diff e2d40c9 e85cf6b --name-only` is `tests/e2e/completion-screens.spec.ts`
(plus scratch docs only), so `rpc-helpers.ts`, `sale-checkout.spec.ts` and
`purchase-intake.spec.ts` are byte-identical to the run that produced these
proofs; they remain valid for this SHA.

### Proof A — sale-checkout, with-stock site (`itemsCreateWithStock`)

Temporary: `page.route("**/api/rpc/itemsCreateWithStock", (route) =>
route.fulfill({ status: 500, contentType: "application/json", body: "{}" }))`
before the `sale-quick-stock` 3 write. Removed after.

```
$ DOKAN_PORT=4387 DOKAN_WEB_PORT=5187 bunx playwright test sale-checkout \
    -g "refuses a blank or zero quantity" --reporter=line
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
status: 500, contentType: "application/json", body: "{}" }))` before the
quick-add quantity write. Removed after.

```
$ DOKAN_PORT=4387 DOKAN_WEB_PORT=5187 bunx playwright test purchase-intake --reporter=line
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
5 s. `grep -rn "TEMP PROOF" tests/e2e/` returns nothing after restore.

## 6. What was not changed

- No timeout raised anywhere (test budget, expect timeout, or `waitForResponse`).
- No app, contract, or schema change.
- `.dokan-port` (a tracked runtime artifact written by the API at boot) was
  restored to `4317` after the isolated-port runs; it is not part of the change.
- Greptile: no local run this round — the parent runs the hosted review on the PR
  (per the parent's Q1 decision).
