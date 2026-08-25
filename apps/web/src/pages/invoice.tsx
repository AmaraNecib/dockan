import { Link, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { InvoiceDetail, PaymentMethod } from "@dokan/contracts";

import { InvoiceHeader } from "@/components/invoice-header";

import { tError } from "../lib/i18n";
import { orpc } from "../lib/rpc";

/**
 * Ticket 8 — invoice detail (/invoices/$invoiceId). Shows the header, the
 * totals that matter for settling (total / paid / remaining), the FULL
 * payment history, and a record-payment form that enforces the money
 * boundary client-side exactly like the api: any instalment above the
 * remaining amount is refused before it is sent.
 */

/** Pure boundary check shared with the unit tests (mirrors overrideInputInvalid).
 * Returns the reason a later payment must be rejected, or null when valid.
 * Client-side mirror of the api guard: digits only (no "1e3"/"0x10" forms),
 * a whole DA integer, within the safe-integer range, at most the remaining. */
export function paymentAmountError(amount: string, remaining: number): "INVALID" | "EXCEEDS" | null {
  const trimmed = amount.trim();
  if (!/^\d+$/u.test(trimmed)) return "INVALID";
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value <= 0) return "INVALID";
  if (value > remaining) return "EXCEEDS";
  return null;
}

/**
 * Router-free payment panel (same shape as purchase's LinkProposalPanel):
 * full history + record-payment form, unit-testable without a router.
 */
