import { useTranslation } from "react-i18next";

import { formatDateTime } from "../lib/dates";
import { paginateReceipt, type Receipt } from "../lib/receipt";
import { PrintAmount, PrintItemTable, PrintSheet, PrintTotals } from "./print-sheet";

/**
 * Receipt printing — the print-only A4 invoice sheet (issue #121). Presentational:
 * data arrives as a fully assembled `Receipt` (see lib/receipt.ts), so this view
 * is deterministic to render and needs no queries.
 *
 * The settled design (grilling session 2026-10-01) is one A4 sheet per page:
 * the store header repeats on every page, the footer is pinned to the foot of
 * each sheet with the "page X of Y" footer, and the totals close the last
 * sheet. The page split is decided by `paginateReceipt`; this view only draws it.
 *
 * The payment history is deliberately absent: the invoice SCREEN shows the
 * payments log, the printed invoice does not (owner decision, reversing the
 * original "decision A").
 */
export function ReceiptView({ receipt }: { receipt: Receipt }) {
  const { t } = useTranslation();
  const pages = paginateReceipt(receipt);
  // the party label and the kind value swap together on a purchase
  const sale = receipt.kind === "SALE";
  const partyLabel = sale ? t("invoicePrintCustomer") : t("invoicePrintSupplier");
  const kindLabel = sale ? t("invoicePrintKindSale") : t("invoicePrintKindPurchase");

  return (
    <div dir="rtl" className="print-doc" data-testid="receipt-view">
      {pages.map((page) => (
        <PrintSheet
          key={page.number}
          testIdPrefix="receipt"
          storeName={receipt.storeName}
          storePhone={receipt.storePhone}
          storeAddress={receipt.storeAddress}
          pageNumber={page.number}
          pageCount={pages.length}
          documentRef={receipt.invoiceNumber}
        >
          <dl className="print-sheet-meta">
            <div>
              <dt>{t("invoiceNumber")}</dt>
              <dd dir="ltr" className="print-sheet-ltr" data-testid="receipt-number">
                {receipt.invoiceNumber}
              </dd>
            </div>
            <div>
              <dt>{t("invoiceDateTime")}</dt>
              <dd className="print-sheet-digits" data-testid="receipt-date">
                {formatDateTime(receipt.invoiceDateTime)}
              </dd>
            </div>
            <div className="print-sheet-meta-wrap">
              <dt>{partyLabel}</dt>
              <dd data-testid="receipt-party">{receipt.counterpartyName ?? "—"}</dd>
            </div>
            <div>
              <dt>{t("invoiceKind")}</dt>
              <dd data-testid="receipt-kind">{kindLabel}</dd>
            </div>
          </dl>

          {page.number > 1 && page.lines.length > 0 && (
            <div className="print-sheet-carry" data-testid="receipt-carry-in">
              <span>{t("invoicePrintCarriedFrom")}</span>
              <strong>
                <PrintAmount value={page.carryIn} />
              </strong>
            </div>
          )}

          {page.lines.length > 0 && (
            <PrintItemTable
              title={page.number === 1 ? t("invoicePrintItemsTitle") : undefined}
              titleTestId="receipt-items-title"
              tableTestId="receipt-items"
              rowTestId="receipt-line"
              unitPriceLabel={t("invoicePrintUnitPrice")}
              lineTotalLabel={t("saleLineTotal")}
              lines={page.lines}
              unitPrice={(line) => line.unitPrice}
              lineTotal={(line) => line.netTotal}
            />
          )}

          {page.closes ? (
            <PrintTotals
              testId="receipt-totals"
              rows={[
                { label: t("invoicePrintSubtotal"), amount: receipt.subtotalAmount, valueTestId: "receipt-subtotal" },
                { label: t("saleDiscount"), amount: receipt.discountAmount > 0 ? -receipt.discountAmount : 0, valueTestId: "receipt-discount" },
                { label: t("invoiceTotal"), amount: receipt.totalAmount, grand: true, valueTestId: "receipt-total" },
                { label: t("invoicePaid"), amount: receipt.paidAmount, valueTestId: "receipt-paid" },
                { label: t("invoiceRemaining"), amount: receipt.remainingAmount, valueTestId: "receipt-remaining" },
              ]}
            />
          ) : (
            page.carryOut !== null &&
            page.lines.length > 0 && (
              <PrintTotals
                rows={[
                  {
                    label: t("invoicePrintCarriedTotal"),
                    amount: page.carryOut,
                    grand: true,
                    rowTestId: "receipt-carried-total",
                  },
                ]}
              />
            )
          )}
        </PrintSheet>
      ))}
    </div>
  );
}
