import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { orpc } from "../lib/rpc";

export function DashboardPage() {
  const { t } = useTranslation();
  const lowStock = useQuery(orpc.itemsLowStock.queryOptions());
  const items = useQuery(orpc.itemsList.queryOptions());
  const categories = useQuery(orpc.categoriesList.queryOptions());

  return (
    <section>
      <h1 className="text-xl font-bold">{t("dashboardTitle")}</h1>

      <div className="mt-4 flex gap-3">
        <div className="flex-1 rounded border bg-white p-3">
          <div className="text-2xl font-bold">{items.data?.items.length ?? "…"}</div>
          <div className="text-sm text-stone-500">{t("dashboardItemsCount")}</div>
        </div>
        <div className="flex-1 rounded border bg-white p-3">
          <div className="text-2xl font-bold">{categories.data?.items.length ?? "…"}</div>
          <div className="text-sm text-stone-500">{t("dashboardCategoriesCount")}</div>
        </div>
      </div>

      <h2 className="mt-6 font-semibold">{t("dashboardLowStock")}</h2>
      {lowStock.data && lowStock.data.items.length === 0 ? (
        <p className="mt-2 text-stone-500">{t("dashboardLowStockEmpty")}</p>
      ) : (
        <ul className="mt-2 divide-y rounded border bg-white">
          {lowStock.data?.items.map((item) => (
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