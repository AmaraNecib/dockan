# Dokan (دكان). Domain Glossary

> Desktop stock & invoicing app for a car-accessories shop (Algeria).
> Arabic-first UI, amounts in Algerian Dinar (DZD). Glossary only. no implementation details.

## Core Concepts

- **Store** (المحل). the shop. Settings hold its name and phone; both appear on invoices.
- **Item** (منتج). a car accessory sold by the piece (e.g. battery, oil filter, bulb). Has a category, a **cost price**, a **selling price**, and a **low-stock threshold**.
- **Category** (تصنيف). a group the owner creates and assigns to items, used to organize the stock list and filtering.
- **Cost price** (سعر الشراء). what the owner pays per unit, entered when creating an item and updated by purchases.
- **Selling price** (سعر البيع). what the customer pays per unit.
- **Profit per unit**. selling price minus cost price. Shown when creating an item and in the stock list.
- **Stock / stock on hand** (المخزون). quantity of an item available in the shop. Increases on purchases, decreases on sales. Cannot go below zero.
- **Low-stock threshold** (حد التنبيه). per-item number; when stock on hand drops to it, the item appears in a low-stock list so the owner reorders.
- **Average cost**. the weighted mean cost per unit across purchases, recomputed automatically when the same item is bought at a different price. The way the app values stock when prices change between purchases. A manual cost edit is a **cost-correction movement** on the ledger (a zero-quantity `MANUAL_ADJUSTMENT` with reason `COST_CORRECTION`), never a direct write to the item's cached cost. Replay walks the ledger in recording order and splits it at each correction, so a correction applies after everything recorded before it and before everything recorded after it; ordinary movements inside a segment still replay in business-date order, so backdated purchases and outflows are unaffected.
- **Sale** (بيع). a customer buys one or more items. Generates a **sale invoice**, decreases stock.
- **Purchase** (شراء). the owner buys from a supplier. Increases stock; may be paid fully, partially, or on credit.
- **Customer** (زبون). a person who buys. Optional on a sale invoice; when present, name (and phone) print on the invoice and the customer's unpaid sales are tracked. A phone number, when given, identifies the person and is unique; names may repeat.
  _Avoid_: عميل (formal), الطرف (means "party", not a person — never shown in the UI).
- **Supplier** (مورّد). the person the owner buys from; the target of unpaid purchases.
- **Counterparty**. the other side of an invoice: the زبون on a sale, the مورّد on a purchase. One internal concept, two roles; the UI names the role, never «الطرف».
- **Invoice / receipt** (فاتورة). the document for a sale or a purchase: invoice number (auto-suggested, editable), lines, total, paid amount, remaining amount.
- **Payment** (دفعة). money paid against an invoice, or against a **supplier account** when no single invoice is named. An invoice can have several payments (first payment, later payment); a payment never exceeds what is owed (no overpayment) — anything beyond the invoice it names becomes **supplier credit**.
- **Remaining amount / debt** (الباقي). invoice total minus what has been paid. Direction matters: unpaid *purchases* mean the shop owes the supplier; unpaid *sales* mean the customer owes the shop.
- **Supplier account / statement** (كشف حساب المورّد). the running position with one supplier: what the shop owes him minus the **supplier credit** he holds for the shop. One signed number per supplier; a negative balance means the shop is ahead.
- **Supplier payment** (دفعة إلى مورّد). money paid to a supplier against his account rather than one invoice. The owner may point it at a specific purchase invoice, let it settle the oldest unpaid purchase first, or leave it as credit.
- **Supplier credit** (رصيد عند المورّد). value a supplier holds for the shop, from an overpayment or a **purchase return** kept as credit. Consumed by later purchases, or handed back as an **account refund**.
- **Purchase return** (مرتجع إلى المورّد). goods the shop returns to a supplier. Accepted on the spot (no review — if the supplier would not take it back, the return is not recorded). Settles as a reduction of what the shop owes, as **supplier credit**, or as cash back.
- **Refund method** (طريقة التسوية). how a return's value settles: against a party's debt, or as cash. The default follows the debt: a **sale return** comes off the customer's whole tab ("in this invoice or in another invoice" — the party's open invoices, oldest first) while he owes anything, and back as cash only when he owes nothing; when the return is larger than the whole tab it is a **split** — the tab goes to zero and the remainder is cash. A **purchase return** reduces what the shop owes and comes back as cash only when nothing is owed either way. The panel shows the derived method, lets the owner override it (all cash, all debt, or a custom cash amount — the explicit ones keep the invoice-level debt cap), and the debt portion lands only when the owner accepts the goods.
- **Account refund** (استرداد رصيد). the supplier hands supplier credit back in cash, closing that part of his account.
- **Adjustment** (تسوية). a manual signed correction written straight on a party's account, with no invoice. **يسالنا** means «he asks us» — the shop owes him (it increases what the shop owes); **نسالوه** means «we ask him» — he owes the shop (it decreases what the shop owes / moves toward credit). It is append-only: a mistake is another تسوية with a reason, never a delete. Account-only by default — it moves the balance and touches no invoice; when it names a purchase invoice it reduces that invoice's remaining without cash (a discount/write-off). «دفعة» stays the tool for money actually paid. The same two words will serve customer accounts later.
- **Amount-or-percentage input** (مبلغ أو نسبة). wherever an amount is a share of a known reference (a return value, the remaining on an invoice, a year of rent), the owner may type either the amount or a percentage of the reference; each updates the other, and 100% is the default. Used only where a reference total exists.
- **Debt list**. the view grouping who owes whom: "customers owe us" by invoice; "we owe suppliers" by **supplier account**, with the invoices and account movements behind each balance.
- **Payment history**. the list of payments recorded against one invoice, shown on that invoice's screen.
- **Admin login**. the single password-protected entry to the app, using the owner's phone number (+213…) as the login name, protecting the shop's data when the laptop is shared. Phase 2 (ADR-0008 §4.6) moved this to the **unified vault**: one passphrase opens the encrypted data and signs the owner in; the phone-number login remains only for legacy/plaintext builds. Recovery is per install — a saved recovery key, or a vendor-signed reset token after out-of-band verification; no email.
- **Activity log** (سجل). the trace of what happened in the app (sales, purchases, payments, edits), so the owner can audit past actions.
- **Action actor** (منفّذ العملية). the authenticated account that performed an action, distinct from whoever caused damage or paid money to cover it. A shared account identifies the account, not the individual human using it.
- **Backup**. an automatic daily copy of the shop's data plus a manual export button the owner can copy to a USB stick.

