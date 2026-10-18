# Issue 151 — Code review (Standards + Spec)

Head reviewed: `9a287d8` (merge-base `3c3abcf`). Two independent reviewer
children ran the Standards and Spec axes against `git diff 3c3abcf...d8355fd`;
findings below are synthesized against the final head.

## Standards

**Correct / verified**

- `bg-warning` / `text-warning-foreground` are real theme tokens
  (`apps/web/src/index.css`), so the badge uses the design system.
- `supersededByCorrection` is pure, exported, documented, and unit-tested
  (`apps/web/src/pages/stock.tsx`, `stock.test.tsx`).
- E2E for the user-facing flow is present per `feature-implement` §3.
- Tracking `.scratch/implementation/151-design.md` matches
  `docs/engineering-workflow.md`.

**Findings**

| Finding | Severity | Verdict |
|---|---|---|
| Review evidence missing at the reviewed head (`.scratch/reviews/151/`). | Blocker (documented standard) | **Resolved** by this evidence set. |
| Duplicated Code: the e2e `rpc` helper repeats the `{json}` envelope unwrap already in `rpc-helpers.ts`. | Judgement call | **Dismissed for this ticket.** The same local helper is the established pattern in `pagination.spec.ts` and `supplier-adjustment.spec.ts`; a shared `seedRpc` is a follow-up. |
| Primitive Obsession: `reason` compared to the literal `"COST_CORRECTION"`. | Judgement call | **Dismissed.** The same literal is already the view's token boundary via `movementReasonText` in the same file. |
| Data Clumps: `PrecedenceRow` restates four movement fields. | Judgement call | **Dismissed.** A deliberate minimal structural type keeps the helper unit-testable without the full contract type. |
| `supersededByCorrection` is O(n²) over the page. | Note | **Dismissed.** Page sizes are small; revisit only if pagination grows. |

## Spec

**Missing / partial**

- Recording order is inferred from `createdAt`, not the ledger's `seq`
  (the issue names `seq`). The api strips `seq` and the brief forbids a
  contract change, so this is a documented partial: same-second inserts
  under-annotate. Never misleads — it never claims a replacement that did not
  happen and never changes a displayed number.
- Page-local check (see Standards/design Known limits). Out of scope for the
  same contract reason.

**Scope creep** — none in product code. The `rpc` helper and seed types are test
scaffolding; no API, schema, ledger, or money-path change.

**Implemented but wrong** — none found. The predicate is sound:
`row.createdAt < correction.createdAt` with the correction drawn above the row
means the row's segment was closed by a later-recorded correction, so its
average contribution was replaced.

**Addressed before commit**

- The e2e now proves the precedence (correction row above the future row) and
  that only the superseded row is badged, not just the count.

## One-line summary

Standards: 1 blocker (evidence, now resolved) + 4 dismissed judgement calls.
Spec: 0 missing product requirements beyond the two documented contract-bound
limits; 1 test-strength gap fixed. No money-path or ordering change.
