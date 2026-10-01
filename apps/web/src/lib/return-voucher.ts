import type { ReturnDetail, Settings } from "@dokan/contracts";

import { paginateLineSlices, textRowUnits } from "./print-pagination";

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
  storeAddress: string | null;
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
    storeAddress: settings.storeAddress,
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

/** One A4 sheet of the printed voucher; `closes` carries the totals block. */
export interface ReturnVoucherPage {
  /** 1-based sheet number */
  number: number;
  lines: ReturnVoucherLine[];
  closes: boolean;
}

/** Same conservative sheet budget as the invoice (see lib/receipt.ts). */
const VOUCHER_PAGE_UNITS = 13;
/** the heavy rule + the three totals rows */
const VOUCHER_TOTALS_UNITS = 4;
/** the items heading, first sheet only */
const VOUCHER_TITLE_UNITS = 1;
/** the voucher meta wraps to two rows; the invoice meta is one */
const VOUCHER_META_EXTRA_UNITS = 1;
/** conservative characters that fit on one row before a line description wraps */
const VOUCHER_DESCRIPTION_CHARS = 32;

const VOUCHER_CLOSING_FIRST =
  VOUCHER_PAGE_UNITS - VOUCHER_TOTALS_UNITS - VOUCHER_META_EXTRA_UNITS - VOUCHER_TITLE_UNITS;
const VOUCHER_CLOSING_REST = VOUCHER_PAGE_UNITS - VOUCHER_TOTALS_UNITS - VOUCHER_META_EXTRA_UNITS;
const VOUCHER_FIRST_CONTINUATION =
  VOUCHER_PAGE_UNITS - VOUCHER_META_EXTRA_UNITS - VOUCHER_TITLE_UNITS;
const VOUCHER_CONTINUATION = VOUCHER_PAGE_UNITS - VOUCHER_META_EXTRA_UNITS;

/**
 * Split the voucher lines into A4 sheets: a return can carry up to 200 lines,
 * and the footer must not claim "page 1 of 1" over a clipped table. The full
 * store/meta header repeats on every sheet and the totals close the last one;
 * there is no carried total because the voucher prints no running sum.
 */
export function paginateReturnVoucher(voucher: ReturnVoucher): ReturnVoucherPage[] {
  const costs = voucher.lines.map((line) => textRowUnits(line.description, VOUCHER_DESCRIPTION_CHARS));
  const slices = paginateLineSlices(costs, {
    firstClosing: VOUCHER_CLOSING_FIRST,
    restClosing: VOUCHER_CLOSING_REST,
    firstContinuation: VOUCHER_FIRST_CONTINUATION,
    continuation: VOUCHER_CONTINUATION,
  });
  let cursor = 0;
  return slices.map((end, index) => {
    const lines = voucher.lines.slice(cursor, end);
    cursor = end;
    return { number: index + 1, lines, closes: index === slices.length - 1 };
  });
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
