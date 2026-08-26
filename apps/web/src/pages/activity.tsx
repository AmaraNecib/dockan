import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";

import { Skeleton } from "@/components/ui/skeleton";

import { orpc } from "../lib/rpc";

/** Keep entity references compact, but retain a useful backup filename.
 * Backup refs are local filesystem paths; showing only the basename avoids
 * leaking the data directory while still identifying the exported file.
 */
function formatActivityReference(type: string, ref: string): string {
  if (type === "BACKUP_CREATED") {
    return ref.split(/[\\/]/).filter(Boolean).at(-1) ?? ref;
  }
  return ref.slice(0, 8);
}

/** Translate the locale-neutral activity summaries the returns feature emits
 * (`RETURN_RECORDED <rtn> <amount> <invoice> <debt>` and `RETURN_REVIEWED
 * <rtn> <ACCEPTED|REJECTED> <amount>`). Unknown/legacy summaries render raw
 * exactly as before. The api stays locale-neutral; this page owns the copy.
 */
function activitySummaryText(t: TFunction, type: string, summary: string): string {
  const tokens = summary.split(" ");
  if (type === "RETURN_RECORDED" && tokens[0] === "RETURN_RECORDED" && tokens.length >= 5) {
    const [, number, amount, invoice, debt] = tokens;
    return Number(debt) > 0
      ? t("activityReturnRecordedDebt", { number, amount, invoice, debt })
      : t("activityReturnRecorded", { number, amount, invoice });
  }
  if (type === "RETURN_REVIEWED" && tokens[0] === "RETURN_REVIEWED" && tokens.length >= 4) {
    const [, number, action, amount] = tokens;
    return t("activityReturnReviewed", { number, action: t(action === "ACCEPTED" ? "returnsAcceptBtn" : "returnsRejectBtn"), amount });
  }
  return summary;
}

/**
 * Ticket 12 — activity log (shop trace). Read-only view over the append-only
 * activities table; newest first, Algeria-local timestamps, Arabic labels.
 * The api owns ordering and the limit clamp; the page stays a pure projection.
 */

export function ActivityLogPage() {
  const { t } = useTranslation();
  const activities = useQuery(orpc.activitiesList.queryOptions({ input: { limit: 100 } }));

  return (
    <section>
      <h1 className="text-xl font-bold">{t("activityTitle")}</h1>

      {activities.isError ? (
        <div className="mt-4 flex items-center justify-between rounded border bg-red-50 p-3 text-sm text-red-700">
          <span>{t("activityError")}</span>
          <button type="button" className="underline" onClick={() => void activities.refetch()}>
            {t("itemsSearchRetry")}
          </button>
        </div>
      ) : activities.isPending || !activities.data ? (
        <div className="mt-4 grid gap-3 rounded border bg-white p-3">
          {[0, 1, 2].map((row) => (
            <Skeleton key={row} className="h-6 w-full" />
          ))}
        </div>
      ) : activities.data.items.length === 0 ? (
        <p className="mt-4 rounded border bg-white p-4 text-stone-500">{t("activityEmpty")}</p>
      ) : (
        <table className="mt-4 w-full rounded border bg-white" data-testid="activity-table">
          <thead>
            <tr className="border-b text-right text-sm text-stone-500">
              <th className="p-3">{t("historyDate")}</th>
              <th className="p-3">{t("activityType")}</th>
              <th className="p-3">{t("activitySummary")}</th>
              <th className="p-3">{t("activityRef")}</th>
            </tr>
          </thead>
          <tbody>
            {activities.data.items.map((entry) => (
              <tr key={entry.id} className="border-b last:border-0">
                <td className="p-3 whitespace-nowrap text-sm text-stone-600" dir="ltr">
                  {entry.at}
                </td>
                <td className="p-3">
                  <span className="rounded bg-stone-200 px-2 py-0.5 text-xs text-stone-700">{t(`activityType_${entry.type}`)}</span>
                </td>
                <td className="p-3">{activitySummaryText(t, entry.type, entry.summary)}</td>
                {/* Entity refs are compact; backup refs display their safe local filename. */}
                <td className="p-3 font-mono text-xs text-stone-500" dir="ltr" data-testid="activity-ref">
                  {entry.ref ? formatActivityReference(entry.type, entry.ref) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
