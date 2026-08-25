# Ticket #31 — Expenses and flexible profit reports

- **Issue:** #31, `Expenses and flexible profit reports`
- **Base:** `origin/develop` / `af0c7a3`
- **Branch:** `feat/31-expenses-profit-reports`
- **Review tier:** High-assurance — revenue/COGS/profit DZD money math; debate + test-audit + code-review.
- **Persistence seam:** `StorePort` → Drizzle/SQLite only; no SQL outside the adapter (ADR-0003).
- **Money/time:** whole DZD integers; timestamps are Algeria-local `YYYY-MM-DDTHH:mm:ss` strings (`Africa/Algiers`, UTC+1, no DST). No float arithmetic, no precomputed money totals stored anywhere new.
- **Integration facts:** sale lines already persist `costAtSale` (per-unit FIFO snapshot, ADR-0005) and `discountAllocated`/`netTotal`; revenue and COGS are derived **at read time** from those raw line records of SALE invoices whose `invoiceDate` falls in the range. Expenses are raw append-only records; the report is pure summation, separate from the store.

## Domain model

### ExpenseCategory (new table `expense_categories`)

- `id` UUID, `name` TEXT UNIQUE, `is_owner_withdrawal` INTEGER (0/1), `created_at`, `updated_at`.
- Owner-withdrawal categories are flagged, not name-matched — the report separates them by attribute. Exactly one seeded withdrawal category; users may create more (flag settable at create).
- Seeded once when the table is empty (idempotent, same pattern as `categories`):
  كراء المحل، كهرباء وماء وغاز، أجور ورواتب، نقل وتوصيل، صيانة وتصليح، مصاريف أخرى، سحوبات المالك (withdrawal=1).

### Expense (new table `expenses`)

- `id` UUID, `category_id` FK, `amount` INTEGER (positive whole DZD), `note` TEXT NULL, `occurred_at` TEXT (Algeria-local moment, caller-supplied, defaults to now), `created_at`.
- Append-only (created + listed; edit/delete deferred — see risks). Each create writes an `EXPENSE_RECORDED` activity row.
- Indexes on `occurred_at` and `category_id` (range + category filtering).

### Range presets (pure, `report-ranges.ts`)

- `24H | 7D | 28D | 30D` — rolling windows: `now − span` → `now`.
- `CURRENT_MONTH` — local month start `YYYY-MM-01T00:00:00` → last day `T23:59:59` (default).
- `3M | 6M` — local start of (current month − N) → end of current month.
- `CURRENT_YEAR` — Jan 1 → Dec 31; `LAST_YEAR` — previous year’s Jan 1 → Dec 31.
- `CUSTOM` — caller supplies `customFrom`/`customTo` (`localDateTimeSchema`, `from <= to` lexicographic; fixed-width format makes string compare exact).
- All boundary math stays in local calendar space (string month/date arithmetic), so Algeria edges are deterministic without tz instants. Rolling windows subtract ms from the instants then format via Africa/Algiers. No DST ⇒ ms arithmetic is exact.

## Public contract

### Contracts (`packages/contracts/src/core.ts`, additive)

- `expenseCategorySchema { id, name, isOwnerWithdrawal, createdAt, updatedAt }`
- `expenseSchema { id, categoryId, amount, note (nullable), occurredAt, createdAt }`
- `expenseCategoryCreateInputSchema { name, isOwnerWithdrawal? }`
- `expenseCreateInputSchema { categoryId, amount (int > 0), note?, occurredAt? }`
- `expenseListInputSchema { categoryIds?: string[] (empty/absent = all), from?: localDateTime, to?: localDateTime, sortBy?: "occurredAt"|"amount", sortDir?: "asc"|"desc" }` — absent range ⇒ current month at the router.
- `expenseListOutputSchema { items: Expense[] }`
- `profitReportInputSchema { preset: enum, customFrom?, customTo? }`
- `profitReportOutputSchema { range: { preset, from, to }, revenue, cogs, grossProfit, operatingExpenses, ownerWithdrawals, resultAfterExpenses, byCategory: [{ categoryId, categoryName, isOwnerWithdrawal, total, count }] }`
- `activityTypes` gains `EXPENSE_RECORDED` and `EXPENSE_CATEGORY_CREATED`.

### App contract (`app-contract.ts`, additive)

- `expenseCategoriesList`, `expenseCategoriesCreate`
- `expensesList`, `expensesCreate`
- `reportsProfit`

### Router (`apps/api/src/rpc/router.ts`, additive)

All guarded. `expensesCreate` validates the category exists (else `CATEGORY_NOT_FOUND`), dedupes category names (else `EXPENSE_CATEGORY_EXISTS`), writes expense + activity in one transaction. `expensesList` resolves the range (default current month), passes category/range filters to the store, sorts with the pure comparator. `reportsProfit` resolves the range, reads raw SALE lines + expenses once, and computes the report purely.

### Store (`store/port.ts` + `drizzle-store.ts`, additive)

- `listExpenseCategories(): Promise<ExpenseCategory[]>`
- `createExpenseCategory(input): Promise<ExpenseCategory>`
- `insertExpense(input): Promise<Expense>`
- `listExpenseRecords(filters: { categoryIds?, from?, to? }): Promise<Expense[]>`
- `listSaleLinesForProfit(from, to): Promise<ProfitSaleLine[]>` — JOIN `invoice_lines` × `invoices` WHERE kind=SALE AND `invoice_date` in range; each row = `{ invoiceId, invoiceDate, quantity, costAtSale, netTotal }` (raw line facts; the pure module sums them).

### Pure modules

