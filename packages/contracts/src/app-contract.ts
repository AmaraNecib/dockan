import { oc, type ContractRouterClient } from "@orpc/contract";
import { z } from "zod";

import {
  activityListInputSchema,
  activityListOutputSchema,
  backupManualOutputSchema,
  catalogSearchInputSchema,
  catalogSearchOutputSchema,
  categoryCreateInputSchema,
  categorySchema,
  dashboardSummaryOutputSchema,
  debtsByPartyInputSchema,
  debtsOutputSchema,
  expenseCategoryCreateInputSchema,
  expenseCategorySchema,
  expenseCreateInputSchema,
  expenseListInputSchema,
  expenseListOutputSchema,
  expenseSchema,
  healthOutputSchema,
  invoiceCreateInputSchema,
  invoiceDetailSchema,
  invoiceListInputSchema,
  invoiceListOutputSchema,
  invoicePayInputSchema,
  itemCreateInputSchema,
  itemCreateWithStockInputSchema,
  itemHistoryInputSchema,
  itemListAllOutputSchema,
  itemListInputSchema,
  itemListOutputSchema,
  itemSchema,
  itemUpdateInputSchema,
  itemHistoryOutputSchema,
  logsTailInputSchema,
  logsTailOutputSchema,
  lowStockOutputSchema,
  onboardingProgressOutputSchema,
  onboardingCompleteOutputSchema,
  partyCreateInputSchema,
  partyDeleteOutputSchema,
  partyDetailOutputSchema,
  partyListOutputSchema,
  partySchema,
  partyUpdateInputSchema,
  preferencesGetOutputSchema,
  preferencesSetInputSchema,
  preferencesSetOutputSchema,
  profitReportInputSchema,
  profitReportOutputSchema,
  purchasesCorrectLineInputSchema,
  purchasesLinkStockInputSchema,
  purchasesLinkStockOutputSchema,
  purchasesProposalOutputSchema,
  needsSetupOutputSchema,
  firstTimeSetupInputSchema,
  firstTimeSetupOutputSchema,
  returnDetailSchema,
  returnsCreateInputSchema,
  returnsGetInputSchema,
  returnsListInputSchema,
  returnsListOutputSchema,
  returnsPendingCountOutputSchema,
  returnsReviewInputSchema,
  settingsSchema,
  settingsUpdateInputSchema,
  stockAddManualInputSchema,
  stockMovementSchema,
  supplierAccountSchema,
  supplierPayInputSchema,
  supplierRefundInputSchema,
  supplierReturnInputSchema,
  supplierReturnsListInputSchema,
  supplierReturnsListOutputSchema,
} from "./core";

/**
 * The Dokan RPC contract — every procedure the UI can call.
 * Flat, prefixed names (matches the tuari monorepo pattern we build on).
 */
