import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { Amount } from "@/components/ui/amount";
import { Skeleton } from "@/components/ui/skeleton";

import { orpc } from "../lib/rpc";

/**
 * "YYYY-MM-DD" in Algeria local time — the same clock the api stamps
 * invoiceDate with (logger.localDate). Using the browser's timezone would
 * shift the "today" window for an owner travelling or a misconfigured clock,
 * so the shop's home timezone is pinned here too.
 */
export function algeriaLocalDate(now: Date = new Date()): string {
  return now.toLocaleString("en-CA", {
    timeZone: "Africa/Algiers",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

function KpiCard({ label, value, detail, testId }: { label: string; value: ReactNode; detail?: ReactNode; testId?: string }) {
  return (
    <div className="rounded border bg-card p-3" data-testid={testId}>
      <div className="text-2xl font-bold">{value}</div>
      <div className="mt-1 text-sm text-muted-foreground">{label}</div>
      {detail !== undefined && <div className="mt-1 text-xs text-muted-foreground">{detail}</div>}
    </div>
  );
}

/** How often the dashboard re-reads the Algeria-local day. */
const DAY_TICK_MS = 60_000;

/**
 * Landing screen (/). Answers "how is my shop today?" with the figures an
 * owner acts on hour to hour: today's sales, money owed to the shop, low
 * stock, and the newest invoices — plus one-tap entry to the two screens the
 * figures point at (/sale, /debts). Every number comes from an existing query;
 * a failed one degrades to a neutral placeholder instead of blanking the page.
 */
export function DashboardPage({ dayTickMs = DAY_TICK_MS }: { dayTickMs?: number } = {}) {
  const { t } = useTranslation();
  const [today, setToday] = useState(() => algeriaLocalDate());

  // A dashboard left open across midnight must roll its "sales today" window
  // onto the new Algeria-local day; the tick only re-renders when the date
  // string actually changes. `dayTickMs` lets tests roll midnight without
  // waiting a minute.
  useEffect(() => {
    const id = setInterval(() => setToday(algeriaLocalDate()), dayTickMs);
    return () => clearInterval(id);
  }, [dayTickMs]);

  const todaySales = useQuery(
    orpc.invoicesList.queryOptions({ input: { kind: "SALE", fromDate: today, toDate: today } }),
  );
  const debts = useQuery(orpc.reportsDebts.queryOptions());
  const lowStock = useQuery(orpc.itemsLowStock.queryOptions());
  const recentInvoices = useQuery(orpc.invoicesList.queryOptions({ input: {} }));

  // invoicesList caps at 200 rows and the contract exposes no pagination, so a
  // >200-sale day undercounts. Kept as a documented at-a-glance floor rather
  // than faked client-side; an exact daily total needs an api sum procedure.
  const salesTotal = (todaySales.data?.items ?? []).reduce((sum, invoice) => sum + invoice.totalAmount, 0);
  const owedToUsTotal = (debts.data?.owedToUs ?? []).reduce((sum, row) => sum + row.remainingTotal, 0);
  const weOweTotal = (debts.data?.weOwe ?? []).reduce((sum, row) => sum + row.remainingTotal, 0);
  const lowStockCount = lowStock.data?.items.length ?? 0;
  const recent = (recentInvoices.data?.items ?? []).slice(0, 5);

  const dash = <span className="text-muted-foreground">—</span>;

  return (
    <section data-testid="dashboard-page">
      <h1 className="text-xl font-bold">{t("dashboardTitle")}</h1>

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

      <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <KpiCard
          label={t("dashboardSalesToday")}
          testId="dashboard-sales-today"
          value={
            todaySales.data === undefined ? (
              todaySales.isPending ? (
                <Skeleton className="inline-block h-8 w-16" />
              ) : (
                dash
              )
            ) : (
              <Amount value={salesTotal} />
            )
          }
        />

        <KpiCard
          label={t("debtsOwedToUs")}
          testId="dashboard-debt-owed"
          value={
            debts.data === undefined ? (
              debts.isPending ? (
                <Skeleton className="inline-block h-8 w-16" />
              ) : (
                dash
              )
            ) : (
              <Amount value={owedToUsTotal} />
            )
          }
          detail={
            debts.data === undefined ? undefined : (
              <>
                {t("debtsWeOwe")}: <Amount value={weOweTotal} />
              </>
            )
          }
        />

        <KpiCard
          label={t("dashboardLowStockKpi")}
          testId="dashboard-low-stock"
          value={
            lowStock.data === undefined ? (
              lowStock.isPending ? (
                <Skeleton className="inline-block h-8 w-10" />
              ) : (
                dash
              )
            ) : (
              lowStockCount
            )
          }
        />
      </div>

      <h2 className="mt-6 font-semibold">{t("dashboardRecentInvoices")}</h2>
      {recentInvoices.data === undefined ? (
        recentInvoices.isPending ? (
          <div className="mt-2 grid gap-3 rounded border bg-card p-3">
            {[0, 1, 2].map((row) => (
              <Skeleton key={row} className="h-6 w-full" />
            ))}
          </div>
        ) : (
          <p className="mt-2 text-muted-foreground">{t("invoicesEmpty")}</p>
        )
      ) : recent.length === 0 ? (
        <p className="mt-2 text-muted-foreground">{t("invoicesEmpty")}</p>
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
              {recent.map((invoice) => (
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
      {lowStock.data === undefined ? (
        lowStock.isPending ? (
          <div className="mt-2 grid gap-3 rounded border bg-card p-3">
            {[0, 1].map((row) => (
              <Skeleton key={row} className="h-6 w-full" />
            ))}
          </div>
        ) : (
          <p className="mt-2 text-muted-foreground">{dash}</p>
        )
      ) : lowStock.data.items.length === 0 ? (
        <p className="mt-2 text-muted-foreground">{t("dashboardLowStockEmpty")}</p>
      ) : (
        <ul className="mt-2 divide-y rounded border bg-card" data-testid="dashboard-low-stock-list">
          {lowStock.data.items.map((item) => (
            <li key={item.id} className="flex justify-between p-3">
              <span>{item.name}</span>
              <span className="font-semibold">
                {item.stockOnHand} / {item.lowStockThreshold}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
