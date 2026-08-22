# Dokan MVP. Spec

> Desktop stock & invoicing app for a car-accessories shop in Algeria.
> Status: ready-for-agent. Source: grilling rounds (grill-with-docs) + scaffold proof.
> Glossary: `CONTEXT.md`. Decisions: `docs/adr/0001..0003`.

## Problem Statement

An Algerian shop owner sells car accessories from a single PC in his shop. He keeps stock, prices, sales and debts in his head and on paper. He loses money when debts are forgotten, sells items below cost without noticing, and has no record of what happened when. The owner wants a simple, offline, Arabic app that runs on that one PC, protects the data from casual users of the shared laptop, and never loses his records even if the PC dies.

A developer (the buyer of this spec) will build it with AI help in 7-10 days and sell it to the owner for ~30,000 DA, with the intent of selling the same app to other shop owners afterwards.

## Solution

A local-first desktop app (Tauri shell, Bun API, React UI in Arabic) where the owner:

- logs in with his **phone number + password** (better-auth; no email), resettable via the build secret baked into the app,
- manages **categories and items** (each item: category, cost price, selling price, low-stock threshold; live profit per unit),
- records **purchases** from suppliers and **sales** to customers as **invoices** (SALE / PURCHASE), each payable fully in cash, fully on credit, or split,
- sees **debts grouped by person**. who owes him and who he owes. and records **later payments** against an invoice, never beyond the remaining amount, with payment history visible on the invoice,
- is **blocked from selling more than available stock**, gets a **low-stock list** on the dashboard,
- prints a **PDF receipt** via the system print dialog,
- gets an **activity log** of what happened and when, and
- is protected by **automatic daily backups** plus a manual export, named by Algerian date.

All data lives in one local SQLite file. Timestamps are Algeria local time (UTC+1). Money is whole Algerian Dinars (integers, no floats).

## User Stories

1. As the shop owner, I want to log in with my phone number and a password, so that my business data is safe when the laptop is shared.
2. As the shop owner, I want to reset my password with the build secret, so that I can recover access if I forget it.
3. As the shop owner, I want the app to validate my Algerian phone number, so that nobody typo-logs in with a wrong identifier.
4. As the shop owner, I want to create categories, so that my stock is organized.
5. As the shop owner, I want to create an item with a category, cost price and selling price, so that I can see my expected profit per unit.
6. As the shop owner, I want the profit per unit shown while creating and when viewing items, so that I know my margin before selling.
7. As the shop owner, I want to set a low-stock threshold per item, so that I get warned before running out.
8. As the shop owner, I want a low-stock list on the home page, so that I know what to reorder.
9. As the shop owner, I want to record a purchase from a supplier, so that items are added to stock with their cost.
10. As the shop owner, I want to pay a purchase in cash, in debt, or split between both, so that I can buy even when cash is short.
11. As the shop owner, I want the average cost recomputed at purchase over on-hand stock, so that profit estimates stay honest when prices change (30 left at 200 + 100 bought at 120 → 138 DA; never re-valuing sold units).
12. As the shop owner, I want to sell items with or without a customer name, so that sales are invoiced simply.
13. As the shop owner, I want the app to block selling more than available stock, so that stock never goes negative.
14. As the shop owner, I want the invoice number auto-suggested (INV-0001) and editable, so that numbering follows my habit.
15. As the shop owner, I want a printable PDF receipt for each sale, so that I can give the customer paper proof.
16. As the shop owner, I want to record later payments against an invoice, so that a debt is settled over time.
17. As the shop owner, I want the app to prevent paying more than the remaining amount, so that debt numbers stay exact.
18. As the shop owner, I want to see payment history on the invoice screen, so that I know what was paid and when.
19. As the shop owner, I want a debts screen grouped by person. who owes me and who I owe, with totals. so that I can follow up.
20. As the shop owner, I want the activity log to show what happened and when, so that I can trace any action.
21. As the shop owner, I want my store name and phone on the invoice header, so that receipts look like my shop.
22. As the shop owner, I want automatic daily backups and a manual export, so that a dead PC does not kill my records.
23. As the shop owner, I want the app to speak Arabic (RTL), so that I read it naturally.
24. As the developer, I want the app to log technical errors with stable error codes, so that I can debug from anywhere.
25. As the developer, I want persistence behind one port, so that I can swap sqlite for postgres by configuration alone.

