# 04: Purchase flow (stock in + average cost)

**What to build:** buying from a supplier adds items to stock through a PURCHASE invoice, payable fully in cash, fully on credit, or split; the average cost recomputes over on-hand stock.

**Blocked by:** 01, 03

**Status:** ready-for-agent

- [ ] Purchase recorded against a supplier (existing or typed inline); stock increases
- [ ] Payment split works: paid portion recorded, the rest becomes the debt (remainingAmount)
- [ ] Average cost follows the on-hand rule: 30 left at 200 + 100 bought at 120 → 138 DA; sold units never re-valued (ADR-0002)
- [ ] Purchase appears in the activity log (PURCHASE_CREATED)
- [ ] Screen in Arabic (RTL)