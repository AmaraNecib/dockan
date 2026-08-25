# Code review — receipt printing

- **base SHA:** `706a498` (merge-base with origin/develop)
- **reviewed HEAD:** `cfe34da`
- **commits:** `cea2502` feat(web): receipt printing from the invoice screen; `cfe34da` fix(web): review round — exactly-once auto print, paper pagination, test hardening
- **gate:** 2 parallel review agents (Standards axis, Spec axis) against `git diff 706a498...HEAD`

## Standards

**Documented-standard violations: none.** Verified against `docs/engineering-workflow.md`
(gates, source-only change policy — diff contains only named source/test files, no
artifacts) and the repo's established page/component/i18n patterns (invoice.tsx,
invoice-header.tsx, i18n.ts, router.tsx).

Judgement-call smells reviewed and dispositioned:

- **Duplicated Code (near-hard):** the pending/error branches in `receipt-print.tsx`
  mirrored `invoice.tsx` — including the misleading `activityError` copy during
  *pending*. Fixed: print page pending now shows a neutral loading message;
  error branch stays consistent with the repo pattern.
- **Divergent Change (documented tradeoff):** `Receipt` projects ~15 fields across
  `receipt.ts` + `receipt-view.tsx` + tests. The seam is deliberate and documented
  in the module header (copy, never recompute).
- **Data Clumps:** `… دج` concatenation ~10× — same idiom as the existing invoice
  screen; repo has no money formatter; not introduced by this change.
- **Repeated Switches / Primitive Obsession:** dynamic `t(\`invoiceKind_…\`)` /
  `t(\`pmtMethod_…\`)` keys — same idiom as invoice.tsx with existing keys.
- **Speculative Generality: none** — every Receipt field is rendered and tested.

Convention note: prior e2e specs used `ticketNN.spec.ts` names and `// ticket N`
markers; this lane intentionally uses the semantic `receipts.spec.ts` name and
ticket-free comments per the lane's hygiene directive (the old-file rename is a
parent-owned post-merge chore).

## Spec

The originating issue: a print button on an invoice generates a PDF receipt and
opens the system print dialog; works on any printer via the OS dialog; Arabic
RTL; prefer `window.print()` on a print-only receipt view; dependency-light; no
native Rust printing dependency; do not touch auth/config seams, store money
procedures, or reports/payments pages beyond the invoice detail's print affordance.

- **(a) Missing/partial:** none material. The OS-dialog leg is attested by
  architecture + manual desktop-shell use, not CI (headless-hostile; the e2e
  asserts the print route document instead and documents that).
- **(b) Scope creep:** none — diff confined to `apps/web` + `tests/e2e`; store
  money procedures, auth/config seams, reports/payments pages untouched.
  `.scratch/` design + evidence docs are committed per repo convention.
- **(c) Implemented-but-wrong:** the pending-state error copy (fixed, above);
  auto-print gate robustness (fixed: invoiceId-keyed, manual-button armed).

## Verdict

Standards pass (one near-hard finding applied); Spec pass (no gaps, no creep,
two robustness fixes applied). Clean to push per lane ownership split.