import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { InvoiceKind } from "@dokan/contracts";

import { useRpc } from "../lib/rpc-context";
import { formatDate } from "../lib/dates";
import { focusByTestId } from "../lib/focus";
import { usePagination } from "../hooks/use-pagination";
import { Amount } from "@/components/ui/amount";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Pager } from "@/components/ui/pager";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";

type KindFilter = "" | InvoiceKind;
type StatusFilter = "" | "UNPAID" | "PARTIAL" | "PAID";
type InvoiceOrder = "OLDEST" | "NEWEST";

function invoiceNumberSequence(value: string): number | undefined {
  const match = /^(?:(?:INV|SUP)-)?(\d+)$/iu.exec(value.trim());
  if (match === null) return undefined;
  const sequence = Number(match[1]);
  return Number.isSafeInteger(sequence) ? sequence : undefined;
}

/**
 * Ticket 8 — invoice list (/invoices). Both kinds are payable in instalments,
 * so both land here; kind + payment-status filters narrow the view. Rows open
 * the detail screen where the payment history lives.
 */
export function InvoicesPage() {
  const { orpc } = useRpc();
  const { t } = useTranslation();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const rangeDetailsRef = useRef<HTMLDetailsElement>(null);
  const lastRangeFilterRef = useRef("invoices-from-date");
  const [kind, setKind] = useState<KindFilter>("");
  const [status, setStatus] = useState<StatusFilter>("");
  const [fromDate, setFromDate] = useState("");
  const [toDate, setToDate] = useState("");
  const [fromNumber, setFromNumber] = useState("");
  const [toNumber, setToNumber] = useState("");
  const [order, setOrder] = useState<InvoiceOrder>("NEWEST");
  const fromSequence = fromNumber.trim() === "" ? undefined : invoiceNumberSequence(fromNumber);
  const toSequence = toNumber.trim() === "" ? undefined : invoiceNumberSequence(toNumber);
  const dateRangeInvalid = fromDate !== "" && toDate !== "" && fromDate > toDate;
  const numberRangeInvalid = (fromNumber.trim() !== "" && fromSequence === undefined) || (toNumber.trim() !== "" && toSequence === undefined) ||
    (fromSequence !== undefined && toSequence !== undefined && fromSequence > toSequence);
  const rangeError = dateRangeInvalid ? t("invoicesDateRangeInvalid") : numberRangeInvalid ? t("invoicesNumberRangeInvalid") : "";
  const hasFilters = search.trim() !== "" || kind !== "" || status !== "" || fromDate !== "" || toDate !== "" || fromNumber.trim() !== "" || toNumber.trim() !== "" || order !== "NEWEST";
  // Which filter the owner last CHANGED. After clearing, focus must go to the control
  // that narrowed the list, and "whichever value is non-empty" cannot answer that: with
  // both set, focusing `kind` sends a keyboard user to a control that did not empty the
  // view (review on #245).
  const lastFilterRef = useRef<"kind" | "status" | "search" | "range" | "order" | null>(null);
  const pager = usePagination();

  useEffect(() => {
    const trimmed = search.trim();
    if (trimmed === "") {
      setDebouncedSearch("");
      pager.reset();
      return;
    }
    const timer = window.setTimeout(() => {
      setDebouncedSearch(trimmed);
      pager.reset();
    }, 150);
    return () => window.clearTimeout(timer);
  }, [search, pager.reset]);

  const list = useQuery({
    ...orpc.invoicesList.queryOptions({
      input: {
        search: debouncedSearch || undefined,
        kind: kind === "" ? undefined : kind,
        status: status === "" ? undefined : status,
        fromDate: fromDate || undefined,
        toDate: dateRangeInvalid ? undefined : toDate || undefined,
        fromNumber: fromSequence === undefined ? undefined : fromNumber.trim(),
        toNumber: toSequence === undefined ? undefined : toNumber.trim(),
        order: order === "NEWEST" ? undefined : order,
        ...pager.pagination,
      },
    }),
    enabled: rangeError === "",
    placeholderData: (previousData) => previousData,
  });

  return (
    <section data-testid="invoices-page">
      <h1 className="text-xl font-bold">{t("invoicesTitle")}</h1>

      <div className="mt-4 flex items-end gap-2">
        <label className="grid flex-1 gap-1 text-sm">
          {t("invoicesSearch")}
          <Input
            ref={searchRef}
            type="search"
            maxLength={200}
            value={search}
            data-testid="invoices-search"
            placeholder={t("invoicesSearchHint")}
            onChange={(event) => {
              setSearch(event.target.value);
              lastFilterRef.current = "search";
            }}
          />
        </label>
        {search !== "" && (
          <Button variant="outline" data-testid="invoices-search-clear" onClick={() => {
            setSearch("");
            searchRef.current?.focus();
          }}>{t("invoicesSearchClear")}</Button>
        )}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <label className="grid gap-1 text-sm">
          {t("invoiceKind")}
          <Select
            value={kind}
            onValueChange={(value) => {
              // SAFETY: the select renders only "" / SALE / PURCHASE options, so the value is in KindFilter
              setKind((value ?? "") as KindFilter);
              lastFilterRef.current = "kind";
              pager.reset();
            }}
            items={[
              { value: "", label: t("invoicesFilterAll") },
              { value: "SALE", label: t("invoicesFilterSale") },
              { value: "PURCHASE", label: t("invoicesFilterPurchase") },
            ]}
          >
            <SelectTrigger className="w-full" data-testid="invoices-kind-filter"><SelectValue /></SelectTrigger>
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
            <SelectTrigger className="w-full" data-testid="invoices-status-filter"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="">{t("invoicesStatusAll")}</SelectItem>
              <SelectItem value="UNPAID">{t("invoicesStatusUnpaid")}</SelectItem>
              <SelectItem value="PARTIAL">{t("invoicesStatusPartial")}</SelectItem>
              <SelectItem value="PAID">{t("invoicesStatusPaid")}</SelectItem>
            </SelectContent>
          </Select>
        </label>
        <label className="grid gap-1 text-sm">
          {t("invoicesOrder")}
          <Select value={order} onValueChange={(value) => {
            // SAFETY: this select exposes only the declared NEWEST/OLDEST options.
            setOrder((value ?? "NEWEST") as InvoiceOrder); lastFilterRef.current = "order"; pager.reset();
          }} items={[
            { value: "NEWEST", label: t("invoicesOrderNewest") },
            { value: "OLDEST", label: t("invoicesOrderOldest") },
          ]}>
            <SelectTrigger className="w-full" data-testid="invoices-order-filter"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="NEWEST">{t("invoicesOrderNewest")}</SelectItem><SelectItem value="OLDEST">{t("invoicesOrderOldest")}</SelectItem></SelectContent>
          </Select>
        </label>
        {hasFilters && <Button className="col-span-2 justify-self-start sm:col-span-3 sm:justify-self-end" variant="outline" data-testid="invoices-filters-clear" onClick={() => {
          setSearch(""); setDebouncedSearch(""); setKind(""); setStatus(""); setFromDate(""); setToDate(""); setFromNumber(""); setToNumber(""); setOrder("NEWEST"); pager.reset(); searchRef.current?.focus();
        }}>{t("invoicesFiltersClear")}</Button>}
      </div>

      <details ref={rangeDetailsRef} className="mt-3 border-t pt-2" data-testid="invoices-range-details">
        <summary className="w-fit cursor-pointer py-1 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring" data-testid="invoices-range-filters-toggle">{t("invoicesRangeFilters")}</summary>
        <div className="mt-3 grid grid-cols-2 gap-3">
          <label className="grid gap-1 text-sm">
            {t("invoicesFromDate")}
            <Input type="date" value={fromDate} data-testid="invoices-from-date" aria-invalid={dateRangeInvalid} onChange={(event) => { setFromDate(event.target.value); lastFilterRef.current = "range"; lastRangeFilterRef.current = "invoices-from-date"; pager.reset(); }} />
          </label>
          <label className="grid gap-1 text-sm">
            {t("invoicesToDate")}
            <Input type="date" value={toDate} data-testid="invoices-to-date" aria-invalid={dateRangeInvalid} onChange={(event) => { setToDate(event.target.value); lastFilterRef.current = "range"; lastRangeFilterRef.current = "invoices-to-date"; pager.reset(); }} />
          </label>
          <label className="grid gap-1 text-sm">
            {t("invoicesFromNumber")}
            <Input value={fromNumber} inputMode="text" data-testid="invoices-from-number" aria-invalid={numberRangeInvalid} onChange={(event) => { setFromNumber(event.target.value); lastFilterRef.current = "range"; lastRangeFilterRef.current = "invoices-from-number"; pager.reset(); }} />
          </label>
          <label className="grid gap-1 text-sm">
            {t("invoicesToNumber")}
            <Input value={toNumber} inputMode="text" data-testid="invoices-to-number" aria-invalid={numberRangeInvalid} onChange={(event) => { setToNumber(event.target.value); lastFilterRef.current = "range"; lastRangeFilterRef.current = "invoices-to-number"; pager.reset(); }} />
          </label>
          <p className="col-span-2 text-xs text-muted-foreground">{t("invoicesNumberRangeHint")}</p>
          {rangeError !== "" && <p className="col-span-2 text-sm text-destructive" role="alert" data-testid="invoices-range-error">{rangeError}</p>}
        </div>
      </details>

      {list.isFetching && !list.isPending && (
        <p className="mt-4 text-sm text-muted-foreground" role="status" aria-label={t("invoicesLoading")}>
          {t("invoicesLoading")}
        </p>
      )}
      {rangeError !== "" ? null : list.isPending ? (
        <div className="mt-4 grid gap-2" aria-hidden="true">
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
        </div>
      ) : list.isError ? (
        <div className="mt-4 rounded border border-destructive/20 bg-destructive/10 p-2 text-sm text-destructive" data-testid="invoices-error">
          <p role="alert">{t("activityError")}</p>
          <Button variant="outline" data-testid="invoices-retry" onClick={() => { void list.refetch(); }}>{t("itemsSearchRetry")}</Button>
        </div>
      ) : list.data.total === 0 ? (
        <EmptyState
          testId="invoices-empty"
          card
          className="mt-4"
          title={t("invoicesEmpty")}
          hint={t(!hasFilters ? "invoicesEmptyHint" : "invoicesEmptyFilteredHint")}
          action={
            !hasFilters ? (
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
                  const filter = target === "search"
                    ? "invoices-search"
                    : target === "status"
                      ? "invoices-status-filter"
                      : target === "order"
                        ? "invoices-order-filter"
                        : target === "range"
                          ? lastRangeFilterRef.current
                          : "invoices-kind-filter";
                  setSearch("");
                  setDebouncedSearch("");
                  setKind("");
                  setStatus("");
                  setFromDate("");
                  setToDate("");
                  setFromNumber("");
                  setToNumber("");
                  setOrder("NEWEST");
                  pager.reset();
                  if (target === "range" && rangeDetailsRef.current !== null) {
                    rangeDetailsRef.current.open = true;
                  }
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