## Implementation Decisions

- **Monorepo (Bun workspaces)**. `contracts` (Zod schemas + oRPC contract, the source of truth), `api` (Hono + oRPC + Drizzle), `web` (React + TanStack Router/Query + oRPC client + shadcn/ui + Tailwind 4), `desktop` (Tauri v2). No build step; workspace packages resolve from `src/`.
- **Runtime**. Bun runs the API (`bun:sqlite`), compiled to a single `.exe` sidecar via `bun build --compile` for the portable desktop build.
- **Persistence seam**. one `StorePort` interface; sqlite adapter now (Drizzle + bun:sqlite), postgres adapter later behind `DOKAN_DB_DRIVER`. Callers never change (ADR-0003).
- **Auth. better-auth with phone-number provider**. single admin with a unique, normalized Algerian phone number (+213 …) as the login identifier and a password (scrypt-hashed). No email. No SMS/OTP in the MVP: OTP needs an SMS gateway, which conflicts with local-first/offline and adds cost; it is a possible paid add-on later. Sessions are server-side; the subtle threat model is a shared laptop, not a remote attacker.
- **Money**. whole dinars, stored as integers; no float arithmetic anywhere.
- **Time**. every timestamp in Algeria local time (UTC+1): invoice dates, payments, activity log, backup filenames, log file names.
- **Average cost rule**. weighted by on-hand stock at purchase time; sold units are realized and never re-valued: `newAvg = round((oldStock × oldCost + qty × buyPrice) / (oldStock + qty))` (ADR-0002).
- **Invoices**. kind SALE (customer owes) / PURCHASE (shop owes); optional known party or typed-in name; lines snapshot description and `costAtSale` so profit stays honest after cost changes; editable auto-numbered invoice number.
- **Payments**. per-invoice, multiple allowed, never beyond `remainingAmount` (no overpay), history shown on the invoice.
- **Stock**. never below zero (blocked sale); PURCHASE increments + recomputes average cost, SALE decrements.
- **Logs. two kinds**. the shop-owner activity log (SALE/PURCHASE/PAYMENT/… events) and a developer-facing daily JSONL diagnostics log with `DKN-XXXXXXXX` error codes and stacks.
- **Backup**. automatic daily copy of the SQLite file (WAL checkpoint) plus a manual export; files named `dokan-YYYY-MM-DD.db` in an owned `backups/` folder.
- **UI**. Arabic-first, RTL, one category per item with a seeded default category, low-stock list + dashboard flag, invoice header from settings (store name/phone).
- **Scope of realism for an MVP**. no multi-user roles, no cloud sync, single machine, one language.

## Testing Decisions

- A good test asserts external behavior through a seam with expected values from worked examples. never internals, never SQL, never implementation structure.
- **Seam 1 (use cases)**: the invoice/debt/stock math is tested over an in-memory store adapter; canonical examples as literals (30@200 + 100@120 → avg 138; oversell blocked at 4 items left; overpay rejected; owedToUs vs weOwe grouping).
- **Seam 2 (store)**: persistence behavior tested against sqlite `:memory:` through the same `StorePort`.
- Prior art: the `tuari_react_hono` monorepo's module tests (bun test is the runner here).
- Tests at the use-case seam must survive refactors of the store layer.

## Out of Scope

- Batch/lot tracking (FIFO per-purchase selling). deferred after MVP.
- Fiscal invoices: NIF, TVA (19%) and legal numbering. only if the owner registers for tax, later.
- Multi-user, roles, multi-store or per-store branding configuration.
- Mobile version (would re-open the economics; desktop is the decided product).
- Barcode/thermal-printer driver integration; profit reports and analytics dashboards; French language.
- Cloud sync or SMS/OTP login.

## Further Notes

- Price 30,000 DA; offer = this scope + install on the owner's PC + 15 days free bug fixes.
- First release targets one Windows PC; backup story is the requirement that keeps the product trustworthy.
- The founder of the profit concept is the sibling project `gifty` (`D:\projects\gifts`), which also speaks RTL Arabic for Algerian shops.