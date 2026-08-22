import { oc } from "@orpc/contract";
import { z } from "zod";

import {
  activityListInputSchema,
  activityListOutputSchema,
  backupManualOutputSchema,
  categoryCreateInputSchema,
  categorySchema,
  customerSchema,
  debtsOutputSchema,
  healthOutputSchema,
  invoiceCreateInputSchema,
  invoiceDetailSchema,
  invoiceListInputSchema,
  invoiceListOutputSchema,
  invoicePayInputSchema,
  itemCreateInputSchema,
  itemSchema,
  itemUpdateInputSchema,
  loginInputSchema,
  loginOutputSchema,
  logsTailInputSchema,
  logsTailOutputSchema,
  lowStockOutputSchema,
  partyCreateInputSchema,
  resetPasswordInputSchema,
  resetPasswordOutputSchema,
  settingsSchema,
  settingsUpdateInputSchema,
  supplierSchema,
} from "./core";

/**
 * The Dokan RPC contract — every procedure the UI can call.
 * Flat, prefixed names (matches the tuari monorepo pattern we build on).
 */
export const dokanContract = {
  health: oc.output(healthOutputSchema),

  // --- auth ----------------------------------------------------------------
  authLogin: oc.input(loginInputSchema).output(loginOutputSchema),
  authResetPassword: oc.input(resetPasswordInputSchema).output(resetPasswordOutputSchema),

  // --- categories ----------------------------------------------------------
  categoriesList: oc.output(z.object({ items: z.array(categorySchema) })),
  categoriesCreate: oc.input(categoryCreateInputSchema).output(categorySchema),

  // --- items ---------------------------------------------------------------
  itemsList: oc.output(z.object({ items: z.array(itemSchema) })),
  itemsCreate: oc.input(itemCreateInputSchema).output(itemSchema),
  itemsUpdate: oc.input(itemUpdateInputSchema).output(itemSchema),
  itemsLowStock: oc.output(lowStockOutputSchema),

  // --- parties -------------------------------------------------------------
  customersList: oc.output(z.object({ items: z.array(customerSchema) })),
  customersCreate: oc.input(partyCreateInputSchema).output(customerSchema),
  suppliersList: oc.output(z.object({ items: z.array(supplierSchema) })),
  suppliersCreate: oc.input(partyCreateInputSchema).output(supplierSchema),

  // --- invoices ------------------------------------------------------------
  invoicesCreate: oc.input(invoiceCreateInputSchema).output(invoiceDetailSchema),
  invoicesGet: oc.input(z.object({ id: z.string().uuid() })).output(invoiceDetailSchema),
  invoicesList: oc.input(invoiceListInputSchema).output(invoiceListOutputSchema),
  invoicesPay: oc.input(invoicePayInputSchema).output(invoiceDetailSchema),

  // --- reports -------------------------------------------------------------
  reportsDebts: oc.output(debtsOutputSchema),

  // --- settings ------------------------------------------------------------
  settingsGet: oc.output(settingsSchema),
  settingsUpdate: oc.input(settingsUpdateInputSchema).output(settingsSchema),

  // --- activity log --------------------------------------------------------
  activitiesList: oc.input(activityListInputSchema).output(activityListOutputSchema),

  // --- diagnostics (developer-facing) --------------------------------------
  diagnosticsLogsTail: oc.input(logsTailInputSchema).output(logsTailOutputSchema),

  // --- backup --------------------------------------------------------------
  backupManual: oc.output(backupManualOutputSchema),
};