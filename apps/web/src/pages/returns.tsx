import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { ReturnDetail, SupplierReturnRecord } from "@dokan/contracts";

import { debtOffsetDisplay } from "../lib/return-voucher";
import { tError } from "../lib/i18n";
import { usePagination } from "../hooks/use-pagination";
import { cn } from "@/lib/utils";
import { inputClass } from "@/components/ui/input";
import { Amount } from "@/components/ui/amount";
import { Pager } from "@/components/ui/pager";
import { EmptyState } from "@/components/ui/empty-state";
import { orpc } from "../lib/rpc";

/**
 * Returns review (/returns). Every recorded return, pending first: the owner
 * accepts (the pending stock mark is consumed — the goods stay salable) or
 * rejects as damaged (the quantity is removed as a MANUAL_ADJUSTMENT outflow
 * with a standardized Arabic reason, optionally annotated). Each row links to
 * the on-demand voucher. Router-free list extracted for unit tests, exactly
 * like PaymentPanel on the invoice screen.
 */
export function ReturnsReviewList({ returns }: { returns: readonly ReturnDetail[] }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [rejectReasons, setRejectReasons] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const invalidate = () => {
    // app-wide (like the items page): a review touches the pending badge, the
    // activity log, item stock, and the returns list — whose key now carries
    // the page, so a bare path prefix would not match the orpc key shape
    return queryClient.invalidateQueries();
  };

  const accept = useMutation(
    orpc.returnsAccept.mutationOptions({ onSuccess: invalidate }),
  );
  const reject = useMutation(
    orpc.returnsReject.mutationOptions({ onSuccess: invalidate }),
  );

  if (returns.length === 0) {
    return (
      <EmptyState
        testId="returns-list-empty"
        card
        title={t("returnsEmpty")}
        hint={t("returnsEmptyHint")}
      />
    );
  }

  return (
    <div className="grid gap-3" data-testid="returns-review-list">
      {returns.map((record) => {
        const debt = debtOffsetDisplay(record.status, record.debtOffset, record.debtApplied);
        return (
        <article key={record.id} className="rounded border bg-card p-4" data-testid={`returns-review-${record.returnNumber}`}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p dir="ltr" className="font-semibold">{record.returnNumber}</p>
              <p className="text-sm text-muted-foreground">
                {t("returnVoucherInvoice")}: <span dir="ltr">{record.invoiceNumber}</span> — {t("returnsRefundTotal")}: <Amount value={record.refundAmount} />
              </p>
              <p className="text-xs text-muted-foreground">
                {t("returnsCashNow")}: <Amount value={record.cashPaidOut} /> — {t(debt.labelKey)}: <Amount value={debt.value} />
              </p>
              <p className="text-sm text-muted-foreground">
                {record.lines.map((line) => `${line.description} ×${line.quantity}`).join(" · ")}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span
                className={`rounded-full px-2 py-0.5 text-xs ${record.status === "PENDING_REVIEW" ? "bg-warning/10 text-warning" : record.status === "ACCEPTED" ? "bg-success/10 text-success" : "bg-destructive/10 text-destructive"}`}
                data-testid={`returns-status-${record.status}`}
              >
                {t(`returnsStatus_${record.status}`)}
              </span>
              <Link
                to="/invoices/$invoiceId/returns/$returnId/print"
                params={{ invoiceId: record.invoiceId, returnId: record.id }}
                className="text-sm text-foreground underline"
                data-testid={`returns-print-${record.returnNumber}`}
              >
                {t("returnVoucher")}
              </Link>
            </div>
          </div>

          {record.status === "PENDING_REVIEW" && (
            <div className="mt-3 grid gap-2 border-t pt-3" data-testid={`returns-actions-${record.returnNumber}`}>
              <input
                className={cn(inputClass, "py-1 text-sm")}
                placeholder={t("returnsRejectReason")}
                value={rejectReasons[record.id] ?? ""}
                onChange={(event) => setRejectReasons((current) => ({ ...current, [record.id]: event.target.value }))}
                data-testid={`returns-reject-reason-${record.returnNumber}`}
              />
              <div className="flex gap-2">
                <button
                  type="button"
                  className="rounded-lg bg-success px-3 py-1 text-sm text-success-foreground disabled:opacity-50"
                  disabled={busy !== null}
                  onClick={() => {
                    setBusy(record.id);
                    void accept.mutateAsync({ returnId: record.id }).catch(() => undefined).finally(() => setBusy(null));
                  }}
                  data-testid={`returns-accept-${record.returnNumber}`}
                >
                  {t("returnsAcceptBtn")}
                </button>
                <button
                  type="button"
                  className="rounded-lg bg-destructive px-3 py-1 text-sm text-destructive-foreground disabled:opacity-50"
                  disabled={busy !== null}
                  onClick={() => {
                    setBusy(record.id);
                    const reason = (rejectReasons[record.id] ?? "").trim();
                    void reject.mutateAsync({ returnId: record.id, reason: reason === "" ? undefined : reason }).catch(() => undefined).finally(() => setBusy(null));
                  }}
                  data-testid={`returns-reject-${record.returnNumber}`}
                >
                  {t("returnsRejectBtn")}
                </button>
              </div>
              {(accept.error !== null || reject.error !== null) && (
                <p role="alert" className="rounded border border-destructive/20 bg-destructive/10 p-2 text-xs text-destructive" data-testid="returns-review-error">
                  {tError((accept.error instanceof Error ? accept.error.message : undefined) ?? (reject.error instanceof Error ? reject.error.message : undefined))}
                </p>
              )}
            </div>
          )}
        </article>
        );
      })}
    </div>
  );
}

