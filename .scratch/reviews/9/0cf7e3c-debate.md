# Debate — Issue #9 Debts screen

- Issue: #9 (spec `.scratch/dokan-mvp/issues/07-debts-screen.md`)
- Tier: High-assurance (debt direction — who owes whom)
- Base SHA: `af0c7a3` (merge-base with origin/develop); evidence HEAD: `0cf7e3c`
- Reviewed at `abb665c`; debate fixes committed as `ee80f82` (see delta below)

## Process

Parallel critic + defender reviewer sub-agents over `git diff af0c7a3...HEAD`,
the issue spec, the design doc (`.scratch/implementation/9-design.md`), and the
pre-existing `debtSummaries` grouping method. Full outputs held in the lane
session (critic: 10 findings, defender: 4 defenses, no blockers).

## Verdicts that survived

- Money/direction split (`owedToUs` = SALE, `weOwe` = PURCHASE) is correct;
  both seams use `remaining_amount > 0` so fully-paid invoices never count.
- Identity rule in `listUnpaidInvoicesByParty` mirrors the `debtSummaries`
  GROUP BY key (id when present, typed name only when `counterparty_id IS
  NULL`) — the hardest acceptance criterion; no id/name merging, lone typed
  names preserved.
- Reusing the pre-existing `debtSummaries` instead of re-implementing grouping
  was correct; the new store method covers the one real gap (party-filtered
  unpaid invoices).
- Implementing the `reportsDebts` stub is the debts screen's RPC (the only
  contract seam shaped as `{ owedToUs, weOwe }`); in-lane, additive elsewhere.
- Per-row lazy drill-down (query `enabled` on expansion) is proportionate —
  no cross-party cache bleed.

## Critic findings — classification

| # | Sev | Finding | Decision |
|---|-----|---------|----------|
| 1 | 5 | Invalid HTML `id` / broken `aria-controls` when typed names contain spaces | **Fixed** (encodeURIComponent in exposed ids) |
| 2 | 4 | Unbounded drill-down payload | **Deferred** — acceptance requires the full unpaid set; no pagination seam yet. Follow-up issue recommended (see risks) |
| 3 | 3 | Contract allows id+name; store ignores name | **Fixed** (documented id-authoritative semantics + wire test for a mismatched label name) |
| 4 | 2 | Expand/reopen refetch + staleness drift | **Dismissed** — fresh refetch is safer for a money screen; reopening is cache-served |
| 5 | 2 | No focus-visible indicator on person rows | **Fixed** (`focus-visible:outline…`) |
| 6 | 2 | zod-trim vs raw DB-key drift for padded names | **Fixed** — drill-down TRIMs both sides (test-audit E1) |
| 7 | 2 | Ghost group for empty-string typed names (store-only) | **Dismissed** — unreachable via zod-validated create flows; pre-existing |
| 8 | 2 | `reportsDebts` seam collision with #31 reports lane | **Documented** — merge ownership is the parent's; additive elsewhere |
| 9 | 1 | Dead i18n keys | **Fixed** (removed) |
| 10 | 1 | Duplicated toggle closures; UUID-vs-name signature collision (theoretical) | **Fixed** (hoisted); collision **Dismissed** |

## Applied delta (reviewed-at → HEAD)

- `ee80f82`: id-safe aria-controls/id via `encodeURIComponent`, focus-visible,
  hoisted toggle, unused i18n keys removed, schema semantics documented,
  id-backed drill-down wire test added.
- Test-audit fixes (`1a18ed7`) and the code-review note (`0cf7e3c`) also landed
  after this gate; later gates reviewed the accumulated tree.

## Residual (deferred/document-only)

- Unbounded drill-down list (no pagination) — MVP-accepted, follow-up
  suggested for a future lane (#31 reports or a dedicated payments/drilling
  ticket).
- Summary groups by raw name while the drill-down matches trimmed — the app
  create flows trim, so mixed-padding only arises via store-seam seeds;
  frozen by test-audit E1.