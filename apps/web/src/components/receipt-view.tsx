import { useTranslation } from "react-i18next";

import { formatPrintDateTime } from "../lib/print-format";
import { paginateReceipt, type Receipt, type ReceiptPayment } from "../lib/receipt";
import { PrintAmount, PrintSheet } from "./print-sheet";

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
              <dd dir="ltr" className="print-sheet-n" data-testid="receipt-number">
                {receipt.invoiceNumber}
              </dd>
            </div>
            <div>
              <dt>{t("invoicePrintDateTime")}</dt>
              <dd dir="ltr" className="print-sheet-n" data-testid="receipt-date">
                {formatPrintDateTime(receipt.invoiceDate)}
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
            <table className="print-sheet-items" data-testid="receipt-items">
              {page.number === 1 && (
                <caption className="print-sheet-items-title" data-testid="receipt-items-title">
                  {t("invoicePrintItemsTitle")}
                </caption>
              )}
              <thead>
                <tr>
                  <th scope="col" style={{ width: "42%" }}>
                    {t("itemsName")}
                  </th>
                  <th scope="col" style={{ width: "12%" }}>
                    {t("saleQuantity")}
                  </th>
                  <th scope="col" style={{ width: "23%" }}>
                    {t("invoicePrintUnitPrice")}
                  </th>
                  <th scope="col" style={{ width: "23%" }}>
                    {t("saleLineTotal")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {page.lines.map((line, index) => (
                  <tr key={`${line.description}-${index}`} data-testid="receipt-line">
                    <td>{line.description}</td>
                    <td dir="ltr" className="print-sheet-n">
                      {line.quantity}
                    </td>
                    <td className="print-sheet-num">
                      <PrintAmount value={line.unitPrice} />
                    </td>
                    <td className="print-sheet-num">
                      <PrintAmount value={line.netTotal} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          {page.closes ? (
            <div className="print-sheet-totals" data-testid="receipt-totals">
              <div>
                <span className="print-sheet-label">{t("invoicePrintSubtotal")}</span>
                <span data-testid="receipt-subtotal">
                  <PrintAmount value={receipt.subtotalAmount} />
                </span>
              </div>
              <div>
                <span className="print-sheet-label">{t("saleDiscount")}</span>
                <span data-testid="receipt-discount">
                  <PrintAmount value={receipt.discountAmount > 0 ? -receipt.discountAmount : 0} />
                </span>
              </div>
              <div className="print-sheet-grand">
                <span>{t("invoiceTotal")}</span>
                <span data-testid="receipt-total">
                  <PrintAmount value={receipt.totalAmount} />
                </span>
              </div>
              <div>
                <span className="print-sheet-label">{t("invoicePaid")}</span>
                <span data-testid="receipt-paid">
                  <PrintAmount value={receipt.paidAmount} />
                </span>
              </div>
              <div>
                <span className="print-sheet-label">{t("invoiceRemaining")}</span>
                <span data-testid="receipt-remaining">
                  <PrintAmount value={receipt.remainingAmount} />
                </span>
              </div>
            </div>
          ) : (
            page.carryOut !== null && (
              <div className="print-sheet-totals">
                <div className="print-sheet-grand" data-testid="receipt-carried-total">
                  <span>{t("invoicePrintCarriedTotal")}</span>
                  <span>
                    <PrintAmount value={page.carryOut} />
                  </span>
                </div>
              </div>
            )
          )}

          {(page.closes || page.payments.length > 0) && (
            <ReceiptPayments payments={page.payments} empty={page.closes && receipt.payments.length === 0} />
          )}
        </PrintSheet>
      ))}
    </div>
  );
}

/** The payment history section (decision A: the printed invoice carries it). */
function ReceiptPayments({ payments, empty }: { payments: ReceiptPayment[]; empty: boolean }) {
  const { t } = useTranslation();

  return (
    <section className="print-sheet-payments" data-testid="receipt-payments">
      <h2>{t("pmtTitle")}</h2>
      {empty ? (
        <p className="print-sheet-payments-empty" data-testid="receipt-payments-empty">
          {t("pmtEmpty")}
        </p>
      ) : (
        <table className="print-sheet-payments">
          <thead>
            <tr>
              <th style={{ width: "24%" }}>{t("pmtDate")}</th>
              <th style={{ width: "20%" }}>{t("pmtAmount")}</th>
              <th style={{ width: "18%" }}>{t("pmtMethod")}</th>
              <th>{t("pmtNote")}</th>
            </tr>
          </thead>
          <tbody>
            {payments.map((payment, index) => (
              <tr key={`${payment.paidAt}-${index}`} data-testid="receipt-payment">
                <td dir="ltr" className="print-sheet-n">
                  {formatPrintDateTime(payment.paidAt)}
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
      )}
    </section>
  );
}
