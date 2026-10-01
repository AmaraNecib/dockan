import type { InvoiceDetail, InvoiceKind, PaymentMethod, Settings } from "@dokan/contracts";

/**
 * Receipt printing — printable receipt projection. The print flow needs one
 * flat, render-ready document: store identity + invoice header + lines + totals +
 * paid/remaining + payment history. This module is the deterministic seam
 * between the invoice detail/settings reads and the print-only view.
 *
 * Deliberately NO money math on the invoice's own figures: total / paid /
 * remaining are copied verbatim from the invoice detail (they are
 * authoritative), so the receipt can never disagree with the screen. The one
 * sum it does is the carried running total of the lines it prints, which is a
 * presentation fact, not a total.
 *
 * The settled sheet (issue #121) is paginated in JS because CSS cannot write
 * «صفحة X من Y». `paginateReceipt` splits the lines into A4 sheets from a
 * conservative height budget and decides which sheet carries the totals.
 */

export interface ReceiptLine {
  description: string;
  quantity: number;
  unitPrice: number;
  netTotal: number;
}

export interface ReceiptPayment {
  paidAt: string;
  method: PaymentMethod;
  amount: number;
  note: string | null;
}

export interface Receipt {
  storeName: string;
  storePhone: string | null;
  storeAddress: string | null;
  invoiceNumber: string;
  kind: InvoiceKind;
  invoiceDate: string;
  counterpartyName: string | null;
  lines: ReceiptLine[];
  subtotalAmount: number;
  discountAmount: number;
  totalAmount: number;
  paidAmount: number;
  remainingAmount: number;
  payments: ReceiptPayment[];
}

/**
 * One A4 sheet of the printed invoice. `carryIn`/`carryOut` are the running net
 * total of the printed lines: the footer of «المجموع المنقول» on a sheet that
 * does not close, and the «منقول من الصفحة السابقة» banner on the next one.
 */
export interface ReceiptPage {
  /** 1-based sheet number; the footer prints «صفحة {number} من {total}» */
  number: number;
  lines: ReceiptLine[];
  /** running net total carried INTO this sheet (0 on sheet 1) */
  carryIn: number;
  /** running net total this sheet carries to the next; null when it closes or
   * carries no line table (a payment-overflow sheet) */
  carryOut: number | null;
  /** true on the sheet that prints the totals block and starts the payment history */
  closes: boolean;
  /** payment rows printed on this sheet (the closing sheet, then any overflow) */
  payments: ReceiptPayment[];
}

/**
 * Project an invoice detail + store settings into a print-ready receipt.
 * Pure: no DOM, no i18n, no network — unit-testable without a renderer.
 *
 * Invoice notes are deliberately NOT carried: the owner decided notes stay in
 * the database and the app screen only, never on the printed sheet (the settled
 * sheet has no notes field). Do not add `notes` back to `Receipt`.
 */
