import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Amount } from "@/components/ui/amount";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { Skeleton } from "@/components/ui/skeleton";
import { GettingStartedPanel } from "@/components/app/getting-started-panel";
import { useOnboardingCompleted, useOnboardingDismissed } from "@/components/app/onboarding-state";
import { isOnboardingComplete } from "@/components/app/onboarding-steps";

import { orpc } from "../lib/rpc";

/**
 * How often the landing summary refetches so an open dashboard stays current.
 *
 * Deliberate: the server's local day is only re-read on this tick, so across
 * midnight the displayed day can lag by up to 60s. A shorter interval was
 * rejected — the lag self-heals on the next tick.
 */
const REFRESH_MS = 60_000;

function KpiCard({ label, value, detail, testId }: { label: string; value: ReactNode; detail?: ReactNode; testId?: string }) {
  return (
    <div className="rounded border bg-card p-3" data-testid={testId}>
      <div className="text-2xl font-bold">{value}</div>
      <div className="mt-1 text-sm text-muted-foreground">{label}</div>
      {detail !== undefined && <div className="mt-1 text-xs text-muted-foreground">{detail}</div>}
    </div>
  );
}

/**
 * Landing screen (/). Answers "how is my shop today?" from ONE server aggregate
 * (issue 84): the server's own local day, the day's exact sales, both debt
 * directions, low stock, and the five newest invoices by creation time. The
 * page derives nothing — no device clock, no summing a capped list, no
 * re-sorting a page the api ordered by business date.
 *
 * The getting-started checklist (issue 97) reads its own one-EXISTS aggregate;
 * its absence or a failed read never hides the figures above.
 */
