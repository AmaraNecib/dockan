import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { Skeleton } from "@/components/ui/skeleton";

import { orpc } from "../lib/rpc";

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

      {activities.isPending || !activities.data ? (
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
                <td className="p-3">{entry.summary}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
