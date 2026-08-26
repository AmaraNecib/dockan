# Code review — returns & refunds (standards + spec axes)

Base SHA: `9b6ee41`. Head SHA: `1de4a3c`. Diff: `git diff 9b6ee41...1de4a3c`.

Reviewers: reviewer subagents (standards + spec axes, mission 53796ce2),
settlement-delta review (mission 2281d97f), and external PR finding waves
(P1–P2 @ fd09134, S1–S2 @ 1de4a3c).

## Standards

Fixed during the PR cycle:
- Issue numbers in new-source comments → semantic; anti-slop return-type
  widening → named `BookedSaleLine` contract; type assertions gained SAFETY:
  justification.
- Owner review comments (router.ts:874 / 928): the api emitted Arabic
  sentence literals. **Fixed across the feature:**
  - `router.ts` — return activity summaries and movement reasons are stable
    keys + structured tokens (`RETURN_RECORDED`, `RETURN_REVIEWED <rtn>
    <ACCEPTED|REJECTED> <amount>`, `RETURN_REJECTED_DAMAGED <rtn>[ — <note>]
    #<lineId>`); no Arabic literal remains in the returns section.
  - `drizzle-store.ts` — return scrap attribution joins on the `#<lineId>`
    reason suffix; no new Arabic in return code paths.
  - `return-calculations.ts` — English error strings only.
  - Web: activity + item-history views translate the keyed reasons/summaries
    via i18n (surgical helpers that raw-render legacy summaries unchanged);
    new components/pages (return-voucher-view, returns, return-print,
    return-voucher) use `t()` only, incl. `t("dzd")` for the currency unit.
  - `locale-neutral.test.ts` — guard scanning the feature's new source files
    for Arabic characters.
  - i18n values remain Arabic by design (they ARE the translation layer);
    pre-existing Arabic outside this PR's diff is the separate repo-wide
    chore and was left untouched.

Confirmed compliant: @dokan/contracts single source of truth; ADR-0003
StorePort seam; whole-DZD money; Algeria-local timestamps; Arabic UI via
i18n; append-only ledger facts (only review tags/status/reason transition).

## Spec

Base + settlement-split + freebie-unwind requirements all present; the two
new PR findings were correctness fixes in spec-level behavior:

- S1 — refunds must never over-refund cumulatively: sequence-aware pricing
  with a per-line remaining-value ledger, exact remainder on completion.
- S2 — reject scrap attribution per line: one clamped movement per return
  line with exact ownership marking, so same-item multi-line returns never
  double-count.
- The locale-neutral work implements the developer-facing seam the owner
  asked for (api keys + web i18n) without changing user-visible text.

## Summary

Standards: the Arabic-literal violations are fixed repo-wide within this
PR's files with a guard test; 2 judgement-call smells accepted (duplicated
ledger-append blocks, payoutMethod future-proofing). Spec: 0 missing /
scope-creep / wrong; all external findings closed. Worst remaining per axis:
none blocking.