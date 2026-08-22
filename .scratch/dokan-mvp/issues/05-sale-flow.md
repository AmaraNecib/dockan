# 05: Sale flow (stock out + SALE invoice)

**What to build:** selling items creates a SALE invoice, decreases stock, refuses to sell more than available, accepts a customer name or none, and auto-suggests an editable invoice number.

**Blocked by:** 01, 03

**Status:** ready-for-agent

**GitHub:** #7

- [ ] Sale recorded with or without a customer name; stock decreases
- [ ] Oversell blocked: 4 items left → selling 5 is refused with a clear message
- [ ] Line profit uses the cost snapshot at sale time (costAtSale), so later cost changes don't rewrite history
- [ ] Invoice number auto-suggested INV-0001, INV-0002… and editable by the owner
- [ ] Cash / credit / split payment handling; activity log entry (SALE_CREATED)
- [ ] Screen in Arabic (RTL)