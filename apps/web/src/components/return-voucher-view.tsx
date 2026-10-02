import { useTranslation } from "react-i18next";

import { formatDate } from "../lib/dates";
import { debtOffsetDisplay, paginateReturnVoucher, type ReturnVoucher } from "../lib/return-voucher";
import { PrintItemTable, PrintSheet, PrintTotals } from "./print-sheet";

/**
 * Return voucher printing — the print-only A4 voucher sheets (mirror of
 * ReceiptView for the returns route). It shares the settled sheet frame from
 * `PrintSheet`, so it too loses the browser's URL/date header and carries the
 * store header and a foot. A return can carry up to 200 lines, so the lines
 * paginate: the full header repeats on every sheet, the table continues, and
 * the totals close the last sheet. Presentational: data arrives as a fully
 * assembled `ReturnVoucher` (see lib/return-voucher.ts), so this view is
 * deterministic to render and needs no queries.
 */
export function ReturnVoucherView({ voucher }: { voucher: ReturnVoucher }) {
  const { t } = useTranslation();
  const debt = debtOffsetDisplay(voucher.status, voucher.debtOffset, voucher.debtApplied);
  const pages = paginateReturnVoucher(voucher);

  return (
    <div dir="rtl" className="print-doc" data-testid="return-voucher-view">
      {pages.map((page) => (
        <PrintSheet
          key={page.number}
          testIdPrefix="return-voucher"
          storeName={voucher.storeName}
          storePhone={voucher.storePhone}
          storeAddress={voucher.storeAddress}
          pageNumber={page.number}
          pageCount={pages.length}
          documentRef={voucher.returnNumber}
        >
          <dl className="print-sheet-meta print-sheet-meta-list">
            <div>
              <dt>{t("returnNumber")}</dt>
              <dd dir="ltr" className="print-sheet-ltr" data-testid="return-voucher-number">
                {voucher.returnNumber}
              </dd>
            </div>
            <div>
              <dt>{t("returnVoucherInvoice")}</dt>
              <dd dir="ltr" className="print-sheet-ltr" data-testid="return-voucher-invoice">
                {voucher.invoiceNumber}
              </dd>
            </div>
            <div>
              <dt>{t("invoiceDate")}</dt>
              <dd className="print-sheet-digits" data-testid="return-voucher-date">
                {formatDate(voucher.invoiceDate)}
              </dd>
            </div>
            <div className="print-sheet-meta-wrap">
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
              <div className="print-sheet-meta-wide">
                <dt>{t("returnsReason")}</dt>
                <dd data-testid="return-voucher-reason">{voucher.reason}</dd>
              </div>
            )}
          </dl>

          {page.lines.length > 0 && (
            <PrintItemTable
              title={page.number === 1 ? t("returnVoucherLines") : undefined}
              tableTestId="return-voucher-lines"
              rowTestId="return-voucher-line"
              unitPriceLabel={t("returnsRefundUnit")}
              lineTotalLabel={t("returnsRefund")}
              lines={page.lines}
              unitPrice={(line) => line.refundUnitPrice}
              lineTotal={(line) => line.refundAmount}
            />
          )}

          {page.closes && (
            <PrintTotals
              rows={[
                { label: t("returnsRefundTotal"), amount: voucher.refundAmount, grand: true, valueTestId: "return-voucher-total" },
                { label: t("returnsCashNow"), amount: voucher.cashPaidOut, valueTestId: "return-voucher-cash" },
                { label: t(debt.labelKey), amount: debt.value, valueTestId: "return-voucher-debt" },
              ]}
            />
          )}
        </PrintSheet>
      ))}
    </div>
  );
}