## Build, Access, and Data Format

- **Data folder** (مجلد البيانات). the folder holding the shop's data: the encrypted snapshot, the backups, the logs and the lock. One copy of Dokan has it open at a time; the vault lives inside it.
  _Avoid_: data dir, database folder, store directory.
- **In use** (قيد الاستعمال). the data folder is open in another copy of Dokan, so this one refuses to start rather than risk two writers on the same data.
  _Avoid_: locked, busy, occupied.
- **Session signing secret**. the key that signs login sessions. Generated per install on first run and stored with the shop data; never shipped in the build. In the unified vault it lives inside the encrypted snapshot.
- **Vault**. the encrypted store of the shop's data. One passphrase (or a recovery key) unwraps the master key; the app opens only when the vault is open.
- **Master key**. a random key generated at first run; it is the key that encrypts the data folder. It never exists in the clear outside memory and is stored only wrapped by the passphrase and the recovery keys.
- **Vault passphrase**. the owner's single credential: it unwraps the master key and signs the owner in, with no separate login step.
- **Recovery key**. a long random value shown once at first run (up to five, rotatable while unlocked). It unwraps the master key too, so a forgotten passphrase is recoverable. Only the wrapped form is stored.
- **Encrypted snapshot**. the on-disk database container (`dokan.db.enc`): an authenticated encryption of the SQLite image. The running database is in memory, so no plaintext database or WAL ever touches the disk.
- **Vault gate**. the screens shown before the app starts: create the vault, show the recovery key once, unlock with the passphrase, or unlock with a recovery key.
- **Recovery code**. legacy term for the single-use code of the pre-vault design; superseded by the **recovery key**.
- **Device challenge**. a non-secret value the app shows when the owner has lost every recovery code and the password; the vendor signs it to authorize a reset.
- **Reset token**. a signed, single-use, short-lived token the vendor produces from a device challenge.
- **Reset signing key**. the vendor's key pair. The private half never ships; the public half is embedded in the build. It carries a version, and the build accepts a map of versions so old installs stay resettable.
- **Schema version**. a number stored in the database that identifies the data format; older versions migrate forward on open, newer ones are refused.

## Expense vocabulary

- **Expense correction** (تصحيح مصروف). a recorded change to an expense amount that affects the original expense period, with a separate timestamp recorded by the server when the correction is entered. The original and every later correction remain immutable and visible; each correction identifies the authenticated account and before/after amounts, with an optional reason.
- **Expense refund** (استرجاع مصروف). money returned for an expense, distinct from correcting an incorrectly entered amount, recorded under the authenticated account with the actual cash-return date separate from the server-recorded timestamp. The original expense, corrections and refunds remain immutable and visible; a reason is optional.

## Stock discrepancy vocabulary

- **Count correction** (تصحيح الجرد). correcting an entered quantity that was wrong, such as recording 20 when the actual count was 19. It does not by itself assert physical damage; a genuine unexplained shortage is a different event.
- **Damaged stock** (مخزون تالف). units physically damaged or unusable, distinct from a count-entry mistake. Any refund, money recovered and report treatment are separate decisions.

## Deferred Concepts

- **Batch / lot tracking**. selling from a specific purchase (first buy vs second buy at different prices). Considered and deferred to after MVP; MVP values stock by average cost.