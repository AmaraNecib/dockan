# 06: Payments on invoices (no overpay, history)

**What to build:** the owner records later payments against an invoice, in instalments, never more than the remaining amount, and sees the payment history on the invoice screen.

**Blocked by:** 04, 05

**Status:** ready-for-agent

- [ ] Record a partial payment → remainingAmount decreases
- [ ] Paying more than the remaining amount is refused (no overpay, exact message)
- [ ] Multiple payments on one invoice accumulate; full history visible on the invoice
- [ ] Each payment logged in the activity log (PAYMENT_RECORDED)
- [ ] Screen in Arabic (RTL)