export function PaymentPanel({ invoice }: { invoice: InvoiceDetail }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("CASH");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [recorded, setRecorded] = useState(false);

  const pay = useMutation(
    orpc.invoicesPay.mutationOptions({
      onSuccess: () => {
        setAmount("");
        setNote("");
        setError(null);
        setRecorded(true);
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.invoicesGet.queryKey({ input: { id: invoice.id } }) }),
          queryClient.invalidateQueries({ queryKey: orpc.invoicesList.queryKey({ input: {} }) }),
          queryClient.invalidateQueries({ queryKey: orpc.activitiesList.queryKey({ input: {} }) }),
        ]);
      },
      onError: (err) => {
        setRecorded(false);
        // a stale tab can still reach the api: the server re-checks the
        // boundary inside the transaction and returns the exact key
        setError(tError(err.message));
      },
    }),
  );

  const remaining = invoice.remainingAmount;
  const remainingMessage = paymentAmountError(amount, remaining);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setRecorded(false);
    if (remainingMessage !== null) {
      // same boundary as the api: an instalment never exceeds what is owed
      setError(remainingMessage === "EXCEEDS" ? t("pmtExceedsRemaining", { remaining }) : t("pmtInvalidAmount"));
      return;
    }
    void pay.mutate({
      invoiceId: invoice.id,
      amount: Number(amount),
      method,
      note: note.trim() === "" ? undefined : note.trim(),
    });
  }

  return (
    <div className="rounded border bg-white p-4" data-testid="pmt-panel">
      <h2 className="font-semibold">{t("pmtTitle")}</h2>
      {invoice.payments.length === 0 ? (
        <p className="mt-2 text-sm text-stone-500" data-testid="pmt-empty">{t("pmtEmpty")}</p>
      ) : (
        <table className="mt-2 w-full text-sm" data-testid="pmt-history">
          <thead>
            <tr className="border-b text-right text-stone-500">
              <th className="p-2">{t("pmtDate")}</th>
              <th className="p-2">{t("pmtAmount")}</th>
              <th className="p-2">{t("pmtMethod")}</th>
              <th className="p-2">{t("pmtNote")}</th>
            </tr>
          </thead>
          <tbody>
            {invoice.payments.map((payment) => (
              <tr key={payment.id} className="border-b last:border-0" data-testid="pmt-row">
                <td className="p-2" dir="ltr">{payment.paidAt}</td>
                <td className="p-2 font-medium">{payment.amount} دج</td>
                <td className="p-2">{t(`pmtMethod_${payment.method}`)}</td>
                <td className="p-2 text-stone-500">{payment.note ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form className="mt-4 grid gap-3" onSubmit={submit} data-testid="pmt-form">
        <div className="grid grid-cols-3 gap-3">
          <label className="grid gap-1 text-sm">
            {t("pmtAmountLabel")}
            <input
              className="rounded border px-3 py-2"
              inputMode="numeric"
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
                setRecorded(false);
              }}
              disabled={remaining === 0}
              data-testid="pmt-amount"
            />
          </label>
          <label className="grid gap-1 text-sm">
            {t("pmtMethod")}
            <select
              className="rounded border px-3 py-2"
              value={method}
              onChange={(event) => {
                // SAFETY: the select renders only the CASH / BANK options, so the target value is a PaymentMethod
                setMethod(event.target.value as PaymentMethod);
                setRecorded(false);
              }}
              disabled={remaining === 0}
              data-testid="pmt-method"
            >
              <option value="CASH">{t("pmtMethod_CASH")}</option>
              <option value="BANK">{t("pmtMethod_BANK")}</option>
            </select>
          </label>
          <label className="grid gap-1 text-sm">
            {t("pmtNoteLabel")}
            <input
              className="rounded border px-3 py-2"
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
                setRecorded(false);
              }}
              disabled={remaining === 0}
              data-testid="pmt-note"
            />
          </label>
        </div>
        {remaining === 0 ? (
          <p className="text-sm text-green-700" data-testid="pmt-unavailable">{t("pmtUnavailable")}</p>
        ) : (
          <button
            type="submit"
            className="rounded-lg bg-stone-900 py-2 text-white disabled:opacity-50"
            disabled={pay.isPending}
            data-testid="pmt-submit"
          >
            {t("pmtRecord")}
          </button>
        )}
        {error && <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700" data-testid="pmt-error">{error}</p>}
        {recorded && <p role="status" className="text-sm text-green-700" data-testid="pmt-done">{t("pmtRecorded")}</p>}
      </form>
    </div>
  );
}

export function InvoicePage() {
  const { t } = useTranslation();
  const { invoiceId } = useParams({ from: "/invoices/$invoiceId" });

  const detail = useQuery(orpc.invoicesGet.queryOptions({ input: { id: invoiceId } }));

  if (detail.isPending) {
    return <p className="text-sm text-stone-500">{t("activityError")}</p>;
  }
  if (detail.isError || detail.data === undefined) {
    const detailError = detail.error instanceof Error ? detail.error.message : undefined;
    return (
      <section className="grid gap-4" data-testid="invoice-error">
        <h1 className="text-xl font-bold">{t("invoiceTitle")}</h1>
        <p role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700" data-testid="invoice-error-text">{tError(detailError)}</p>
        <Link to="/invoices" className="text-sm underline">{t("invoiceBack")}</Link>
      </section>
    );
  }

  const invoice = detail.data;
  const remaining = invoice.remainingAmount;

  return (
    <section className="grid gap-4" data-testid="invoice-page">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">{t("invoiceTitle")} {invoice.invoiceNumber}</h1>
        <Link to="/invoices" className="rounded-lg border px-3 py-1 text-sm hover:bg-stone-100" data-testid="invoice-back">{t("invoiceBack")}</Link>
      </div>

      <div className="rounded border bg-white p-4">
        <InvoiceHeader />
        <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
          <div className="flex justify-between border-b py-1"><dt className="text-stone-500">{t("invoiceNumber")}</dt><dd data-testid="invoice-number">{invoice.invoiceNumber}</dd></div>
          <div className="flex justify-between border-b py-1"><dt className="text-stone-500">{t("invoiceKind")}</dt><dd data-testid="invoice-kind">{t(`invoiceKind_${invoice.kind}`)}</dd></div>
          <div className="flex justify-between border-b py-1"><dt className="text-stone-500">{t("invoiceParty")}</dt><dd data-testid="invoice-party">{invoice.counterpartyName ?? "—"}</dd></div>
          <div className="flex justify-between border-b py-1"><dt className="text-stone-500">{t("invoiceDate")}</dt><dd dir="ltr" data-testid="invoice-date">{invoice.invoiceDate}</dd></div>
          <div className="flex justify-between py-1 font-semibold"><dt>{t("invoiceTotal")}</dt><dd data-testid="invoice-total">{invoice.totalAmount} دج</dd></div>
          <div className="flex justify-between py-1 font-semibold"><dt>{t("invoicePaid")}</dt><dd data-testid="invoice-paid">{invoice.paidAmount} دج</dd></div>
          <div className="flex justify-between py-1 text-lg font-bold"><dt>{t("invoiceRemaining")}</dt><dd data-testid="invoice-remaining">{remaining} دج</dd></div>
        </dl>

        {invoice.lines.length > 0 && (
          <>
            <h2 className="mt-4 font-semibold">{t("invoiceLinesTitle")}</h2>
            <table className="mt-2 w-full text-sm">
              <thead>
                <tr className="border-b text-right text-stone-500">
                  <th className="p-2">{t("itemsName")}</th>
                  <th className="p-2">{t("saleQuantity")}</th>
                  <th className="p-2">{t("saleActualPrice")}</th>
                  <th className="p-2">{t("saleLineTotal")}</th>
                </tr>
              </thead>
              <tbody>
                {invoice.lines.map((line) => (
                  <tr key={line.id} className="border-b last:border-0">
                    <td className="p-2">{line.description}</td>
                    <td className="p-2">{line.quantity}</td>
                    <td className="p-2">{line.unitPrice} دج</td>
                    <td className="p-2">{line.netTotal} دج</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      <PaymentPanel invoice={invoice} />
    </section>
  );
}
