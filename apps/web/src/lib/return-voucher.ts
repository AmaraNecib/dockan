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
  refundAmount: number;
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