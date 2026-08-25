import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { InvoiceKind } from "@dokan/contracts";

import { orpc } from "../lib/rpc";

type KindFilter = "" | InvoiceKind;
type StatusFilter = "" | "UNPAID" | "PARTIAL" | "PAID";

/**
 * Ticket 8 — invoice list (/invoices). Both kinds are payable in instalments,
 * so both land here; kind + payment-status filters narrow the view. Rows open
 * the detail screen where the payment history lives.
 */
export function InvoicesPage() {
  const { t } = useTranslation();
  const [kind, setKind] = useState<KindFilter>("");
  const [status, setStatus] = useState<StatusFilter>("");

  const list = useQuery(
    orpc.invoicesList.queryOptions({
      input: {
        kind: kind === "" ? undefined : kind,
        status: status === "" ? undefined : status,
      },
    }),
  );

  return (
    <section data-testid="invoices-page">
      <h1 className="text-xl font-bold">{t("invoicesTitle")}</h1>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <label className="grid gap-1 text-sm">
          {t("invoiceKind")}
          <select
            className="rounded border px-3 py-2"
            value={kind}
            onChange={(event) => {
              // SAFETY: the select renders only "" / SALE / PURCHASE options, so the target value is in KindFilter
              setKind(event.target.value as KindFilter);
            }}
            data-testid="invoices-kind-filter"
          >
            <option value="">{t("invoicesFilterAll")}</option>
            <option value="SALE">{t("invoicesFilterSale")}</option>
            <option value="PURCHASE">{t("invoicesFilterPurchase")}</option>
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          {t("invoicePaid")}
          <select
            className="rounded border px-3 py-2"
            value={status}
            onChange={(event) => {
              // SAFETY: the select renders only "" / UNPAID / PARTIAL / PAID options, so the target value is in StatusFilter
              setStatus(event.target.value as StatusFilter);
            }}
            data-testid="invoices-status-filter"
          >
            <option value="">{t("invoicesStatusAll")}</option>
            <option value="UNPAID">{t("invoicesStatusUnpaid")}</option>
            <option value="PARTIAL">{t("invoicesStatusPartial")}</option>
            <option value="PAID">{t("invoicesStatusPaid")}</option>
          </select>
        </label>
      </div>

      {list.isPending ? (
        <p className="mt-4 text-sm text-stone-500">{t("activityError")}</p>
      ) : list.isError ? (
        <p role="alert" className="mt-4 rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700" data-testid="invoices-error">
          {t("activityError")}
        </p>
      ) : list.data.items.length === 0 ? (
        <p className="mt-4 text-sm text-stone-500" data-testid="invoices-empty">{t("invoicesEmpty")}</p>
      ) : (
        <table className="mt-4 w-full" data-testid="invoices-table">
          <thead>
            <tr className="border-b text-right text-sm text-stone-500">
              <th className="p-2">{t("invoiceNumber")}</th>
              <th className="p-2">{t("invoiceKind")}</th>
              <th className="p-2">{t("invoiceParty")}</th>
              <th className="p-2">{t("invoiceDate")}</th>
              <th className="p-2">{t("invoiceTotal")}</th>
              <th className="p-2">{t("invoiceRemaining")}</th>
              <th className="p-2" />
            </tr>
          </thead>
          <tbody>
            {list.data.items.map((invoice) => (
              <tr key={invoice.id} className="border-b last:border-0" data-testid="invoice-row">
                <td className="p-2 font-medium">{invoice.invoiceNumber}</td>
                <td className="p-2">{t(`invoiceKind_${invoice.kind}`)}</td>
                <td className="p-2">{invoice.counterpartyName ?? "—"}</td>
                <td className="p-2" dir="ltr">{invoice.invoiceDate}</td>
                <td className="p-2">{invoice.totalAmount} دج</td>
                <td className="p-2" data-testid={`invoice-remaining-${invoice.invoiceNumber}`}>{invoice.remainingAmount} دج</td>
                <td className="p-2">
                  <Link
                    to="/invoices/$invoiceId"
                    params={{ invoiceId: invoice.id }}
                    className="rounded-lg border px-3 py-1 text-sm hover:bg-stone-100"
                    data-testid={`invoice-open-${invoice.invoiceNumber}`}
                  >
                    {t("invoicesOpen")}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}