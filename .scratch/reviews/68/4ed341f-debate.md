# Issue #68 — Debate evidence

Base: `f4d4674` · Head: `4ed341f` · Branch: `fix/68-return-debt`

Run as two parallel reviewer sub-agents (critic + defender) over
`git diff f4d4674...HEAD -- apps/`, the design doc, and the issue context.

## Critic findings

1. **8 — Legacy-data double-apply.** Databases created pre-#68 may hold a
   PENDING return whose `debtOffset` was already applied to the invoice at
   creation; the new accept applies `min(debtOffset, remaining)` again. The
   cap only saves the already-zeroed case. No marker distinguished old rows.
2. **7 — “مطبّق” label shows the recorded `debtOffset`, not the amount actually
   applied** when acceptance caps it (over-promise or a payment landing while
   pending) — the identical contradiction class #68 reports, inverted.
3. **5 — Misleading SAFETY comment** at the accept-time refusal: the comment
   implied the accept survives the guarded-UPDATE failure, but the
   BEGIN IMMEDIATE unit ROLLBACKs on throw (state reverts to PENDING +
   BAD_REQUEST).
4. **3 — Invoice-panel note over-promises** the exact projected amount will
   apply at acceptance when the accept can cap it.
5. Note: cash-immediate / debt-deferred asymmetry is coherent and documented.

## Defender counterpoints

- Deferring the debt to acceptance matches the app's own profit-report
  semantic (a PENDING return un-books the sale line; nothing is final until
  review). The min-cap — not a hard refusal — is the right guard: two pending
  returns can aggregate beyond one debt, and a partial apply at 0 is a clean
  no-op. Cash stays immediate because it is a physical handover; the voucher
  records the promise, the ledger applies when goods clear review. The
  fully-applied legacy case is already mitigated by the cap (min(offset, 0) = 0).

## Synthesis → actions

| Finding | Decision | Action |
|---|---|---|
| 1 (legacy double-apply) | Fixed | Added `returns.debt_applied`; `ensureReturnsSettlementColumns` ALTERs the column and backfills `debt_applied = debt_offset` for every legacy row (pre-fix code settled at creation, unconditionally and irreversibly). Accept now applies `min(debtOffset − debtApplied, remaining-at-accept)`, so a legacy PENDING return accepts as a no-op and can never double-relieve. Store-seam migration test added (ALTER + backfill + idempotent re-setup). |
| 2 (applied-vs-recorded display) | Fixed | ACCEPTED cards and vouchers render `debtApplied` (the real relieved amount); debtApplied is written in the same accept unit. Web label tests pin the applied-amount behavior. |
| 3 (misleading comment) | Fixed | Rewritten to state that the whole unit rolls back on refusal. |
| 4 (note over-promise) | Fixed | Copy softened to «خصم الدين يُطبّق عند قبول المرجوع — الفاتورة تبقى مدينة حتى ذلك الحين» (no exact amount). |
| 5 (asymmetry note) | Dismissed | Intended design, documented in 68-design.md. |

## Result

All four actionable critic findings fixed in `4ed341f`; the design decision
set (defer-to-accept, min-cap, cash-immediate) confirmed by the defender and
retained. Both reviewers ran the full API + web returns suites green.