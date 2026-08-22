# 07: Debts screen (who owes me / I owe)

**What to build:** one screen showing debts grouped by person in both directions — customers who owe the shop and suppliers the shop owes — with totals, invoice counts and a way to open the related invoices.

**Blocked by:** 04, 05

**Status:** ready-for-agent

- [ ] Two groups rendered: owedToUs (SALE) and weOwe (PURCHASE), each with remaining total and invoice count
- [ ] Grouping works for known parties and for typed-only names; lone names not lost
- [ ] Totals match the sum of remaining amounts across that person's invoices
- [ ] Clicking a group opens its unpaid invoices; screen in Arabic (RTL)