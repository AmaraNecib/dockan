# Test Audit — Ticket #10 @ c208830 (Greptile round-3 refresh)

- Tier: Standard · Base: c1bec84 · Head: c208830
- Prior audit: `0b7d644-test-audit.md` (3-agent battery, PASS). This file
  refreshes the audit for the round-3 delta: 2 new deterministic tests.

## Delta under audit

1. **Router atomicity test** (`router.test.ts` "rolls the identity write
   back when the audit insert fails (atomicity)"): baseline identity →
   rebuild app+router over a failing-store wrapper whose transaction-unit
   `insertActivity` throws → assert the call rejects, `settingsGet` still
   returns the baseline (rollback), and the SETTINGS_UPDATED audit count is
   unchanged (no phantom row).
   - Edge-case value: injects failure at exactly the seam Greptile flagged
     (audit insert inside the tx), proving BEGIN/ROLLBACK semantics through
     the real HTTP seam + real sqlite — not a mocked transaction.
   - Mutation-checked by the author: reverting the fix to the old two-call
     wiring makes this test fail (identity stays committed). Deterministic.
   - Isolation: uses a fresh per-test app+client; shares the suite db like
     the rest of the file (suite convention, order-stable).
2. **InvoiceHeader state test** (`invoice-header.test.tsx`, 3 cases):
   - loading: never-resolving seam → skeleton rendered, no identity text.
   - error: rejecting seam (QueryClient `retry:false` so no retry storm) →
     alert + retry rendered, no identity text; then seam healed + retry click
     → identity + canonical phone appear.
   - loaded: identity + phone rendered.
   - Determinism: mode-driven mock seam; act-wrapped polling; no wall-clock
     sleeps tied to production constants.

## Coverage — round-3 criteria

| Criterion | Covered by |
| --- | --- |
| Atomic rollback on audit failure (identity not persisted, no phantom audit) | router atomicity test (rollback + audit-count assertions) |
| Header loading state visible (never silent blank) | header test case 1 |
| Header error + retry recoverable | header test case 3 (alert → retry → data) |
| Header success renders identity | header test case 2 + existing E2E |
| No regression: edit→save→reload→header | ticket10.spec (10/10 e2e) |

## Gates at c208830

`bun run typecheck` 3/3 · `bun run lint` clean · `bun run test` api
**158/158** + web **19/19** (all pass — the earlier pre-existing backups
flake is fixed by 8e80686) ·
`DOKAN_PORT=4323 DOKAN_WEB_PORT=5179 bun run test:e2e -- --workers=1` 10/10 ·
`.dokan-port` restored byte-exact to 4317 · working tree clean.

## Residual notes

- act() console warnings in the header retry test (react-testing hygiene,
  no determinism impact).
- Atomicity test shares the single sqlite conn with the suite (matches file
  convention); discrimination of COMMIT-order is by behavior, not by
  instrumentation.

**VERDICT: PASS.**