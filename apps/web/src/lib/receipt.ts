import type { InvoiceDetail, InvoiceKind, PaymentMethod, Settings } from "@dokan/contracts";

/**
 * Receipt printing — printable receipt projection. The print flow needs one
 * flat, render-ready document: store identity + invoice header + lines + totals +
 * paid/remaining + payment history. This module is the deterministic seam
 * between the invoice detail/settings reads and the print-only view.
 *
 * Deliberately NO money math: every amount below is copied verbatim from the
 * invoice detail (total / paid / remaining are authoritative), so the receipt
 * can never disagree with the screen. RTL decisions (which cells need
 * dir="ltr" for dates/phones) are the view's, signaled by keeping raw
 * strings here.
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
  invoiceNumber: string;
  kind: InvoiceKind;
  invoiceDate: string;
  counterpartyName: string | null;
  notes: string | null;
  lines: ReceiptLine[];
  subtotalAmount: number;
  discountAmount: number;
  totalAmount: number;
  paidAmount: number;
  remainingAmount: number;
  payments: ReceiptPayment[];
}

/**
 * Project an invoice detail + store settings into a print-ready receipt.
 * Pure: no DOM, no i18n, no network — unit-testable without a renderer.
 */
export function buildReceipt(invoice: InvoiceDetail, settings: Settings): Receipt {
  return {
    storeName: settings.storeName,
    storePhone: settings.storePhone,
    invoiceNumber: invoice.invoiceNumber,
    kind: invoice.kind,
    invoiceDate: invoice.invoiceDate,
    counterpartyName: invoice.counterpartyName,
    notes: invoice.notes,
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