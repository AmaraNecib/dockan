# Issue #68 — Code-review evidence

Base: `f4d4674` · Head: `66ccfc2` · Branch: `fix/68-return-debt`

Two parallel reviewer sub-agents (Standards + Spec axes) over
`git diff f4d4674...HEAD`, the design doc, and the issue text.

## Standards axis

All documented repo standards verified met:
- `SAFETY:` comments precede type assertions (router accept, PRAGMA casts).
- Locale-neutral API strings; Arabic copy confined to web i18n.
- `db/schema.ts` drizzle table + `SCHEMA_DDL` in sync (`debt_applied`).
- Store method added to `StorePort` and implemented in the drizzle adapter.
- Money writes stay behind the guarded conditional UPDATE;
  `setDebtApplied` is record-keeping.
- `BEGIN IMMEDIATE` for every multi-write unit (accept tx, migration pair).
- Append-only ledger facts untouched; only review marks/status move.

Baseline smells noted as judgement calls, no blockers:
- Relief rule re-encoded in `debtOffsetDisplay` (API applies money, UI
  presents state — different concerns).
- `(status, debtOffset, debtApplied)` scalar clump to the display helper.
- Primitive status strings — consistent with the codebase's existing
  status handling.

## Spec axis

All six design decisions implemented and tested:
1. Deferral to `returnsAccept` (router.ts) — verbs verified.
2. Cap `min(debtOffset − debtApplied, remaining-at-accept)` — matches.
3. REJECTED never applies — verified + tested.
4. Cash stays immediate at creation — split math unchanged.
5. Status-aware labels on card, voucher (ACCEPTED shows `debtApplied`), and
   the panel note. One wording deviation (legacy REJECTED rows read as
   «مطبّق») — aligned in the design doc (66ccfc2) as the correct reading of
   the backfill.
6. Transactional migration + backfill — idempotent, tested.

No missing requirements, no scope creep, no wrong implementations.
Residual notes: over-promised portions drop silently (accepted tradeoff,
flagged in the design doc §5); legacy rejected rows keep their
historically-applied offset by design.

## Result

Standards: no hard violations — 3 judgement-call smells, none actionable.
Spec: complete, faithful implementation. Both axes green; suites green
(API 423 / web 130 at 581bcd8, unchanged by the docs-only 66ccfc2).