# Test Audit — Issue #9 Debts screen

- Issue: #9 (spec `.scratch/dokan-mvp/issues/07-debts-screen.md`)
- Tier: High-assurance; Base SHA: `af0c7a3`; evidence HEAD: `0cf7e3c`
- Reviewed at `ee80f82`; audit fixes committed as `1a18ed7` (delta below)
- 3 parallel sub-agents: edge-case hunter, coverage analyst, quality reviewer

## Verdict

No blockers. Coverage verdict: high — every acceptance bullet has coverage at
an appropriate seam (store / RPC wire / component / E2E), tests are diverse
(4 different data paths), and no duplicate coverage to remove. E2E creates a
sale debt AND a purchase debt then asserts both groups, as mandated.

Grades: store describe A−, router describe B, component B+, e2e B+.

## Findings — classification

| ID | Sev | Finding | Decision |
|----|-----|---------|----------|
| E1 | 🟠 | Padded stored name: summary row (raw key) whose drill-down was empty (trimmed input) | **Fixed** — store TRIMs both sides; round-trip test added |
| E2 | 🟠 | Same typed name in both directions not pinned (regression guard on the kind filter) | **Fixed** — direction-scoped summary + drill-down test added |
| E3 | 🟡 | id-authoritative with a mismatched label name untested at the wire seam | **Fixed** — router test asserts id authority despite a different name |
| E4 | 🟡 | Component error/empty drill-down branches untested | **Fixed** — mock fail-switch; error alert (real server key) + empty drill-down tests |
| E5 | 🟡 | Overpaid (negative remaining) exclusion untested | **Fixed** — store test |
| E6 | 🟡 | RTL never asserted | **Fixed** — e2e asserts `html[dir=rtl]` |
| E7 | 🟡 | Misc: cross-group toggle, group-header sums, id-backed name fallback, ordered drill-down, dead setup | **Fixed** — cross-group toggle test, distinct `debts-group-*-total/count` testids asserted in component + e2e, id-backed render test, ordering test, removed dead setup |

## Applied delta (reviewed-at → HEAD)

- Store: `TRIM(counterparty_name) = TRIM(?)` on the typed-name branch.
- New tests: padded-name consistency, same-name direction scoping, overpaid
  exclusion, invoice-date ordering, id-mismatch authority, component
  error/empty/cross-toggle/id-fallback/group-sum branches, e2e RTL + header
  totals.
- Page: distinct `data-testid` spans for group totals/counts.

## Residual

- Shared-DB test files rely on in-file description ordering and unique party
  names (documented pattern in this suite; debts describes sit last).
- Error-path coverage uses the mocked rpc seam, consistent with other pages
  (network errors at the browser level are not simulated in E2E).