export const dokanContract = {
  health: oc.output(healthOutputSchema),

  // --- auth ----------------------------------------------------------------
  needsSetup: oc.output(needsSetupOutputSchema),
  firstTimeSetup: oc.input(firstTimeSetupInputSchema).output(firstTimeSetupOutputSchema),

  // --- categories ----------------------------------------------------------
  categoriesList: oc.output(z.object({ items: z.array(categorySchema) })),
  categoriesCreate: oc.input(categoryCreateInputSchema).output(categorySchema),

  // --- items ---------------------------------------------------------------
  itemsList: oc.input(itemListInputSchema).output(itemListOutputSchema),
  /** whole catalog for pickers/selects; never paginated (see itemListAllOutputSchema) */
  itemsAll: oc.output(itemListAllOutputSchema),
  itemsCreate: oc.input(itemCreateInputSchema).output(itemSchema),
  itemsCreateWithStock: oc.input(itemCreateWithStockInputSchema).output(itemSchema),
  itemsUpdate: oc.input(itemUpdateInputSchema).output(itemSchema),
  itemsLowStock: oc.output(lowStockOutputSchema),

  // --- catalog search + scanning (ticket 28) --------------------------------
  catalogSearch: oc.input(catalogSearchInputSchema).output(catalogSearchOutputSchema),
  // --- stock ledger (ticket 27) --------------------------------------------
  stockAddManual: oc.input(stockAddManualInputSchema).output(stockMovementSchema),
  itemsHistory: oc.input(itemHistoryInputSchema).output(itemHistoryOutputSchema),

  // --- parties (customer / supplier share one code path; issue 120) --------
  customersList: oc.output(partyListOutputSchema),
  customersGet: oc.input(z.object({ id: z.string().uuid() })).output(partyDetailOutputSchema),
  customersCreate: oc.input(partyCreateInputSchema).output(partySchema),
  customersUpdate: oc.input(partyUpdateInputSchema).output(partySchema),
  customersDelete: oc.input(z.object({ id: z.string().uuid() })).output(partyDeleteOutputSchema),
  suppliersList: oc.output(partyListOutputSchema),
  suppliersGet: oc.input(z.object({ id: z.string().uuid() })).output(partyDetailOutputSchema),
  suppliersCreate: oc.input(partyCreateInputSchema).output(partySchema),
  suppliersUpdate: oc.input(partyUpdateInputSchema).output(partySchema),
  suppliersDelete: oc.input(z.object({ id: z.string().uuid() })).output(partyDeleteOutputSchema),
  // --- supplier account (issue 161) ---------------------------------------
  /** pay a supplier: oldest-first default, a named invoice, or leave as credit */
  suppliersPay: oc.input(supplierPayInputSchema).output(supplierAccountSchema),
  /** a purchase return (invoice-linked or free-standing), auto-accepted */
  suppliersReturn: oc.input(supplierReturnInputSchema).output(supplierAccountSchema),
  /** record cash received from the supplier to close a credit */
  suppliersRefund: oc.input(supplierRefundInputSchema).output(supplierAccountSchema),
  /** supplier purchase-return history (plain list, no review state) */
  suppliersReturnsList: oc.input(supplierReturnsListInputSchema).output(supplierReturnsListOutputSchema),

  // --- invoices ------------------------------------------------------------
  invoicesCreate: oc.input(invoiceCreateInputSchema).output(invoiceDetailSchema),
  invoicesGet: oc.input(z.object({ id: z.string().uuid() })).output(invoiceDetailSchema),
  invoicesList: oc.input(invoiceListInputSchema).output(invoiceListOutputSchema),
  invoicesPay: oc.input(invoicePayInputSchema).output(invoiceDetailSchema),

  // --- returns & refunds ----------------------------------------------------
  returnsGet: oc.input(returnsGetInputSchema).output(returnDetailSchema),
  /** cash refunds against a past SALE; refund math + caps live on the api */
  returnsCreate: oc.input(returnsCreateInputSchema).output(returnDetailSchema),
  /** all returns, optionally scoped to one invoice (review page + invoice panel) */
  returnsList: oc.input(returnsListInputSchema).output(returnsListOutputSchema),
  /** pending-review count for the sidebar badge and dashboard notice (issue 118) */
  returnsPendingCount: oc.output(returnsPendingCountOutputSchema),
  /** owner confirms the returned goods: consumes the pending stock mark */
  returnsAccept: oc.input(returnsReviewInputSchema).output(returnDetailSchema),
  /** owner flags the returned goods as damaged: MANUAL_ADJUSTMENT removal */
  returnsReject: oc.input(returnsReviewInputSchema).output(returnDetailSchema),

  // --- purchase intake (ticket 29) ------------------------------------------
  /** per-line preview: how much of this purchase can link to earlier uninvoiced stock */
  purchasesProposal: oc.input(z.object({ invoiceId: z.string().uuid() })).output(purchasesProposalOutputSchema),
  purchasesLinkStock: oc.input(purchasesLinkStockInputSchema).output(purchasesLinkStockOutputSchema),
  purchasesCorrectLine: oc.input(purchasesCorrectLineInputSchema).output(invoiceDetailSchema),

  // --- reports -------------------------------------------------------------
  reportsDebts: oc.output(debtsOutputSchema),
  /** ticket 31 — profit report computed from raw records at read time */
  reportsProfit: oc.input(profitReportInputSchema).output(profitReportOutputSchema),

  // --- dashboard (issue 84) ------------------------------------------------
  /** one aggregate read for the landing screen: the server's day, the day's
   * exact sales, both debt directions, low stock, and the newest invoices */
  dashboardSummary: oc.output(dashboardSummaryOutputSchema),

  // --- getting started (issue 97) ------------------------------------------
  /** one EXISTS read: whether the shop has an item, a purchase, a sale, and a
   * party-attributed debt — the dashboard checklist's completion source */
  onboardingProgress: oc.output(onboardingProgressOutputSchema),
  /** idempotently record the completed milestone once every record exists */
  onboardingComplete: oc.output(onboardingCompleteOutputSchema),

  // --- expenses (ticket 31) -------------------------------------------------
  expenseCategoriesList: oc.output(z.object({ items: z.array(expenseCategorySchema) })),
  expenseCategoriesCreate: oc.input(expenseCategoryCreateInputSchema).output(expenseCategorySchema),
  expensesList: oc.input(expenseListInputSchema).output(expenseListOutputSchema),
  expensesCreate: oc.input(expenseCreateInputSchema).output(expenseSchema),

  // --- debts screen drill-down (ticket 9) ----------------------------------
  /** unpaid invoices for one person, matched by the same identity debtSummaries groups by */
  debtsByParty: oc.input(debtsByPartyInputSchema).output(invoiceListOutputSchema),

  // --- settings ------------------------------------------------------------
  settingsGet: oc.output(settingsSchema),
  settingsUpdate: oc.input(settingsUpdateInputSchema).output(settingsSchema),

  // --- UI preferences (issue 97 follow-up) ---------------------------------
  /** sidebar/onboarding shell state, separate from store-identity settings;
   * server-side so a packaged restart (new localhost port) is not a wipe */
  preferencesGet: oc.output(preferencesGetOutputSchema),
  preferencesSet: oc.input(preferencesSetInputSchema).output(preferencesSetOutputSchema),

  // --- activity log --------------------------------------------------------
  activitiesList: oc.input(activityListInputSchema).output(activityListOutputSchema),
  // --- diagnostics (developer-facing) --------------------------------------
  diagnosticsLogsTail: oc.input(logsTailInputSchema).output(logsTailOutputSchema),

  // --- backup --------------------------------------------------------------
  backupManual: oc.output(backupManualOutputSchema),
};

/** The typed client the web app and tests consume. */
export type DokanClient = ContractRouterClient<typeof dokanContract>;
