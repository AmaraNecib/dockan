import type { ReturnDetail, ReturnPayoutMethod, ReturnStatus, Settings } from "@dokan/contracts";

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
  /** the contract's closed union, not `string`: the voucher's copy is chosen by
   * a template literal key (`pmtMethod_${payoutMethod}`), and #322 makes that key
   * checked only while the value is a union of literals. */
  payoutMethod: ReturnPayoutMethod;
  /** total return value; cashPaidOut + debtOffset = refundAmount */
  refundAmount: number;
  /** cash handed back to the customer now */
  cashPaidOut: number;
  /** deducted from the invoice's remaining debt */
  debtOffset: number;
  /** portion of debtOffset already applied to the invoice (#68: acceptance applies it) */
  debtApplied: number;
  reason: string | null;
  /** same reasoning as `payoutMethod`: `returnsStatus_${status}` must collapse
   * to literal keys for the compiler to check the copy exists. */
  status: ReturnStatus;
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
/** the six base meta fields take two grid rows; the invoice meta takes one */
const VOUCHER_META_BASE_EXTRA_UNITS = 1;
/** conservative characters that fit on one row before a line description wraps */
const VOUCHER_DESCRIPTION_CHARS = 32;
/** conservative characters per row for the party cell (one of three columns) */
const VOUCHER_PARTY_CHARS = 20;
/** conservative characters per row for the full-width reason row */
const VOUCHER_REASON_CHARS = 60;

/**
 * The meta's real row cost above the invoice's single row: the base two rows,
 * plus one row for the reason, plus however many rows a wrapping party name
 * needs. Charging it keeps a voucher with a reason or a long party inside its
 * sheet budget instead of overrunning it.
 */
function metaExtraUnits(voucher: ReturnVoucher): number {
  let extra = VOUCHER_META_BASE_EXTRA_UNITS;
  if (voucher.counterpartyName !== null) {
    extra += textRowUnits(voucher.counterpartyName, VOUCHER_PARTY_CHARS) - 1;
  }
  if (voucher.reason !== null) {
    extra += textRowUnits(voucher.reason, VOUCHER_REASON_CHARS);
  }
  return extra;
}

/** A meta taller than a sheet cannot fit anywhere; the caps stay positive so
 * the paginator still terminates and prints every line. */
const atLeastOne = (units: number): number => Math.max(1, units);

/**
 * Split the voucher lines into A4 sheets: a return can carry up to 200 lines,
 * and the footer must not claim "page 1 of 1" over a clipped table. The full
 * store/meta header repeats on every sheet and the totals close the last one;
 * there is no carried total because the voucher prints no running sum.
 */
export function paginateReturnVoucher(voucher: ReturnVoucher): ReturnVoucherPage[] {
  const costs = voucher.lines.map((line) => textRowUnits(line.description, VOUCHER_DESCRIPTION_CHARS));
  const meta = metaExtraUnits(voucher);
  const slices = paginateLineSlices(costs, {
    firstClosing: atLeastOne(VOUCHER_PAGE_UNITS - VOUCHER_TOTALS_UNITS - meta - VOUCHER_TITLE_UNITS),
    restClosing: atLeastOne(VOUCHER_PAGE_UNITS - VOUCHER_TOTALS_UNITS - meta),
    firstContinuation: atLeastOne(VOUCHER_PAGE_UNITS - meta - VOUCHER_TITLE_UNITS),
    continuation: atLeastOne(VOUCHER_PAGE_UNITS - meta),
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
