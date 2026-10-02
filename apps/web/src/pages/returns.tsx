import { Link } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { ReturnDetail } from "@dokan/contracts";

import { debtOffsetDisplay } from "../lib/return-voucher";
import { tError } from "../lib/i18n";
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

  const invalidate = async () => {
    await Promise.all([
      // exact keys matching the mounted queries (a bare prefix string does not
      // reliably refetch the orpc-generated `["path", { input, type }]` keys)
      queryClient.invalidateQueries({ queryKey: orpc.returnsList.queryKey({ input: {} }) }),
      // the shell badge and dashboard notice read this aggregate (issue #118)
      queryClient.invalidateQueries({ queryKey: orpc.returnsPendingCount.queryKey() }),
      queryClient.invalidateQueries({ queryKey: ["activitiesList"] }),
      queryClient.invalidateQueries({ queryKey: ["itemsList"] }),
    ]);
  };

  const accept = useMutation(
    orpc.returnsAccept.mutationOptions({ onSuccess: invalidate }),
  );
  const reject = useMutation(
    orpc.returnsReject.mutationOptions({ onSuccess: invalidate }),
  );

  if (returns.length === 0) {
    return <p className="text-sm text-muted-foreground" data-testid="returns-list-empty">{t("returnsEmpty")}</p>;
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
                {t("returnVoucherInvoice")}: <span dir="ltr">{record.invoiceNumber}</span> — {t("returnsRefundTotal")}: {record.refundAmount} {t("dzd")}
              </p>
              <p className="text-xs text-muted-foreground">
                {t("returnsCashNow")}: {record.cashPaidOut} {t("dzd")} — {t(debt.labelKey)}: {debt.value} {t("dzd")}
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
                className="rounded border px-3 py-1 text-sm"
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
  const query = useQuery(orpc.returnsList.queryOptions({ input: {} }));
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
      <ReturnsReviewList returns={[...pending, ...reviewed]} />
    </section>
  );
}