export function buildReceipt(invoice: InvoiceDetail, settings: Settings): Receipt {
  return {
    storeName: settings.storeName,
    storePhone: settings.storePhone,
    storeAddress: settings.storeAddress,
    invoiceNumber: invoice.invoiceNumber,
    kind: invoice.kind,
    invoiceDate: invoice.invoiceDate,
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
    payments: invoice.payments.map((payment) => ({
      paidAt: payment.paidAt,
      method: payment.method,
      amount: payment.amount,
      note: payment.note,
    })),
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
/** «المشتريات» heading, first sheet only */
const ITEMS_TITLE_UNITS = 1;
/** the «المجموع المنقول» block under a non-closing table */
const CARRY_UNITS = 2;
/** the «منقول من الصفحة السابقة» banner, continuation sheets */
const CARRY_BANNER_UNITS = 2;
/** the heavy rule + the five totals rows (subtotal, discount, total, paid, remaining) */
const TOTALS_UNITS = 5;
/** payment section heading + table head + spacing */
const PAYMENT_HEAD_UNITS = 3;
/** conservative characters that fit on one row before an item cell wraps */
const LINE_DESCRIPTION_CHARS = 32;
/** conservative characters that fit on one row before a payment note wraps */
const PAYMENT_NOTE_CHARS = 20;

/** Height weight of one item line: a long description wraps and costs another row. */
function lineUnits(line: ReceiptLine): number {
  return Math.max(1, Math.ceil(line.description.length / LINE_DESCRIPTION_CHARS));
}

/** Height weight of one payment row: a long note wraps and costs another row. */
function paymentUnits(payment: ReceiptPayment): number {
  const note = payment.note ?? "";
  return 1 + Math.max(0, Math.ceil(note.length / PAYMENT_NOTE_CHARS) - 1);
}

function sumNet(lines: readonly ReceiptLine[]): number {
  return lines.reduce((sum, line) => sum + line.netTotal, 0);
}

function totalUnits(costs: readonly number[]): number {
  return costs.reduce((sum, cost) => sum + cost, 0);
}

/** How many leading items fit inside `budget` units (at least one row stays whole). */
function takeWithin(costs: readonly number[], budget: number): number {
  let used = 0;
  let count = 0;
  for (const cost of costs) {
    if (used + cost > budget) break;
    used += cost;
    count += 1;
  }
  return count;
}

/** Spare room on the sheet that carries the totals block, before lines/payments.
 * The payment-section head is only reserved when there are payments to print. */
function closingSpare(pageIsFirst: boolean, withPayments: boolean): number {
  return (
    PAGE_UNITS -
    TOTALS_UNITS -
    (withPayments ? PAYMENT_HEAD_UNITS : 0) -
    (pageIsFirst ? ITEMS_TITLE_UNITS : CARRY_BANNER_UNITS)
  );
}

/** Spare room on a sheet that carries the carried total instead of the totals block. */
function continuationSpare(pageIsFirst: boolean): number {
  return PAGE_UNITS - CARRY_UNITS - (pageIsFirst ? ITEMS_TITLE_UNITS : CARRY_BANNER_UNITS);
}

/**
 * Split the receipt into A4 sheets. Payment rows claim the closing sheet's
 * spare room first (they print after the totals); any overflow continues on
 * sheets with the full header and a repeated payment table. Lines are packed
 * to the minimal sheet count and distributed evenly, so a mid-range invoice
 * does not end with a one-line middle sheet.
 */
export function paginateReceipt(receipt: Receipt): ReceiptPage[] {
  const lineCosts = receipt.lines.map(lineUnits);
  const paymentCosts = receipt.payments.map(paymentUnits);
  const lineUnitTotal = totalUnits(lineCosts);
  const hasPayments = receipt.payments.length > 0;

  // How much line room the closing sheet keeps after its five totals rows and
  // the payment rows that fit above the lines.
  const closingLineRoom = (pageIsFirst: boolean): number => {
    const spare = closingSpare(pageIsFirst, hasPayments);
    return spare - takeWithin(paymentCosts, spare);
  };
  const firstClosingRoom = closingLineRoom(true);
  const restClosingRoom = closingLineRoom(false);

  // Minimal sheet count: pages before the closing one are non-final sheets
  // (page 1 carries the items title, later ones carry the banner).
  let sheetCount = 1;
  if (lineUnitTotal > firstClosingRoom) {
    sheetCount = 2;
    while (
      lineUnitTotal >
      continuationSpare(true) + (sheetCount - 2) * continuationSpare(false) + restClosingRoom
    ) {
      sheetCount += 1;
    }
  }

  const pages: ReceiptPage[] = [];
  let lineCursor = 0;
  let unitsPlaced = 0;
  let carried = 0;

  for (let index = 0; index < sheetCount; index += 1) {
    const isFirst = index === 0;
    const isClosing = index === sheetCount - 1;
    const capacity = isClosing
      ? (isFirst ? firstClosingRoom : restClosingRoom)
      : continuationSpare(isFirst);

    let take: number;
    if (isClosing) {
      take = receipt.lines.length - lineCursor;
    } else {
      const remaining = lineUnitTotal - unitsPlaced;
      const sheetsAfter = sheetCount - index - 1;
      const capacityAfter =
        sheetsAfter === 0 ? 0 : continuationSpare(false) * (sheetsAfter - 1) + restClosingRoom;
      // even share of what is left, never less than what the later sheets need
      const evenShare = Math.ceil(remaining / (sheetsAfter + 1));
      const budget = Math.min(Math.max(evenShare, remaining - capacityAfter, 1), capacity);
      let used = 0;
      take = 0;
      while (lineCursor + take < receipt.lines.length && used + (lineCosts[lineCursor + take] ?? 1) <= budget) {
        used += lineCosts[lineCursor + take] ?? 1;
        take += 1;
      }
      if (take === 0) take = 1; // a single line bigger than the share still prints
    }

    const lines = receipt.lines.slice(lineCursor, lineCursor + take);
    lineCursor += take;
    unitsPlaced += totalUnits(lines.map(lineUnits));
    const carriedIn = carried;
    carried += sumNet(lines);
    pages.push({
      number: index + 1,
      lines,
      carryIn: carriedIn,
      carryOut: isClosing ? null : carried,
      closes: isClosing,
      payments: [],
    });
  }

  // Payments: fill the closing sheet from the top, then one overflow sheet per
  // full payment table.
  const closing = pages[pages.length - 1];
  if (closing !== undefined) {
    const onClosing = takeWithin(paymentCosts, closingSpare(pages.length === 1, hasPayments));
    closing.payments = receipt.payments.slice(0, onClosing);
    let cursor = onClosing;
    while (cursor < receipt.payments.length) {
      let count = takeWithin(paymentCosts.slice(cursor), PAGE_UNITS - PAYMENT_HEAD_UNITS);
      if (count === 0) count = 1; // a note longer than a whole sheet still gets a row
      const payments = receipt.payments.slice(cursor, cursor + count);
      cursor += count;
      pages.push({
        number: pages.length + 1,
        lines: [],
        carryIn: carried,
        carryOut: null,
        closes: false,
        payments,
      });
    }
  }

  return pages;
}
