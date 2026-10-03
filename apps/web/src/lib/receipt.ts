import type { InvoiceDetail, InvoiceKind, Settings } from "@dokan/contracts";

import { combineBusinessDateTime } from "./dates";
import { paginateLineSlices, textRowUnits } from "./print-pagination";

/**
 * Receipt printing — printable receipt projection. The print flow needs one
 * flat, render-ready document: store identity + invoice header + lines + totals +
 * paid/remaining. This module is the deterministic seam between the invoice
 * detail/settings reads and the print-only view.
 *
 * Deliberately NO money math on the invoice's own figures: total / paid /
 * remaining are copied verbatim from the invoice detail (they are
 * authoritative), so the receipt can never disagree with the screen. The one
 * sum it does is the carried running total of the lines it prints, which is a
 * presentation fact, not a total.
 *
 * The payment history lives on the invoice SCREEN only (owner decision, later
 * reversed from the original "decision A"): the printed invoice does not carry
 * it, so the projection does not either and the paginator reserves no room for
 * it.
 *
 * The settled sheet (issue #121) is paginated in JS because CSS cannot write
 * the "page X of Y" footer. `paginateReceipt` splits the lines into A4 sheets from a
 * conservative height budget and decides which sheet carries the totals.
 */

export interface ReceiptLine {
  description: string;
  quantity: number;
  unitPrice: number;
  netTotal: number;
}

export interface Receipt {
  storeName: string;
  storePhone: string | null;
  storeAddress: string | null;
  invoiceNumber: string;
  kind: InvoiceKind;
  /**
   * The business date with the clock time the row was recorded
   * (`invoiceDate` + `createdAt`): the date-and-time meta value. A backdated
   * invoice keeps its business day and shows when it was entered.
   */
  invoiceDateTime: string;
  counterpartyName: string | null;
  lines: ReceiptLine[];
  subtotalAmount: number;
  discountAmount: number;
  totalAmount: number;
  paidAmount: number;
  remainingAmount: number;
}

/**
 * One A4 sheet of the printed invoice. `carryIn`/`carryOut` are the running net
 * total of the printed lines: the carried-total footer on a sheet that does
 * not close, and the carried-from banner on the next one.
 */
export interface ReceiptPage {
  /** 1-based sheet number; the footer prints "page {number} of {total}" */
  number: number;
  lines: ReceiptLine[];
  /** running net total carried INTO this sheet (0 on sheet 1) */
  carryIn: number;
  /** running net total this sheet carries to the next; null when it closes */
  carryOut: number | null;
  /** true on the sheet that prints the totals block */
  closes: boolean;
}

/**
 * Project an invoice detail + store settings into a print-ready receipt.
 * Pure: no DOM, no i18n, no network — unit-testable without a renderer.
 *
 * Invoice notes are deliberately NOT carried: the owner decided notes stay in
 * the database and the app screen only, never on the printed sheet (the settled
 * sheet has no notes field). Do not add `notes` back to `Receipt`.
 *
 * The payment history is likewise not carried: the printed invoice does not
 * show it (the invoice SCREEN keeps the payments log). Do not add `payments`
 * back to `Receipt`.
 */
export function buildReceipt(invoice: InvoiceDetail, settings: Settings): Receipt {
  return {
    storeName: settings.storeName,
    storePhone: settings.storePhone,
    storeAddress: settings.storeAddress,
    invoiceNumber: invoice.invoiceNumber,
    kind: invoice.kind,
    invoiceDateTime: combineBusinessDateTime(invoice.invoiceDate, invoice.createdAt),
    counterpartyName: invoice.counterpartyName,
    lines: invoice.lines.map((line) => ({
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      netTotal: line.netTotal,
    })),
    subtotalAmount: invoice.subtotalAmount,
    discountAmount: invoice.discountAmount,
    totalAmount: invoice.totalAmount,
    paidAmount: invoice.paidAmount,
    remainingAmount: invoice.remainingAmount,
  };
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------

/**
 * The sheet's variable content budget in "row units" (one unit ≈ one table
 * row). The measured budget of the settled sheet is roughly 20 rows; 13 keeps
 * ~35% headroom for font-metric drift while staying close to the template's
 * density (10 rows + totals on its first sheet).
 */
const PAGE_UNITS = 13;
/** the items heading, first sheet only */
const ITEMS_TITLE_UNITS = 1;
/** the carried-total block under a non-closing table */
const CARRY_UNITS = 2;
/** the carried-from banner on continuation sheets */
const CARRY_BANNER_UNITS = 2;
/** the heavy rule + the five totals rows (subtotal, discount, total, paid, remaining) */
const TOTALS_UNITS = 5;
/** conservative characters that fit on one row before an item cell wraps */
const LINE_DESCRIPTION_CHARS = 32;

/** Height weight of one item line: a long description wraps and costs another row. */
function lineUnits(line: ReceiptLine): number {
  return textRowUnits(line.description, LINE_DESCRIPTION_CHARS);
}

function sumNet(lines: readonly ReceiptLine[]): number {
  return lines.reduce((sum, line) => sum + line.netTotal, 0);
}

/** Spare room on the sheet that carries the totals block, before lines. */
function closingSpare(pageIsFirst: boolean): number {
  return PAGE_UNITS - TOTALS_UNITS - (pageIsFirst ? ITEMS_TITLE_UNITS : CARRY_BANNER_UNITS);
}

/** Spare room on a sheet that carries the carried total instead of the totals block. */
function continuationSpare(pageIsFirst: boolean): number {
  return PAGE_UNITS - CARRY_UNITS - (pageIsFirst ? ITEMS_TITLE_UNITS : CARRY_BANNER_UNITS);
}

/**
 * Split the receipt into A4 sheets. Lines are packed to the minimal sheet count
 * and distributed evenly, so a mid-range invoice does not end with a one-line
 * middle sheet. The last sheet closes with the totals; earlier sheets carry the
 * running total off to the next.
 */
export function paginateReceipt(receipt: Receipt): ReceiptPage[] {
  const lineCosts = receipt.lines.map(lineUnits);

  // Weighted split: no sheet exceeds its budget, and the sheet count is the
  // smallest one the weights actually fit into.
  const slices = paginateLineSlices(lineCosts, {
    firstClosing: closingSpare(true),
    restClosing: closingSpare(false),
    firstContinuation: continuationSpare(true),
    continuation: continuationSpare(false),
  });

  const pages: ReceiptPage[] = [];
  let lineCursor = 0;
  let carried = 0;

  for (const [index, end] of slices.entries()) {
    const isClosing = index === slices.length - 1;
    const lines = receipt.lines.slice(lineCursor, end);
    lineCursor = end;
    const carriedIn = carried;
    carried += sumNet(lines);
    pages.push({
      number: index + 1,
      lines,
      carryIn: carriedIn,
      carryOut: isClosing ? null : carried,
      closes: isClosing,
    });
  }

  return pages;
}