export function ReturnsPage() {
  const { t } = useTranslation();
  const pager = usePagination();
  const query = useQuery(orpc.returnsList.queryOptions({ input: { ...pager.pagination } }));
  const [tab, setTab] = useState<"customers" | "suppliers">("customers");
  if (query.isPending) {
    return <p className="text-sm text-muted-foreground" data-testid="returns-loading">{t("expensesLoading")}</p>;
  }
  if (query.isError || query.data === undefined) {
    const message = query.error instanceof Error ? query.error.message : undefined;
    return (
      <section className="grid gap-4" data-testid="returns-error">
        <h1 className="text-xl font-bold">{t("returnsTitle")}</h1>
        <p role="alert" className="rounded border border-destructive/20 bg-destructive/10 p-2 text-sm text-destructive" data-testid="returns-error-text">{tError(message)}</p>
      </section>
    );
  }
  const all = query.data.items;
  const pending = all.filter((record) => record.status === "PENDING_REVIEW");
  const reviewed = all.filter((record) => record.status !== "PENDING_REVIEW");
  return (
    <section className="grid gap-4" data-testid="returns-page">
      <h1 className="text-xl font-bold">{t("returnsTitle")}</h1>
      <div role="tablist" aria-label={t("returnsTitle")} className="flex gap-1 border-b border-border">
        <button
          type="button"
          role="tab"
          id="returns-tab-customers"
          aria-selected={tab === "customers"}
          aria-controls="returns-panel-customers"
          onClick={() => setTab("customers")}
          data-testid="returns-tab-customers"
          className={tab === "customers" ? "-mb-px rounded-t border-b-2 border-primary px-3 py-2 text-sm font-medium" : "-mb-px rounded-t border-b-2 border-transparent px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground"}
        >
          {t("returnsTabCustomers")}
        </button>
        <button
          type="button"
          role="tab"
          id="returns-tab-suppliers"
          aria-selected={tab === "suppliers"}
          aria-controls="returns-panel-suppliers"
          onClick={() => setTab("suppliers")}
          data-testid="returns-tab-suppliers"
          className={tab === "suppliers" ? "-mb-px rounded-t border-b-2 border-primary px-3 py-2 text-sm font-medium" : "-mb-px rounded-t border-b-2 border-transparent px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground"}
        >
          {t("returnsTabSuppliers")}
        </button>
      </div>
      <div role="tabpanel" id="returns-panel-customers" aria-labelledby="returns-tab-customers" hidden={tab !== "customers"}>
        <ReturnsReviewList returns={[...pending, ...reviewed]} />
        <Pager
          total={query.data.total}
          pageSize={pager.pageSize}
          offset={pager.offset}
          onOffsetChange={pager.setOffset}
          onPageSizeChange={pager.setPageSize}
          testId="returns-pager"
        />
      </div>
      <div role="tabpanel" id="returns-panel-suppliers" aria-labelledby="returns-tab-suppliers" hidden={tab !== "suppliers"}>
        <SupplierReturnsList />
      </div>
    </section>
  );
}

