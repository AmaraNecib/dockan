import { useTranslation } from "react-i18next";

import { formatDate } from "../lib/dates";
import { debtOffsetDisplay, type ReturnVoucher } from "../lib/return-voucher";
import { PrintItemTable, PrintSheet, PrintTotals } from "./print-sheet";

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
            <div className="print-sheet-meta-wide">
              <dt>{t("returnsReason")}</dt>
              <dd data-testid="return-voucher-reason">{voucher.reason}</dd>
            </div>
          )}
        </dl>

        {voucher.lines.length > 0 && (
          <PrintItemTable
            title={t("returnVoucherLines")}
            tableTestId="return-voucher-lines"
            rowTestId="return-voucher-line"
            unitPriceLabel={t("returnsRefundUnit")}
            lineTotalLabel={t("returnsRefund")}
            lines={voucher.lines}
            unitPrice={(line) => line.refundUnitPrice}
            lineTotal={(line) => line.refundAmount}
          />
        )}

        <PrintTotals
          rows={[
            { label: t("returnsRefundTotal"), amount: voucher.refundAmount, grand: true, testId: "return-voucher-total" },
            { label: t("returnsCashNow"), amount: voucher.cashPaidOut, testId: "return-voucher-cash" },
            { label: t(debt.labelKey), amount: debt.value, testId: "return-voucher-debt" },
          ]}
        />
      </PrintSheet>
    </div>
  );
}
