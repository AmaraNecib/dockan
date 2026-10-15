# Issue 196 — verification (commands, exit codes, site count) — round 2, final

- Verified source SHA: `8e67761` (`test(e2e): route the receipts quick-add save through saveQuickAdd`)
- Base: `f75721133f25bfe29766266381893520e48d6bb0` (`origin/develop` merge-base)
- Tier: Standard (test-only; no app, contract, or schema change)
- Branch: `test-196-e2e-ack-sweep`
- Runner: Playwright, isolated ports `DOKAN_PORT=4387 DOKAN_WEB_PORT=5187`
  (avoids 4317/5173 defaults and 4399/5174). `workers: 1`.

## Vault-port note (#202), checked

`origin/develop` tip is `21dbc13` ("configurable vault ports … closes #193,
closes #202") and `vault.spec.ts` there reads `DOKAN_VAULT_PORT`/
`DOKAN_VAULT_WEB_PORT` (defaults 4399/5174). **This branch does not contain it**:
merge-base is `f757211`, so `vault.spec.ts:14-15` still hardcodes `4399`/`5174`.
Consequence: `DOKAN_PORT`/`DOKAN_WEB_PORT` do NOT move the vault pair on this
branch, so the shared pair was kept off 4399/5174. Because vault's pair is
hardcoded, a full run needs 4399/5174 free, and only one e2e lane may run.

## 1. Isolated single spec (receipts, the changed file)

```
$ DOKAN_PORT=4387 DOKAN_WEB_PORT=5187 bunx playwright test receipts --reporter=line
1 passed (12.8s)                                         # exit 0
```

Run on the pre-commit working tree; `8e67761` is the same content.

## 2. Guard Phase 1

```
$ bun run typecheck                                      # exit 0  (3 successful)
$ bun run lint                                           # exit 0  (oxlint)
```

## 3. Guard Phase 2 — full suite (at `8e67761`)

First run failed on the known vault cold-start race, not on any `#196` change:

```
$ DOKAN_PORT=4387 DOKAN_WEB_PORT=5187 bun run test:e2e -- --reporter=line
1 failed  tests\e2e\vault.spec.ts:113  getByRole('heading', { name: 'إنشاء الخزنة' })
          DOM: alert "تعذّر الاتصال بالخادم"  (vault web could not reach its API yet)
2 did not run
54 passed (5.5m)                                         # exit 1
```

`receipts.spec.ts:22` passed inside that run. The vault spec spawns its own
API+web pair on the hardcoded 4399/5174 after 5.5m of suite load; the 5 s
first-navigation window raced the cold Vite start. Reproduced clean in
isolation, so the failure is environmental, not the diff:

```
$ DOKAN_PORT=4387 DOKAN_WEB_PORT=5187 bunx playwright test vault --reporter=line
3 passed (24.6s)                                         # exit 0
```

Clean immediate re-run of the whole suite at the same SHA:

```
$ DOKAN_PORT=4387 DOKAN_WEB_PORT=5187 bun run test:e2e -- --reporter=line
57 passed (5.3m)                                         # exit 0
```

`receipts.spec.ts:22` and all three `vault.spec.ts` tests green in this run.

## 4. One-shape count (acceptance: every quick-add ack site)

- `saveQuickAdd` call sites: **15**, across **10 specs** — sale-checkout 4,
  returns 2, learnability 2, and expense-reports / invoice-payments / items-flow
  / purchase-intake / settings / completion-screens / receipts 1 each.
- Remaining inline quick-add save clicks: **3**, all in
  `sale-checkout.spec.ts:56, 62, 69` — the "refuses a blank or zero quantity"
  test's deliberate no-request refusals (assert the Arabic message by name).
  These are not ack sites; arming an ack there hangs by construction (#191).
- No inline `منتج جديد سريعاً` clicks remain.

**Verdict: every quick-add ack site now shares the one `saveQuickAdd` shape;
0 inline ack sites remain.**

## 5. What was not changed

- No timeout raised anywhere (`playwright.config.ts` still `timeout: 30_000`).
- No app, contract, or schema change.
- `.dokan-port` (a tracked runtime artifact rewritten by the API at boot) was
  restored to its committed value after the isolated-port runs; it is not part
  of the change.
- Nothing pushed (parent instruction).
