# Debate — issue #176, Greptile round-1 fix (High-assurance)

Reviewed SHA: `a7e7f7e` (base `1840a3a`; Greptile fix delta `3a0074e..a7e7f7e`).
Adversarial critic + defender in two rounds, plus a final critic pass.

## Round 1 (critic vs defender) — at `b250ca0`

Six Greptile findings were fixed. The critic verified all six as correct and
found one RED blocker plus quality notes:

- **[RED] Process-global `mock.module("@/lib/rpc")` in `debts.test.tsx` omitted
  `DEBTS_BY_PARTY_QUERY_KEY`.** Because bun's module mocks are process-global, a
  subset run (`debts` before the two new suites) errored with "Export named
  'DEBTS_BY_PARTY_QUERY_KEY' not found". The full-suite order happened to pass,
  so it was latent.
- **Misleading folding test**: the "alef/ya" duplicate assertion used the same
  literal twice; `normalizeTextKey` does not fold alef/ya (it collapses
  whitespace and strips diacritics/tatweel).
- **Exactly-200 accept boundary untested** (only 201 was covered).
- **Dashboard `/debts` agreement untested across id-backed + typed-only +
  credit**, and the double-count guard (id-backed open invoice + ledger entry)
  unproven.
- **`["invoicesList"]` / `["activitiesList"]` were also dead flat keys** — the
  same class as finding 5, in the two files this fix touched.

The defender argued all six fixes are correct, minimal, and well-targeted
(blocking beats dropping; never auto-switch; ledger+typed-only matches /debts;
generated keys; shared sign helper).

## Round-2 fixes — commit `a7e7f7e`

- Moved the query-key prefixes to an **unmocked** `apps/web/src/lib/query-keys.ts`
  and used the same prefixes for `invoicesList` / `activitiesList`.
- `isOpeningBatchOverLimit` pins the accept boundary (199/200 allowed, 201
  blocked) + `query-keys.test.ts` pins the prefix shape.
- Corrected the duplicate-name test to a real `normalizeTextKey` variant.
- Added a dashboard test proving `weOwe === Σ /debts displayed total` across
  id-backed + typed-only + credit accounts (the double-count guard).

## Final critic pass — at `a7e7f7e`

**No blocker.** The blocker is verified fixed (subset run 37 pass / 0 fail; the
critic also proved empirically that a flat `["invoicesList"]` does not mark a
real oRPC-keyed query invalidated while `[["invoicesList"]]` does). All six
findings are correct and complete; no regression in the money/ledger/migration
code.

Residual (non-blocking, mostly out-of-diff):

1. The same dead flat keys still exist in sibling panels **not** in the #176
   feature diff (`customer-settle-panel`, `supplier-pay-panel`,
   `supplier-refund-panel`, `supplier-return-panel`, `invoice.tsx`) — a
   pre-existing systemic bug; the new `query-keys.ts` is the place to adopt a
   shared `invalidateSupplierMoneyQueries` helper. Proposed follow-up.
2. Web `supplierEntrySign` mirrors the api's pure signer and defaults a
   null-direction ADJUSTMENT to `+`; the store seam refuses such a row, so it is
   unreachable. Align eventually.
3. The ~200-row page test is slow (~17s); the pure boundary test covers the
   logic. Trim later.
4. `DEBTS_BY_PARTY_QUERY_KEY` is a literal path prefix; an oRPC key-format
   change would silently un-match it (a unit test pins the shape).