- `apps/api/src/lib/report-ranges.ts` — `resolveRange(preset, now, custom?)`, month/year edge helpers. No IO.
- `apps/api/src/lib/profit-report.ts` — `computeProfitReport({ saleLines, expenses, categories, range })` and `sortExpenses(rows, sortBy, sortDir)`. No IO. Formulas:
  - `revenue = Σ netTotal` (post-discount; Σ netTotal ≡ Σ invoice.totalAmount by #30 allocation identity)
  - `cogs = Σ costAtSale × quantity`
  - `grossProfit = revenue − cogs`
  - `operatingExpenses = Σ expenses where category.isOwnerWithdrawal = false`
  - `ownerWithdrawals = Σ expenses where category.isOwnerWithdrawal = true`
  - `resultAfterExpenses = grossProfit − operatingExpenses − ownerWithdrawals`
  - `byCategory` reconciled so its sums equal operating+withdrawals exactly.

### UI (web)

- Nav: `المصاريف` (`/expenses`) and `التقارير` (`/reports`).
- `/expenses`: record form (category select incl. flagged withdrawal category, amount, note, datetime-local defaulted to now) + history table filtered by multi-category checkboxes + range preset (default current month, custom from/to) and sort (date/amount × asc/desc). Rows show occurredAt, category, note, amount; owner-withdrawal rows visually distinct. Results and source rows reconcile with the report page.
- `/reports`: range preset (default current month) + custom from/to; shows the six figures and a per-category breakdown table with withdrawal split.

## Dependencies

- Zero new packages. Uses existing drizzle/bun:sqlite, zod, oRPC guard seam, TanStack Query/React.
- `reportsDebts` stays `notImplemented` (#8/#9 own it); payments/debts seams untouched; router.ts/router.test.ts/i18n.ts/router.tsx additions are purely additive.

## Tests

### Unit — `report-ranges.test.ts` (date-boundary in Algeria local time)
- CURRENT_MONTH edges (from = first day 00:00:00, to = last day 23:59:59; 28/29/30/31-day months, leap Feb).
- CURRENT_YEAR / LAST_YEAR (Jan 1 / Dec 31; previous year when now is Jan 1).
- Rolling 24H/7D/28D/30D correct spans and pairwise distinct; 28D ≠ 30D.
- 3M/6M month-edge math incl. year crossing (dec→oct/nov start; jan→previous-year start).
- CUSTOM passthrough and from<=to.

### Unit — `profit-report.test.ts` (money math)
- Revenue from netTotals and COGS from costAtSale×quantity on a worked example.
- COGS-vs-expenses separation: a SALE invoice never appears in expenses; an expense never touches COGS; a PURCHASE invoice contributes nothing.
- Withdrawal separation: withdrawal category excluded from operatingExpenses, shown under ownerWithdrawals.
- Range filtering (invoice/expense outside range excluded; backdated invoiceDate respected).
- **Reconciliation worked example** (literal): 2 sales → grossProfit; expenses + withdrawals → result = revenue − COGS − operatingExpenses − withdrawals, exact integers; byCategory sums reconcile.
- Empty range → all zeros, no crash.
- sortExpenses: date/amount × asc/desc stable.

### Router wire (`router.test.ts` additions)
- Seeded categories incl. exactly one withdrawal flag; duplicate name → EXPENSE_CATEGORY_EXISTS; unknown category → CATEGORY_NOT_FOUND; zero/negative amount rejected by schema.
- Create expense with/without note + backdated occurredAt; appears in list; activity row written.
- Multi-category filter; custom + current-month default range; sort date/amount both directions; outside-range excluded.
- Report via wire: full worked example (item → stock → sale → expense → report CURRENT_MONTH) reconciles; LAST_YEAR/CUSTOM range catches a backdated invoiceDate.
- Setup idempotency: second setup() does not duplicate seeds (store/unit or router).

### Playwright `tests/e2e/ticket31.spec.ts`
- Record expense (withdrawal + operating category) → appears in history; owner rows distinct.
- Range/sort controls on the expenses page filter deterministically.
- Sell via the sale page, open reports → revenue/COGS/gross profit and expense figures match the worked numbers; withdrawal separate; result displayed.

## Required final gates

`bun run typecheck`; `bun run lint`; `bun run test`;
`DOKAN_PORT=4327 DOKAN_WEB_PORT=5183 bun run test:e2e -- --workers=1`.
Restore `.dokan-port` byte-exact (`4317`). Commit only source/config/test/evidence files (never `git add -A`).

## Implementation risks

- **Dual revenue/cash semantics:** report uses accrual (invoiceDate) not cash — documented choice; paid/remaining stay debt territory (#8/#9).
- **costAtSale is an integer per-unit FIFO snapshot** (ADR-0005 rounding mandate): COGS = costAtSale × quantity may differ from exact layer-cost by ≤0.5×qty DA on multi-layer lines; accepted whole-DZD mandate, documented (matches #30 debate verdict).
- **Backdated occurredAt/invoiceDate:** the report honors the business date; a backdated sale’s stock timing (now) never affects which period revenue lands in. Pinned by tests.
- **Append-only expenses:** a mis-keyed amount can’t be fixed without deleting the row; edit/delete deferred as follow-up (report stays derived from immutable raw facts — no stored totals to corrupt).
- **Range window semantics:** rolling presets are `now ± span` instants; month/year presets are local calendar months. UI default = current month everywhere.
- **Timezone coupling of the datetime-local input:** single-PC Algeria shop (device tz = Africa/Algiers); API canonicalizes all stored strings via Africa/Algiers regardless.
- **Sorting in memory:** expense volumes are small (≤ a few thousand/year); SQL filtering stays in the adapter, ordering stays in the pure module for testability.