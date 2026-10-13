# A تسوية is one signed adjustment, account-only unless it names an invoice

A supplier's old or standalone debt has no invoice to enter, so the account needs
a way to write a number directly. We added one **append-only** entry kind,
`ADJUSTMENT` (تسوية), carrying a **direction** — **نسالوه** (`WE_OWE`, the shop
owes more, +) or **يسالنا** (`THEY_OWE`, the shop owes less, −) — an amount, a
reason, and a date. A mistake is another تسوية with a reason, never a delete.

The owner's decision: the adjustment takes an **optional invoice link**.

- **Account-only** (no link): moves the account balance; it must never touch any
  invoice's `paid` / `remaining`.
- **Invoice-linked**: a real discount/write-off on one purchase invoice. It
  reduces that invoice's remaining **without cash**, through the same derived
  mechanism a purchase return uses — one conditional `UPDATE remaining_amount =
  remaining_amount - ? WHERE remaining_amount >= ?` inside the same `BEGIN
  IMMEDIATE` unit, with the reduction summed into the invoice's
  `returnCreditAmount` so the printed header still reconciles
  (`total − paid − returnCredit = remaining`). The remaining is clamped at ≥ 0
  and a link may not exceed it: the excess is **refused**, never silently moved
  to credit. A link only makes sense in the reducing direction, so `WE_OWE` +
  link is refused. «دفعة» stays the tool for money actually paid.

A bulk **رصيد افتتاحي** screen writes one account-only تسوية per filled row (no
invoice link there), with one shared date and reason; a row whose supplier
already carries an account entry asks for confirmation first.

**Considered options**

- **(A) Reduce the invoice's `total`.** Rejected: an invoice is a document; its
  total is a historical fact. The remaining is the derived part.
- **(B) A second pool of "discounts".** Rejected: the account already is the one
  signed ledger (ADR-0009); the reduction is just another signed entry.
- **(C) Reduce only the account, never the invoice.** Rejected for a linked
  discount: the owner wants the invoice he discounts to follow, and the
  return mechanism already proves the derived path.

**Consequences**

- `supplierEntryKinds` gains `ADJUSTMENT`; `supplier_account_entries` gains a
  nullable `direction` column. `CURRENT_SCHEMA_VERSION` moves 2 → 3. An older
  (version-2) build has no ADJUSTMENT branch in its sign SQL and would read a
  نسالوه adjustment as a decrement, so it MUST refuse the version-3 database
  (ADR-0008 §4.5). The forward migration is additive: `ALTER TABLE … ADD COLUMN
  direction`, existing rows keep `direction = NULL`, and re-opening is
  idempotent.
- **Customer extension (B) path:** when customers get an account, it is
  **additive** in the same shape — its own ledger table (or a generic party
  ledger) and its own kind set, another `user_version` bump, never a reuse or
  re-sign of an existing kind. نسالوه / يسالنا are deliberately the same two
  words on both sides, so the vocabulary does not change. A build that predates
  the bump refuses the newer database instead of mis-signing it.
- The balance stays **derived from the entries**: `supplierBalance` and the SQL
  aggregates (the /debts screen and the supplier list) all read one
  `ADJUSTMENT`-aware sign expression, so no screen can disagree about the
  balance.
