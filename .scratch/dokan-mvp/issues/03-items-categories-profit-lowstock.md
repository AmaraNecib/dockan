# 03: Items & categories + profit preview + low-stock list

**What to build:** the owner creates categories and items (category, cost price, selling price, low-stock threshold), sees live profit per unit while creating and viewing, and the home page lists items running low.

**Blocked by:** 01

**Status:** ready-for-agent

**GitHub:** #5

- [ ] Create category; items pick one category (default عام seeded, so item creation never blocks)
- [ ] Item fields: name, category, cost price, selling price, threshold (numeric, DA)
- [ ] Profit per unit (selling − cost) shown live while typing and on the item list
- [ ] Home page low-stock list shows items with on-hand ≤ threshold, ordered by quantity
- [ ] All screens Arabic (RTL)