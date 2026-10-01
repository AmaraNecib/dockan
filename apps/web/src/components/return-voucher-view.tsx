import { useTranslation } from "react-i18next";

import { formatPrintDateTime } from "../lib/print-format";
import { debtOffsetDisplay, type ReturnVoucher } from "../lib/return-voucher";
import { PrintAmount, PrintSheet } from "./print-sheet";

/**
 * Return voucher printing — the print-only A4 voucher sheet (mirror of
 * ReceiptView for the returns route). It shares the settled sheet frame from
 * `PrintSheet`, so it too loses the browser's URL/date header and carries the
 * store header and a foot. Presentational: data arrives as a fully assembled
 * `ReturnVoucher` (see lib/return-voucher.ts), so this view is deterministic to
 * render and needs no queries.
 */
export function ReturnVoucherView({ voucher }: { voucher: ReturnVoucher }) {
  const { t } = useTranslation();
  const debt = debtOffsetDisplay(voucher.status, voucher.debtOffset, voucher.debtApplied);

  return (
    <div dir="rtl" className="print-doc" data-testid="return-voucher-view">
      <PrintSheet
        testIdPrefix="return-voucher"
        storeName={voucher.storeName}
        storePhone={voucher.storePhone}
        storeAddress={voucher.storeAddress}
        pageNumber={1}
        pageCount={1}
        documentRef={voucher.returnNumber}
      >
        <dl className="print-sheet-meta print-sheet-meta-list">
          <div>
            <dt>{t("returnNumber")}</dt>
            <dd dir="ltr" className="print-sheet-n" data-testid="return-voucher-number">
              {voucher.returnNumber}
            </dd>
          </div>
          <div>
            <dt>{t("returnVoucherInvoice")}</dt>
            <dd dir="ltr" className="print-sheet-n" data-testid="return-voucher-invoice">
              {voucher.invoiceNumber}
            </dd>
          </div>
          <div>
            <dt>{t("invoiceDate")}</dt>
            <dd dir="ltr" className="print-sheet-n" data-testid="return-voucher-date">
              {formatPrintDateTime(voucher.invoiceDate)}
            </dd>
          </div>
          <div>
            <dt>{t("invoiceParty")}</dt>
            <dd data-testid="return-voucher-party">{voucher.counterpartyName ?? "—"}</dd>
          </div>
          <div>
            <dt>{t("returnsPayoutMethod")}</dt>
            <dd data-testid="return-voucher-method">{t(`pmtMethod_${voucher.payoutMethod}`)}</dd>
          </div>
          <div>
            <dt>{t("returnsStatus")}</dt>
            <dd data-testid="return-voucher-status">{t(`returnsStatus_${voucher.status}`)}</dd>
          </div>
          {voucher.reason && (
            <div style={{ gridColumn: "1 / -1" }}>
              <dt>{t("returnsReason")}</dt>
              <dd data-testid="return-voucher-reason">{voucher.reason}</dd>
            </div>
          )}
        </dl>

        {voucher.lines.length > 0 && (
          <table className="print-sheet-items" data-testid="return-voucher-lines">
            <caption className="print-sheet-items-title">{t("returnVoucherLines")}</caption>
            <thead>
              <tr>
                <th scope="col" style={{ width: "42%" }}>
                  {t("itemsName")}
                </th>
                <th scope="col" style={{ width: "12%" }}>
                  {t("saleQuantity")}
                </th>
                <th scope="col" style={{ width: "23%" }}>
                  {t("returnsRefundUnit")}
                </th>
                <th scope="col" style={{ width: "23%" }}>
                  {t("returnsRefund")}
                </th>
              </tr>
            </thead>
            <tbody>
              {voucher.lines.map((line, index) => (
                <tr key={`${line.description}-${index}`} data-testid="return-voucher-line">
                  <td>{line.description}</td>
                  <td dir="ltr" className="print-sheet-n">
                    {line.quantity}
                  </td>
                  <td className="print-sheet-num">
                    <PrintAmount value={line.refundUnitPrice} />
                  </td>
                  <td className="print-sheet-num">
                    <PrintAmount value={line.refundAmount} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div className="print-sheet-totals">
          <div className="print-sheet-grand">
            <span>{t("returnsRefundTotal")}</span>
            <span data-testid="return-voucher-total">
              <PrintAmount value={voucher.refundAmount} />
            </span>
          </div>
          <div>
            <span className="print-sheet-label">{t("returnsCashNow")}</span>
            <span data-testid="return-voucher-cash">
              <PrintAmount value={voucher.cashPaidOut} />
            </span>
          </div>
          <div>
            <span className="print-sheet-label">{t(debt.labelKey)}</span>
            <span data-testid="return-voucher-debt">
              <PrintAmount value={debt.value} />
            </span>
          </div>
        </div>
      </PrintSheet>
    </div>
  );
}
