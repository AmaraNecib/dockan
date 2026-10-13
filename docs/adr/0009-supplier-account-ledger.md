# Supplier money lives in one signed account

A supplier is managed as a single signed account: every charge (a purchase), payment, purchase return, and account refund is one entry, and the supplier's balance is their sum. A purchase invoice's «paid / remaining» is *derived* from the entries that name it, so the owner can still open an invoice and pay it directly. We chose this over keeping each invoice authoritative with a separate supplier-credit pool because the owner's question is always «what is his account with me», and because an advance paid before any purchase, a return kept as credit, and an instalment on a named invoice are one primitive — a signed entry. Customers keep the invoice-based debt they have today: they only ever owe the shop, so an account adds nothing there. Supplier returns are accepted on the spot, with no review state; a damaged item that is never returned stays out of scope (#61).

**Considered options**

- **(A) Invoices authoritative + a separate supplier-credit pool.** Rejected: two places hold the truth, and «pay this invoice» and «pay his account» become different records for the same money.
- **(B) One signed account per supplier.** Chosen.

**Consequences**

- The Debts screen shows a supplier's net balance (which can be in the shop's favour), not a sum of unpaid invoices; the individual invoices and account movements sit behind that balance.
- The printed purchase invoice still shows a paid/remaining, now computed from the entries that name it.
- `payments` and the invoice's stored `remainingAmount` change shape, so this is a High-assurance money change and needs the debate + test-audit pipeline.