export function DashboardPage({ refreshMs = REFRESH_MS }: { refreshMs?: number } = {}) {
  const { t } = useTranslation();
  const summary = useQuery({ ...orpc.dashboardSummary.queryOptions(), refetchInterval: refreshMs });

  // The checklist's dismissal/completion are server-side preferences (issue 97
  // follow-up): they survive a packaged restart. While they load, the panel
  // waits rather than flashing open for an owner who already dismissed it.
  const { value: dismissed, setValue: setDismissed, isPending: dismissedPending } = useOnboardingDismissed();
  const { value: completed, setValue: setCompleted, isPending: completedPending } = useOnboardingCompleted();
  const hidden = dismissed || completed;
  const preferencesPending = dismissedPending || completedPending;

  const progress = useQuery({
    ...orpc.onboardingProgress.queryOptions(),
    // Once the panel can no longer render, stop paying for the read entirely.
    enabled: !hidden && !preferencesPending,
    // While it can render, the same cadence as the summary lets a step
    // completed in another window self-heal (disabled queries never fetch).
    refetchInterval: refreshMs,
  });

  // "Finished means gone": record the milestone once, so a later settlement
  // cannot resurrect the panel.
  const complete = progress.data !== undefined && isOnboardingComplete(progress.data);
  useEffect(() => {
    if (complete) setCompleted(true);
  }, [complete, setCompleted]);

  return (
    <section data-testid="dashboard-page">
      <h1 className="text-xl font-bold">{t("dashboardTitle")}</h1>

      {/* Getting-started checklist: shown only while the server says a step is
          open and the owner has not dismissed or completed it. It never blocks
          the cards and lists below. */}
      <GettingStartedPanel
        hidden={hidden}
        progress={progress.data}
        // no skeleton while the preferences load: an owner who already
        // dismissed/completed must not see even a placeholder flash
        isPending={progress.isPending && !preferencesPending}
        onDismiss={() => setDismissed(true)}
      />

      <div className="mt-4 flex flex-wrap gap-3">
        <Link
          to="/sale"
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
          data-testid="dashboard-new-sale"
        >
          {t("dashboardNewSale")}
        </Link>
        <Link
          to="/debts"
          className="rounded-lg border bg-card px-4 py-2 text-sm font-medium hover:bg-accent"
          data-testid="dashboard-debts"
        >
          {t("navDebts")}
        </Link>
      </div>

      {summary.isPending ? (
        <>
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            {[0, 1, 2].map((card) => (
              <div key={card} className="rounded border bg-card p-3">
                <Skeleton className="h-8 w-16" />
                <Skeleton className="mt-2 h-4 w-24" />
              </div>
            ))}
          </div>
          <Skeleton className="mt-6 h-5 w-32" />
          <div className="mt-2 grid gap-3 rounded border bg-card p-3">
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} className="h-6 w-full" />
            ))}
          </div>
          <Skeleton className="mt-6 h-5 w-32" />
          <div className="mt-2 grid gap-3 rounded border bg-card p-3">
            {[0, 1].map((row) => (
              <Skeleton key={row} className="h-6 w-full" />
            ))}
          </div>
        </>
      ) : summary.data === undefined ? (
        <p className="mt-4 rounded border bg-card p-4 text-muted-foreground" role="alert" data-testid="dashboard-error">
          {t("dashboardError")}
        </p>
      ) : (
        <>
          {summary.isRefetchError && (
            <p
              className="mt-4 rounded border border-warning/30 bg-warning/10 p-3 text-sm text-warning"
              role="status"
              data-testid="dashboard-stale"
            >
              {t("dashboardStaleRefresh")}
            </p>
          )}
          <p className="mt-2 text-xs text-muted-foreground">
            {t("dashboardDay")}:{" "}
            <span dir="ltr" data-testid="dashboard-day">
              {summary.data.day}
            </span>
          </p>

          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
            <KpiCard
              label={t("dashboardSalesToday")}
              testId="dashboard-sales-today"
              value={<Amount value={summary.data.salesTotal} />}
              detail={
                <>
                  {t("dashboardSalesCount")}: {summary.data.salesCount}
                </>
              }
            />

            <KpiCard
              label={t("debtsOwedToUs")}
              testId="dashboard-debt-owed"
              value={<Amount value={summary.data.owedToUs} />}
              detail={
                <>
                  {t("debtsWeOwe")}: <Amount value={summary.data.weOwe} />
                </>
              }
            />

            <KpiCard
              label={t("dashboardLowStockKpi")}
              testId="dashboard-low-stock"
              // null means that read failed; the money cards above are unaffected
              value={
                summary.data.lowStockCount === null ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  summary.data.lowStockCount
                )
              }
              detail={summary.data.lowStockCount === null ? t("dashboardSectionUnavailable") : undefined}
            />
          </div>

          <h2 className="mt-6 font-semibold">{t("dashboardRecentInvoices")}</h2>
          {summary.data.recentInvoices === null ? (
            <p className="mt-2 text-muted-foreground" data-testid="dashboard-recents-unavailable">
              {t("dashboardSectionUnavailable")}
            </p>
          ) : summary.data.recentInvoices.length === 0 ? (
            <div className="mt-2 rounded border border-border bg-card" data-testid="dashboard-recents-empty">
              <EmptyState
                title={t("invoicesEmpty")}
                hint={t("dashboardRecentsEmptyHint")}
                action={
                  <Button asChild size="lg">
                    <Link to="/sale">{t("dashboardNewSale")}</Link>
                  </Button>
                }
              />
            </div>
          ) : (
            <div className="mt-2 overflow-x-auto rounded border bg-card">
              <table className="w-full min-w-[44rem] text-sm" data-testid="dashboard-recents">
                <thead>
                  <tr className="border-b text-right text-muted-foreground">
                    <th className="p-2 font-medium">{t("invoiceNumber")}</th>
                    <th className="p-2 font-medium">{t("invoiceKind")}</th>
                    <th className="p-2 font-medium">{t("invoiceParty")}</th>
                    <th className="p-2 font-medium">{t("invoiceDate")}</th>
                    <th className="p-2 font-medium">{t("invoiceTotal")}</th>
                    <th className="p-2 font-medium">{t("invoiceRemaining")}</th>
                    <th className="p-2" />
                  </tr>
                </thead>
                <tbody>
                  {summary.data.recentInvoices.map((invoice) => (
                    <tr key={invoice.id} className="border-b last:border-0" data-testid="dashboard-recent-row">
                      <td className="p-2 font-medium" dir="ltr">
                        {invoice.invoiceNumber}
                      </td>
                      <td className="p-2">{t(`invoiceKind_${invoice.kind}`)}</td>
                      <td className="p-2">{invoice.counterpartyName ?? "—"}</td>
                      <td className="p-2" dir="ltr">
                        {invoice.invoiceDate}
                      </td>
                      <td className="p-2">
                        <Amount value={invoice.totalAmount} />
                      </td>
                      <td className="p-2">
                        <Amount value={invoice.remainingAmount} />
                      </td>
                      <td className="p-2">
                        <Link
                          to="/invoices/$invoiceId"
                          params={{ invoiceId: invoice.id }}
                          className="rounded-lg border px-3 py-1 text-sm hover:bg-muted"
                          data-testid={`dashboard-recent-open-${invoice.invoiceNumber}`}
                        >
                          {t("invoicesOpen")}
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <h2 className="mt-6 font-semibold">{t("dashboardLowStock")}</h2>
          {summary.data.lowStockItems === null ? (
            <p className="mt-2 text-muted-foreground" data-testid="dashboard-low-stock-unavailable">
              {t("dashboardSectionUnavailable")}
            </p>
          ) : summary.data.lowStockItems.length === 0 ? (
            <p className="mt-2 text-muted-foreground">{t("dashboardLowStockEmpty")}</p>
          ) : (
            <ul className="mt-2 divide-y rounded border bg-card" data-testid="dashboard-low-stock-list">
              {summary.data.lowStockItems.map((item) => (
                <li key={item.id} className="flex justify-between p-3">
                  <span>{item.name}</span>
                  <span className="font-semibold">
                    {item.stockOnHand} / {item.lowStockThreshold}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
