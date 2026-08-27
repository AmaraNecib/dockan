import type { ReturnDetail, Settings } from "@dokan/contracts";

/**
 * Return voucher printing — printable voucher projection. The print flow
 * needs one flat, render-ready document: store identity + return header
 * (return number, original invoice number/date/party) + returned lines +
 * refund total + payout method + review status. This module is the
 * deterministic seam between the stored return record and the print-only
 * view, mirroring lib/receipt.ts for the receipt route.
 *
 * Deliberately NO money math: every amount is copied verbatim from the
 * persisted return detail (refundAmount / refundUnitPrice are snapshots
 * frozen at return time), so the voucher can never disagree with the screen.
 * RTL decisions (which cells need dir="ltr" for dates/phones) are the
 * view's, signaled by keeping raw strings here.
 */

export interface ReturnVoucherLine {
  description: string;
  quantity: number;
  refundUnitPrice: number;
  refundAmount: number;
}

export interface ReturnVoucher {
  storeName: string;
  storePhone: string | null;
  returnNumber: string;
  invoiceNumber: string;
  invoiceDate: string;
  counterpartyName: string | null;
  payoutMethod: string;
  /** total return value; cashPaidOut + debtOffset = refundAmount */
  refundAmount: number;
  /** cash handed back to the customer now */
  cashPaidOut: number;
  /** deducted from the invoice's remaining debt */
  debtOffset: number;
  /** portion of debtOffset already applied to the invoice (#68: acceptance applies it) */
  debtApplied: number;
  reason: string | null;
  status: string;
  lines: ReturnVoucherLine[];
}

/**
 * Project a stored return record + store settings into a print-ready voucher.
 * Pure: no DOM, no i18n, no network — unit-testable without a renderer.
 */
export function buildReturnVoucher(returnDetail: ReturnDetail, settings: Settings): ReturnVoucher {
  return {
    storeName: settings.storeName,
    storePhone: settings.storePhone,
    returnNumber: returnDetail.returnNumber,
    invoiceNumber: returnDetail.invoiceNumber,
    invoiceDate: returnDetail.invoiceDate,
    counterpartyName: returnDetail.counterpartyName,
    payoutMethod: returnDetail.payoutMethod,
    refundAmount: returnDetail.refundAmount,
    cashPaidOut: returnDetail.cashPaidOut,
    debtOffset: returnDetail.debtOffset,
    debtApplied: returnDetail.debtApplied,
    reason: returnDetail.reason,
    status: returnDetail.status,
    lines: returnDetail.lines.map((line) => ({
      description: line.description,
      quantity: line.quantity,
      refundUnitPrice: line.refundUnitPrice,
      refundAmount: line.refundAmount,
    })),
  };
}

/**
 * What the debt portion line should display (#68): the ACCEPTED label always
 * shows the amount really applied (debtApplied), which can be less than the
 * recorded promise after the accept-time cap; PENDING shows the recorded
 * promise as applying on acceptance. REJECTED is special: new returns apply
 * nothing (show the promise as “not applied”), while a LEGACY row backfilled
 * with debtApplied > 0 was already settled at creation and reads as applied.
 */
export function debtOffsetDisplay(status: ReturnVoucher["status"], debtOffset: number, debtApplied: number) {
  if (status === "ACCEPTED") {
    return { labelKey: "returnsDebtOffsetApplied" as const, value: debtApplied };
  }
  if (status === "REJECTED_DAMAGED") {
    return debtApplied > 0
      ? { labelKey: "returnsDebtOffsetApplied" as const, value: debtApplied }
      : { labelKey: "returnsDebtOffsetNotApplied" as const, value: debtOffset };
  }
  return { labelKey: "returnsDebtOffsetPending" as const, value: debtOffset };
}
