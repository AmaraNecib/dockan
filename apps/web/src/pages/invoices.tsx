import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { InvoiceKind } from "@dokan/contracts";

import { orpc } from "../lib/rpc";
import { formatDate } from "../lib/dates";
import { focusByTestId } from "../lib/focus";
import { usePagination } from "../hooks/use-pagination";
import { Amount } from "@/components/ui/amount";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Pager } from "@/components/ui/pager";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";

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
  // Which filter the owner last CHANGED. After clearing, focus must go to the control
  // that narrowed the list, and "whichever value is non-empty" cannot answer that: with
  // both set, focusing `kind` sends a keyboard user to a control that did not empty the
  // view (review on #245).
  const lastFilterRef = useRef<"kind" | "status" | null>(null);
  const pager = usePagination();

  const list = useQuery(
    orpc.invoicesList.queryOptions({
      input: {
        kind: kind === "" ? undefined : kind,
        status: status === "" ? undefined : status,
        ...pager.pagination,
      },
    }),
  );

  return (
    <section data-testid="invoices-page">
      <h1 className="text-xl font-bold">{t("invoicesTitle")}</h1>

      <div className="mt-4 grid grid-cols-2 gap-3">
        <label className="grid gap-1 text-sm">
          {t("invoiceKind")}
          <Select
            value={kind}
            onValueChange={(value) => {
              // SAFETY: the select renders only "" / SALE / PURCHASE options, so the value is in KindFilter
              setKind((value ?? "") as KindFilter);
              lastFilterRef.current = "kind";
              // a filter change invalidates the old offset: back to page 1
              pager.reset();
            }}
            items={[
              { value: "", label: t("invoicesFilterAll") },
              { value: "SALE", label: t("invoicesFilterSale") },
              { value: "PURCHASE", label: t("invoicesFilterPurchase") },
            ]}
          >
            <SelectTrigger className="w-full" data-testid="invoices-kind-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">{t("invoicesFilterAll")}</SelectItem>
              <SelectItem value="SALE">{t("invoicesFilterSale")}</SelectItem>
              <SelectItem value="PURCHASE">{t("invoicesFilterPurchase")}</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label className="grid gap-1 text-sm">
          {t("invoicesStatusFilter")}
          <Select
            value={status}
            onValueChange={(value) => {
              // SAFETY: the select renders only "" / UNPAID / PARTIAL / PAID options, so the value is in StatusFilter
              setStatus((value ?? "") as StatusFilter);
              lastFilterRef.current = "status";
              pager.reset();
            }}
            items={[
              { value: "", label: t("invoicesStatusAll") },
              { value: "UNPAID", label: t("invoicesStatusUnpaid") },
              { value: "PARTIAL", label: t("invoicesStatusPartial") },
              { value: "PAID", label: t("invoicesStatusPaid") },
            ]}
          >
            <SelectTrigger className="w-full" data-testid="invoices-status-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="">{t("invoicesStatusAll")}</SelectItem>
              <SelectItem value="UNPAID">{t("invoicesStatusUnpaid")}</SelectItem>
              <SelectItem value="PARTIAL">{t("invoicesStatusPartial")}</SelectItem>
              <SelectItem value="PAID">{t("invoicesStatusPaid")}</SelectItem>
            </SelectContent>
          </Select>
        </label>
      </div>

      {list.isPending ? (
        <div className="mt-4 grid gap-2">
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
        </div>
      ) : list.isError ? (
        <p role="alert" className="mt-4 rounded border border-destructive/20 bg-destructive/10 p-2 text-sm text-destructive" data-testid="invoices-error">
          {t("activityError")}
        </p>
      ) : list.data.total === 0 ? (
        <EmptyState
          testId="invoices-empty"
          card
          className="mt-4"
          title={t("invoicesEmpty")}
          hint={t(kind === "" && status === "" ? "invoicesEmptyHint" : "invoicesEmptyFilteredHint")}
          action={
            kind === "" && status === "" ? (
              <div className="flex flex-wrap items-center justify-center gap-2">
                <Button asChild size="lg">
                  <Link to="/sale" data-testid="invoices-empty-action">{t("saleNew")}</Link>
                </Button>
                <Button asChild size="lg" variant="outline">
                  <Link to="/purchase" data-testid="invoices-empty-action-purchase">{t("purchasesNew")}</Link>
                </Button>
              </div>
            ) : (
              <Button
                size="lg"
                variant="outline"
                data-testid="invoices-empty-action"
                onClick={() => {
                  // the clicked button is replaced by the table; keep focus on the
                  // filter the owner last changed (issue #96, review on #245).
                  // Order: last-changed, else whichever filter is set, else kind -- so
                  // focus is never simply dropped.
                  const last = lastFilterRef.current;
                  const target =
                    last ?? (kind !== "" ? "kind" : status !== "" ? "status" : "kind");
                  const filter =
                    target === "status" ? "invoices-status-filter" : "invoices-kind-filter";
                  setKind("");
                  setStatus("");
                  pager.reset();
                  focusByTestId(filter);
                }}
              >
                {t("invoicesEmptyClearFilters")}
              </Button>
            )
          }
        />
      ) : (
        <>
        <table className="mt-4 w-full" data-testid="invoices-table">
          <thead>
            <tr className="border-b text-right text-sm text-muted-foreground">
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
                <td className="p-2">{formatDate(invoice.invoiceDate)}</td>
                <td className="p-2"><Amount value={invoice.totalAmount} /></td>
                <td className="p-2" data-testid={`invoice-remaining-${invoice.invoiceNumber}`}><Amount value={invoice.remainingAmount} /></td>
                <td className="p-2">
                  <Link
                    to="/invoices/$invoiceId"
                    params={{ invoiceId: invoice.id }}
                    className="rounded-lg border px-3 py-1 text-sm hover:bg-muted"
                    data-testid={`invoice-open-${invoice.invoiceNumber}`}
                  >
                    {t("invoicesOpen")}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <Pager
          total={list.data.total}
          pageSize={pager.pageSize}
          offset={pager.offset}
          onOffsetChange={pager.setOffset}
          onPageSizeChange={pager.setPageSize}
          testId="invoices-pager"
        />
        </>
      )}
    </section>
  );
}
