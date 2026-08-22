# Dokan (دكان) — Domain Glossary

> Desktop stock & invoicing app for a car-accessories shop (Algeria).
> Arabic-first UI, amounts in Algerian Dinar (DZD). Glossary only — no implementation details.

## Core Concepts

- **Store** (المحل) — the shop. Settings hold its name and phone; both appear on invoices.
- **Item** (منتج) — a car accessory sold by the piece (e.g. battery, oil filter, bulb). Has a category, a **cost price**, a **selling price**, and a **low-stock threshold**.
- **Category** (تصنيف) — a group the owner creates and assigns to items, used to organize the stock list and filtering.
- **Cost price** (سعر الشراء) — what the owner pays per unit, entered when creating an item and updated by purchases.
- **Selling price** (سعر البيع) — what the customer pays per unit.
- **Profit per unit** — selling price minus cost price. Shown when creating an item and in the stock list.
- **Stock / stock on hand** (المخزون) — quantity of an item available in the shop. Increases on purchases, decreases on sales. Cannot go below zero.
- **Low-stock threshold** (حد التنبيه) — per-item number; when stock on hand drops to it, the item appears in a low-stock list so the owner reorders.
- **Average cost** — the weighted mean cost per unit across purchases, recomputed automatically when the same item is bought at a different price. The way the app values stock when prices change between purchases.
- **Sale** (بيع) — a customer buys one or more items. Generates a **sale invoice**, decreases stock.
- **Purchase** (شراء) — the owner buys from a supplier. Increases stock; may be paid fully, partially, or on credit.
- **Customer** (عميل) — a person who buys. Optional on a sale invoice; when present, name (and phone) print on the invoice and the customer's unpaid sales are tracked.
- **Supplier** (مورّد) — the person the owner buys from; the target of unpaid purchases.
- **Invoice / receipt** (فاتورة) — the document for a sale or a purchase: invoice number (auto-suggested, editable), lines, total, paid amount, remaining amount.
- **Payment** (دفعة) — money paid against an invoice. An invoice can have several payments (first payment, later payment); never more than the total (no overpayment).
- **Remaining amount / debt** (الباقي) — invoice total minus what has been paid. Direction matters: unpaid *purchases* mean the shop owes the supplier; unpaid *sales* mean the customer owes the shop.
- **Debt list** — the view grouping invoices by who owes whom: "customers owe us" and "we owe suppliers", with how much remains.
- **Payment history** — the list of payments recorded against one invoice, shown on that invoice's screen.
- **Admin login** — the single password-protected entry to the app, protecting the shop's data when the laptop is shared.
- **Activity log** (سجل) — the trace of what happened in the app (sales, purchases, payments, edits), so the owner can audit past actions.
- **Backup** — an automatic daily copy of the shop's data plus a manual export button the owner can copy to a USB stick.

## Deferred Concepts

- **Batch / lot tracking** — selling from a specific purchase (first buy vs second buy at different prices). Considered and deferred to after MVP; MVP values stock by average cost.