/**
 * #161 — the supplier purchase-return history. Plain list: a purchase return
 * is auto-accepted, so there is no accept/reject action. Each row links to the
 * on-demand voucher.
 */
export function SupplierReturnsList() {
  const { t } = useTranslation();
  const pager = usePagination();
  const query = useQuery(orpc.suppliersReturnsList.queryOptions({ input: { ...pager.pagination } }));
  if (query.isPending) {
    return <p className="text-sm text-muted-foreground" data-testid="supplier-returns-loading">{t("expensesLoading")}</p>;
  }
  if (query.isError || query.data === undefined) {
    const message = query.error instanceof Error ? query.error.message : undefined;
    return <p role="alert" className="rounded border border-destructive/20 bg-destructive/10 p-2 text-sm text-destructive" data-testid="supplier-returns-error">{tError(message)}</p>;
  }
  if (query.data.total === 0) {
    return (
      <EmptyState
        testId="supplier-returns-empty"
        card
        title={t("supplierReturnsEmpty")}
        hint={t("supplierReturnsEmptyHint")}
      />
    );
  }
  return (
    <>
    <div className="grid gap-3" data-testid="supplier-returns-list">
      {query.data.items.map((record: SupplierReturnRecord) => (
        <article key={record.id} className="rounded border bg-card p-4" data-testid={`supplier-return-${record.returnNumber}`}>
          <div className="flex items-center justify-between gap-3">
            <div>
              <p dir="ltr" className="font-semibold">{record.returnNumber}</p>
              <p className="text-sm text-muted-foreground" data-testid="supplier-return-supplier">
                {t("supplierReturnSupplier")}: {record.supplierName ?? record.supplierId}
              </p>
              <p className="text-sm text-muted-foreground">
                {t("returnsRefundTotal")}: <Amount value={record.amount} />
                {record.invoiceNumber !== null && <> — {t("supplierReturnInvoiceLink")}: <span dir="ltr">{record.invoiceNumber}</span></>}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("supplierReturnDebtReduction")}: <Amount value={record.debtReduction} /> — {t("supplierReturnCredit")}: <Amount value={record.credit} />
              </p>
              <p className="text-sm text-muted-foreground">
                {record.lines.map((line) => `${line.description} ×${line.quantity}`).join(" · ")}
              </p>
            </div>
            <Link
              to="/suppliers/$partyId/returns/$returnId/print"
              params={{ partyId: record.supplierId, returnId: record.id }}
              className="text-sm text-foreground underline"
              data-testid={`supplier-return-print-${record.returnNumber}`}
            >
              {t("supplierReturnVoucher")}
            </Link>
          </div>
        </article>
      ))}
    </div>
    <Pager
      total={query.data.total}
      pageSize={pager.pageSize}
      offset={pager.offset}
      onOffsetChange={pager.setOffset}
      onPageSizeChange={pager.setPageSize}
      testId="supplier-returns-pager"
    />
    </>
  );
}
