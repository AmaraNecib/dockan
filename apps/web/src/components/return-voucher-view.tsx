import { useTranslation } from "react-i18next";

import { debtOffsetDisplay, type ReturnVoucher } from "../lib/return-voucher";

/**
 * Return voucher printing — the print-only voucher layout (mirror of
 * ReceiptView for the returns route). Presentational: data arrives as a fully
 * assembled `ReturnVoucher` (see lib/return-voucher.ts), so this view is
 * deterministic to render and needs no queries. RTL by default (the app is
 * Arabic); dates, the phone and the document numbers stay left-to-right spans
 * exactly like the invoice detail screen.
 */
export function ReturnVoucherView({ voucher }: { voucher: ReturnVoucher }) {
  const { t } = useTranslation();
  const debt = debtOffsetDisplay(voucher.status, voucher.debtOffset, voucher.debtApplied);

  return (
    <article dir="rtl" className="rounded border bg-white p-6" data-testid="return-voucher-view">
      <header className="border-b border-stone-300 pb-3 text-center">
        <h1 className="text-xl font-bold" data-testid="return-voucher-store">{voucher.storeName}</h1>
        {voucher.storePhone && (
          <p dir="ltr" className="mt-1 text-sm text-stone-500" data-testid="return-voucher-phone">
            {voucher.storePhone}
          </p>
        )}
        <p className="mt-1 text-sm font-semibold">{t("returnVoucherTitle")}</p>
      </header>

      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
        <div className="flex justify-between border-b py-1">
          <dt className="text-stone-500">{t("returnNumber")}</dt>
          <dd dir="ltr" data-testid="return-voucher-number">{voucher.returnNumber}</dd>
        </div>
        <div className="flex justify-between border-b py-1">
          <dt className="text-stone-500">{t("returnVoucherInvoice")}</dt>
          <dd dir="ltr" data-testid="return-voucher-invoice">{voucher.invoiceNumber}</dd>
        </div>
        <div className="flex justify-between border-b py-1">
          <dt className="text-stone-500">{t("invoiceDate")}</dt>
          <dd dir="ltr" data-testid="return-voucher-date">{voucher.invoiceDate}</dd>
        </div>
        <div className="flex justify-between border-b py-1">
          <dt className="text-stone-500">{t("invoiceParty")}</dt>
          <dd data-testid="return-voucher-party">{voucher.counterpartyName ?? "—"}</dd>
        </div>
        <div className="flex justify-between border-b py-1">
          <dt className="text-stone-500">{t("returnsPayoutMethod")}</dt>
          <dd data-testid="return-voucher-method">{t(`pmtMethod_${voucher.payoutMethod}`)}</dd>
        </div>
        <div className="flex justify-between border-b py-1">
          <dt className="text-stone-500">{t("returnsStatus")}</dt>
          <dd data-testid="return-voucher-status">{t(`returnsStatus_${voucher.status}`)}</dd>
        </div>
        {voucher.reason && (
          <div className="flex justify-between border-b py-1 col-span-2">
            <dt className="text-stone-500">{t("returnsReason")}</dt>
            <dd data-testid="return-voucher-reason">{voucher.reason}</dd>
          </div>
        )}
      </dl>

      {voucher.lines.length > 0 && (
        <>
          <h2 className="mt-4 font-semibold">{t("returnVoucherLines")}</h2>
          <table className="mt-2 w-full text-sm" data-testid="return-voucher-lines">
            <thead>
              <tr className="border-b text-right text-stone-500">
                <th className="p-1">{t("itemsName")}</th>
                <th className="p-1">{t("saleQuantity")}</th>
                <th className="p-1">{t("returnsRefundUnit")}</th>
                <th className="p-1">{t("returnsRefund")}</th>
              </tr>
            </thead>
            <tbody>
              {voucher.lines.map((line, index) => (
                <tr key={`${line.description}-${index}`} className="border-b last:border-0" data-testid="return-voucher-line">
                  <td className="p-1">{line.description}</td>
                  <td className="p-1">{line.quantity}</td>
                  <td className="p-1">{line.refundUnitPrice} {t("dzd")}</td>
                  <td className="p-1">{line.refundAmount} {t("dzd")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
        <div className="flex justify-between border-b py-1 text-base font-bold">
          <dt>{t("returnsRefundTotal")}</dt>
          <dd data-testid="return-voucher-total">{voucher.refundAmount} {t("dzd")}</dd>
        </div>
        <div className="flex justify-between border-b py-1">
          <dt>{t("returnsCashNow")}</dt>
          <dd data-testid="return-voucher-cash">{voucher.cashPaidOut} {t("dzd")}</dd>
        </div>
        <div className="flex justify-between border-b py-1">
          <dt>{t(debt.labelKey)}</dt>
          <dd data-testid="return-voucher-debt">{debt.value} {t("dzd")}</dd>
        </div>
      </dl>
    </article>
  );
}
