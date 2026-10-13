# Issue 174 — Round 1 test-audit evidence

Base: `8bf2a81`. Round-1 delta: `e84d592..d8d21f4`. Evidence anchor:
`d8d21f4`.

Three read-only `reviewer` sub-agents ran in parallel: Edge Case Hunter,
Coverage Analyst, Quality Reviewer.

## Findings and dispositions

| Agent | Finding | Disposition |
|---|---|---|
| All three | The brief's required test exists and is genuine: `failPayAt = 2` over two invoices; the mock models the server write; the unpaid filter is toggled **before** the settle so the assertion cannot pass via a query-key change. It times out with the wiring removed (verified). | **Confirmed.** |
| Coverage / Edge | The third tab (`supplierEntries`) had zero round-1 refresh coverage. | **Fixed** in `d8d21f4`: added a successful supplier-pay test and a failed supplier-pay test, both asserting the paged supplier-entries query re-reads (the failure test fails without `onWriteFailed`). |
| Quality | The mock left `stats` stale, had no over-remaining refusal, and re-implemented the payment arithmetic differently in the two pay mocks. | **Fixed**: shared `applyPayment` helper, `statsOf` recompute, and an over-remaining refusal in the invoices-pay mock. |
| Quality | A fixed `flushAsync` guarded the halted assertion. | **Fixed**: replaced with `waitFor(() => halted element present)`. |
| Edge | A middle failure (≥3 invoices) is not covered. | **Dismissed** — the two-invoice `failPayAt=2` case is exactly the brief's partial-failure path; `failPayAt=1` covers the nothing-landed direction. |
| Edge | "Committed then lost response" is not modelled (the failing mock throws before mutating). | **Partially addressed / deferred**: the unconditional refresh is pinned by the first-write-failure test and the supplier failure test. Modelling a lost response precisely needs a response-loss harness; the rationale is documented, and the behaviour (refresh on any failure) is what the code guarantees. |
| Edge | A failure inside `refresh()` after all writes landed would halt a fully settled batch. | **Dismissed** — pre-existing `CustomerSettlePanel` behaviour, not introduced here; the writes are persisted and the tabs refresh via `onWriteFailed`, so money is not lost. Separate follow-up. |
| Edge | Supplier-return "two sequential mutations". | **Dismissed — misread**: the calls are mutually exclusive `if/else` branches. |
| Quality | Method (BANK) branch untested; positional row assertions. | **Dismissed** — low value; the method select is exercised elsewhere and the assertions pin the invoice number. |
| Quality | Grade B+ → the fidelity/timing fixes above raise it. | — |

## Verification after the fixes

- `bun run typecheck` — 3/3 packages.
- `bun run lint` — clean.
- `bun run test` — 3/3 packages (web 848 tests).
- `tests/e2e/pagination.spec.ts` and the full `bun run test:e2e` — 55 passed.
- Discriminator checks run: the customer partial test and the supplier-pay
  failure test both fail with the callback unwired and pass with it wired.

No test change altered production behavior beyond the intended refresh.
