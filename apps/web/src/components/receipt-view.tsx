import { useTranslation } from "react-i18next";

import { formatDate, formatDateTime } from "../lib/dates";
import { paginateReceipt, type Receipt, type ReceiptPayment } from "../lib/receipt";
import { PrintAmount, PrintItemTable, PrintSheet, PrintTotals } from "./print-sheet";

/**
 * Receipt printing — the print-only A4 invoice sheet (issue #121). Presentational:
 * data arrives as a fully assembled `Receipt` (see lib/receipt.ts), so this view
 * is deterministic to render and needs no queries.
 *
 * The settled design (grilling session 2026-10-01) is one A4 sheet per page:
 * the store header repeats on every page, the footer is pinned to the foot of
 * each sheet with «صفحة X من Y», and the totals close the last sheet. The page
 * split is decided by `paginateReceipt`; this view only draws it.
 */
export function ReceiptView({ receipt }: { receipt: Receipt }) {
  const { t } = useTranslation();
  const pages = paginateReceipt(receipt);

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
              <dt>{t("invoicePrintDateTime")}</dt>
              <dd className="print-sheet-digits" data-testid="receipt-date">
                {formatDate(receipt.invoiceDate)}
              </dd>
            </div>
            <div>
              <dt>{receipt.kind === "SALE" ? t("invoicePrintCustomer") : t("invoicePrintSupplier")}</dt>
              <dd data-testid="receipt-party">{receipt.counterpartyName ?? "—"}</dd>
            </div>
            <div>
              <dt>{t("invoiceKind")}</dt>
              <dd data-testid="receipt-kind">
                {receipt.kind === "SALE" ? t("invoicePrintKindSale") : t("invoicePrintKindPurchase")}
              </dd>
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
                { label: t("invoicePrintSubtotal"), amount: receipt.subtotalAmount, testId: "receipt-subtotal" },
                { label: t("saleDiscount"), amount: receipt.discountAmount > 0 ? -receipt.discountAmount : 0, testId: "receipt-discount" },
                { label: t("invoiceTotal"), amount: receipt.totalAmount, grand: true, testId: "receipt-total" },
                { label: t("invoicePaid"), amount: receipt.paidAmount, testId: "receipt-paid" },
                { label: t("invoiceRemaining"), amount: receipt.remainingAmount, testId: "receipt-remaining" },
              ]}
            />
          ) : (
            page.carryOut !== null && (
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

          {page.payments.length > 0 && <ReceiptPayments payments={page.payments} />}
        </PrintSheet>
      ))}
    </div>
  );
}

/** The payment history section (decision A: the printed invoice carries it). */
function ReceiptPayments({ payments }: { payments: ReceiptPayment[] }) {
  const { t } = useTranslation();

  return (
    <section className="print-sheet-payments" data-testid="receipt-payments">
      <h2>{t("pmtTitle")}</h2>
      <table className="print-sheet-payments">
        <thead>
          <tr>
            <th scope="col">{t("pmtDate")}</th>
            <th scope="col">{t("pmtAmount")}</th>
            <th scope="col">{t("pmtMethod")}</th>
            <th scope="col">{t("pmtNote")}</th>
          </tr>
        </thead>
        <tbody>
          {payments.map((payment, index) => (
            <tr key={`${payment.paidAt}-${index}`} data-testid="receipt-payment">
              <td className="print-sheet-digits">
                {formatDateTime(payment.paidAt)}
              </td>
              <td>
                <PrintAmount value={payment.amount} />
              </td>
              <td>{t(`pmtMethod_${payment.method}`)}</td>
              <td className="print-sheet-note">{payment.note ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
