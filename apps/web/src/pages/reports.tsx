import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { ReportRangePreset } from "@dokan/contracts";

import { Skeleton } from "@/components/ui/skeleton";

import { tError } from "../lib/i18n";
import { orpc } from "../lib/rpc";

/**
 * Ticket 31 — profit report (/reports). Six figures over one Algeria-local
 * window (default: current month): revenue, COGS, gross profit, operating
 * expenses, owner withdrawals, and the result after expenses. Every number is
 * computed on the api from raw records at read time (profit-report.ts); the
 * page is a pure projection plus the per-category expense breakdown that makes
 * the operating/withdrawal split traceable to its source rows.
 */

const PRESET_KEYS: ReportRangePreset[] = ["24H", "7D", "28D", "30D", "CURRENT_MONTH", "3M", "6M", "CURRENT_YEAR", "LAST_YEAR", "CUSTOM"];

function toPreset(value: string): ReportRangePreset {
  for (const preset of PRESET_KEYS) {
    if (value === preset) return preset;
  }
  return "CURRENT_MONTH";
}

function withSeconds(value: string): string | undefined {
  if (value === "") return undefined;
  return value.length === 16 ? `${value}:00` : value;
}

export function ReportsPage() {
  const { t } = useTranslation();
  const [preset, setPreset] = useState<ReportRangePreset>("CURRENT_MONTH");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");

  const report = useQuery(
    orpc.reportsProfit.queryOptions({
      input: { preset, customFrom: withSeconds(customFrom), customTo: withSeconds(customTo) },
    }),
  );

  return (
    <section data-testid="reports-page">
      <h1 className="text-xl font-bold">{t("reportsTitle")}</h1>
      <p className="mt-1 text-xs text-stone-500">{t("reportsRangeHint")}</p>

      <div className="mt-4 grid gap-3 rounded border bg-white p-4">
        <div className="grid grid-cols-3 gap-3">
          <label className="grid gap-1">
            {t("expensesRange")}
            <select className="rounded border px-3 py-2" value={preset} onChange={(event) => setPreset(toPreset(event.target.value))} data-testid="report-range-preset">
              {PRESET_KEYS.map((key) => <option key={key} value={key}>{t(`rangePreset_${key}`)}</option>)}
            </select>
          </label>
          {preset === "CUSTOM" && (
            <>
              <label className="grid gap-1">
                {t("expensesCustomFrom")}
                <input type="datetime-local" className="rounded border px-3 py-2" value={customFrom} onChange={(event) => setCustomFrom(event.target.value)} data-testid="report-custom-from" />
              </label>
              <label className="grid gap-1">
                {t("expensesCustomTo")}
                <input type="datetime-local" className="rounded border px-3 py-2" value={customTo} onChange={(event) => setCustomTo(event.target.value)} data-testid="report-custom-to" />
              </label>
            </>
          )}
        </div>
        {report.data !== undefined && (
          <p className="text-sm text-stone-500" dir="ltr" data-testid="report-range-label">
            {report.data.range.from} → {report.data.range.to}
          </p>
        )}
        {report.data !== undefined && (
          <p className="text-xs text-stone-500" data-testid="report-day-hint">{t("reportsSellByDayHint")}</p>
        )}
      </div>

      {report.isError ? (
        <div className="mt-4 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-700" role="alert" data-testid="report-error">
          {tError(report.error?.message)}
        </div>
      ) : report.isPending || report.data === undefined ? (
        <div className="mt-4 grid gap-3">
          {[0, 1, 2, 3, 4, 5].map((row) => <Skeleton key={row} className="h-10 w-full" />)}
        </div>
      ) : (
        <>
          <dl className="mt-4 grid gap-px overflow-hidden rounded border bg-stone-200" data-testid="report-figures">
            <div className="flex justify-between bg-white p-3">
              <dt>{t("reportRevenue")}</dt>
              <dd className="font-semibold" data-testid="report-revenue">{report.data.revenue} دج</dd>
            </div>
            <div className="flex justify-between bg-white p-3">
              <dt>{t("reportCogs")}</dt>
              <dd className="font-semibold" data-testid="report-cogs">-{report.data.cogs} دج</dd>
            </div>
            <div className="flex justify-between bg-white p-3">
              <dt>{t("reportGrossProfit")}</dt>
              <dd className="font-semibold" data-testid="report-gross-profit">{report.data.grossProfit} دج</dd>
            </div>
            <div className="flex justify-between bg-white p-3">
              <dt>{t("reportOperatingExpenses")}</dt>
              <dd className="font-semibold" data-testid="report-operating">-{report.data.operatingExpenses} دج</dd>
            </div>
            <div className="flex justify-between bg-amber-50 p-3">
              <dt>{t("reportOwnerWithdrawals")}</dt>
              <dd className="font-semibold" data-testid="report-withdrawals">-{report.data.ownerWithdrawals} دج</dd>
            </div>
            <div className={`flex justify-between border-t p-3 text-lg font-bold ${report.data.resultAfterExpenses < 0 ? "bg-red-50 text-red-700" : "bg-white"}`}>
              <dt>{t("reportResult")}</dt>
              <dd data-testid="report-result">
                {report.data.resultAfterExpenses} دج
                {report.data.resultAfterExpenses < 0 && <span className="mr-2 text-xs">({t("reportNegative")})</span>}
              </dd>
            </div>
          </dl>

          <h2 className="mt-6 font-semibold">{t("reportByCategory")}</h2>
          {report.data.byCategory.length === 0 ? (
            <p className="mt-2 rounded border bg-white p-4 text-stone-500" data-testid="report-breakdown-empty">{t("reportsEmpty")}</p>
          ) : (
            <table className="mt-2 w-full rounded border bg-white" data-testid="report-breakdown">
              <thead>
                <tr className="border-b text-right text-sm text-stone-500">
                  <th className="p-3">{t("expenseColCategory")}</th>
                  <th className="p-3">{t("expenseCount")}</th>
                  <th className="p-3">{t("expenseColAmount")}</th>
                </tr>
              </thead>
              <tbody>
                {report.data.byCategory.map((row) => (
                  <tr key={row.categoryId} className={`border-b last:border-0 ${row.isOwnerWithdrawal ? "bg-amber-50" : ""}`} data-testid="report-breakdown-row">
                    <td className="p-3">
                      {row.categoryName}
                      {row.isOwnerWithdrawal && <span className="mr-2 rounded bg-amber-200 px-2 py-0.5 text-xs text-amber-900">{t("expensesWithdrawalBadge")}</span>}
                    </td>
                    <td className="p-3">{row.count}</td>
                    <td className="p-3 font-semibold">{row.total} دج</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </section>
  );
}