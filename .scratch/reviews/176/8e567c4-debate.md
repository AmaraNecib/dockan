# Debate — issue #176, Greptile round-2 fix (High-assurance)

Reviewed SHA: `8e567c4` (base `1840a3a`; round-2 fix `f7e7661..8e567c4`).
Substantive review at `895d1c9` (3 agents) plus a final focused pass at
`8e567c4` (safe-integer bound).

## Round-2 findings (Greptile at 3/5)

1. **Dashboard weOwe broke on a supplier credit.** Round 1 made
   `dashboardSummary.weOwe` include the signed supplier ledger, but
   `dashboardSummaryOutputSchema.weOwe` was still `dinarsSchema` (min 0). A shop
   whose only supplier carries a 300 THEY_OWE balance computed `weOwe: -300`, so
   the response failed output validation and the dashboard cards vanished.
2. **`parseBulkAmount` inflated a decimal 100×.** It deleted every comma/space
   before parsing, so `1 000,00` became `100000` DZD.

## Fixes — commits `895d1c9`, `8e567c4`

- Contract: `weOwe` is now explicitly **signed**
  (`z.number().int().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER)`)
  with a doc comment stating positive = the shop owes suppliers, negative = the
  shop is ahead (matching the `/debts` supplier group total). The dashboard
  renders a `dashboardSupplierCredit` subline with `Math.abs` instead of a
  negative debt. The customer side is unchanged.
- Router tests: the output contract accepts `weOwe: -300`; the RPC rejects a
  value beyond ±`MAX_SAFE_INTEGER`; and a credit-only shop's `dashboardSummary`
  resolves with `weOwe < 0` equal to the `/debts` supplier net.
- `parseBulkAmount` validates the shape first: plain digits or valid 3-digit
  grouping (`1 000`, `1,000`, `٢٥٬٠٠٠`) are accepted; a decimal or malformed
  separator (`1 000,00`, `1,5`, `1 00`, `1,0000`, `1000,000`, `,1000`, `1,00,0`,
  `1٬00`) returns `null`, and the row shows an error and blocks the save. No
  separator is deleted to produce a different number.

## Final critic pass — at `8e567c4`

**No blocker.** Both findings correct and complete; tests verified green; the
parser is the only separator-tolerant reader (other amount inputs use the
stricter `parseWholeAmount`, so the 100× bug cannot recur).

Residual (non-blocking):

1. **The explicit `.min/.max` is redundant.** zod v4's `.int()` already enforces
   the safe-integer range, so the reject assertions pass against
   `z.number().int()` alone; they document the contract rather than guard the
   bound commit. The real round-2 guard is the `weOwe: -300` accept case.
2. `/debts` still renders the supplier group total as a raw negative
   (`debts.tsx` group header) while the dashboard now labels the credit — a
   presentational disagreement, pre-existing. Proposed follow-up.
3. Only the bulk screen accepts grouped amounts; the single-entry forms reject
   `1,000`. Safe (fails closed) but inconsistent; one shared tolerant parser
   would consolidate.
4. The `8e567c4` commit is defense-in-depth; no production behavior change.
