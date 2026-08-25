import { useTranslation } from "react-i18next";

import type { Receipt } from "../lib/receipt";

/**
 * Receipt printing — the print-only receipt layout. Presentational: data arrives as
 * a fully assembled `Receipt` (see lib/receipt.ts), so this view is
 * deterministic to render and needs no queries. RTL by default (the app is
 * Arabic); dates, the phone and the invoice number stay left-to-right spans
 * exactly like the invoice detail screen. When printed, only this document
 * should reach the paper — the surrounding app chrome carries
 * `print-hidden` (see index.css @media print).
 */
export function ReceiptView({ receipt }: { receipt: Receipt }) {
  const { t } = useTranslation();

  return (
    <article dir="rtl" className="rounded border bg-white p-6" data-testid="receipt-view">
      <header className="border-b border-stone-300 pb-3 text-center">
        <h1 className="text-xl font-bold" data-testid="receipt-store">{receipt.storeName}</h1>
        {receipt.storePhone && (
          <p dir="ltr" className="mt-1 text-sm text-stone-500" data-testid="receipt-phone">
            {receipt.storePhone}
          </p>
        )}
        <p className="mt-1 text-sm text-stone-500">{t("invoiceKind")}: {t(`invoiceKind_${receipt.kind}`)}</p>
      </header>

      <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
        <div className="flex justify-between border-b py-1">
          <dt className="text-stone-500">{t("invoiceNumber")}</dt>
          <dd dir="ltr" data-testid="receipt-number">{receipt.invoiceNumber}</dd>
        </div>
        <div className="flex justify-between border-b py-1">
          <dt className="text-stone-500">{t("invoiceDate")}</dt>
          <dd dir="ltr" data-testid="receipt-date">{receipt.invoiceDate}</dd>
        </div>
        <div className="flex justify-between border-b py-1">
          <dt className="text-stone-500">{t("invoiceParty")}</dt>
          <dd data-testid="receipt-party">{receipt.counterpartyName ?? "—"}</dd>
        </div>
        {receipt.notes && (
          <div className="flex justify-between border-b py-1">
            <dt className="text-stone-500">{t("purchasesNotes")}</dt>
            <dd data-testid="receipt-notes">{receipt.notes}</dd>
          </div>
        )}
      </dl>

      {receipt.lines.length > 0 && (
        <>
          <h2 className="mt-4 font-semibold">{t("invoiceLinesTitle")}</h2>
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="border-b text-right text-stone-500">
                <th className="p-1">{t("itemsName")}</th>
                <th className="p-1">{t("saleQuantity")}</th>
                <th className="p-1">{t("saleActualPrice")}</th>
                <th className="p-1">{t("saleLineTotal")}</th>
              </tr>
            </thead>
            <tbody>
              {receipt.lines.map((line, index) => (
                <tr key={`${line.description}-${index}`} className="border-b last:border-0" data-testid="receipt-line">
                  <td className="p-1">{line.description}</td>
                  <td className="p-1">{line.quantity}</td>
                  <td className="p-1">{line.unitPrice} دج</td>
                  <td className="p-1">{line.netTotal} دج</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <dl className="receipt-totals mt-4 grid grid-cols-2 gap-x-6 gap-y-1 text-sm">
        <div className="flex justify-between border-b py-1">
          <dt className="text-stone-500">{t("saleSubtotal")}</dt>
          <dd data-testid="receipt-subtotal">{receipt.subtotalAmount} دج</dd>
        </div>
        <div className="flex justify-between border-b py-1">
          <dt className="text-stone-500">{t("saleDiscount")}</dt>
          <dd data-testid="receipt-discount">{receipt.discountAmount > 0 ? `-${receipt.discountAmount}` : "0"} دج</dd>
        </div>
        <div className="flex justify-between border-b py-1 font-semibold">
          <dt>{t("invoiceTotal")}</dt>
          <dd data-testid="receipt-total">{receipt.totalAmount} دج</dd>
        </div>
        <div className="flex justify-between border-b py-1 font-semibold">
          <dt>{t("invoicePaid")}</dt>
          <dd data-testid="receipt-paid">{receipt.paidAmount} دج</dd>
        </div>
        <div className="flex justify-between border-b py-1 text-base font-bold">
          <dt>{t("invoiceRemaining")}</dt>
          <dd data-testid="receipt-remaining">{receipt.remainingAmount} دج</dd>
        </div>
      </dl>

      {receipt.payments.length === 0 ? (
        <p className="mt-4 text-sm text-stone-500" data-testid="receipt-payments-empty">{t("pmtEmpty")}</p>
      ) : (
        <section className="mt-4">
          <h2 className="font-semibold">{t("pmtTitle")}</h2>
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="border-b text-right text-stone-500">
                <th className="p-1">{t("pmtDate")}</th>
                <th className="p-1">{t("pmtAmount")}</th>
                <th className="p-1">{t("pmtMethod")}</th>
                <th className="p-1">{t("pmtNote")}</th>
              </tr>
            </thead>
            <tbody>
              {receipt.payments.map((payment, index) => (
                <tr key={`${payment.paidAt}-${index}`} className="border-b last:border-0" data-testid="receipt-payment">
                  <td className="p-1" dir="ltr">{payment.paidAt}</td>
                  <td className="p-1">{payment.amount} دج</td>
                  <td className="p-1">{t(`pmtMethod_${payment.method}`)}</td>
                  <td className="p-1 text-stone-500">{payment.note ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}
    </article>
  );
}