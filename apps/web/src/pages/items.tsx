import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Skeleton } from "@/components/ui/skeleton";

import { orpc } from "../lib/rpc";
import { tError } from "../lib/i18n";
import { StockForm } from "./stock";

/** Live profit preview: selling - cost, recomputed on every keystroke. */
function profitPreview(costText: string, sellText: string): number | null {
  const cost = Number(costText);
  const sell = Number(sellText);
  if (!Number.isFinite(cost) || !Number.isFinite(sell)) return null;
  return sell - cost;
}

export function ItemsPage() {
  const { t } = useTranslation();
  return (
    <section>
      <h1 className="text-xl font-bold">{t("itemsTitle")}</h1>
      <ItemForm />
      <StockForm />
      <ItemList />
    </section>
  );
}

function ItemForm() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const categories = useQuery(orpc.categoriesList.queryOptions());
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [cost, setCost] = useState("");
  const [sell, setSell] = useState("");
  const [threshold, setThreshold] = useState("5");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation(
    orpc.itemsCreate.mutationOptions({
      onSuccess: () => {
        setName("");
        setCost("");
        setSell("");
        setThreshold("5");
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.itemsList.queryKey() }),
          queryClient.invalidateQueries({ queryKey: orpc.itemsLowStock.queryKey() }),
        ]);
      },
      onError: (err) => setError(tError(err.message)),
    }),
  );

  const profit = profitPreview(cost, sell);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const selling = Number(sell);
    if (!Number.isFinite(selling) || selling <= 0) {
      setError(t("itemsSellAboveCost"));
      return;
    }
    const chosenCategory = categoryId || categories.data?.items[0]?.id;
    if (!chosenCategory) {
      setError(t("itemsChooseCategory"));
      return;
    }
    void create.mutate({
      name,
      categoryId: chosenCategory,
      costPrice: Number(cost) || 0,
      sellingPrice: selling,
      // blank means default 5; 0 is a legitimate threshold (warn at zero)
      lowStockThreshold: (() => {
        if (threshold === "") return 5;
        const parsed = Number(threshold);
        return Number.isFinite(parsed) && parsed >= 0 ? parsed : 5;
      })(),
    });
  }

  return (
    <form className="mt-4 grid gap-3 rounded border bg-white p-4" onSubmit={submit}>
      <label className="grid gap-1">
        {t("itemsName")}
        <input className="rounded border px-3 py-2" value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      <label className="grid gap-1">
        {t("itemsCategory")}
        <select className="rounded border px-3 py-2" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          {categories.data?.items.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
          {categories.data?.items.length === 0 && <option value="">{t("itemsChooseCategory")}</option>}
        </select>
      </label>
      <div className="grid grid-cols-3 gap-3">
        <label className="grid gap-1">
          {t("itemsCost")}
          <input className="rounded border px-3 py-2" value={cost} onChange={(e) => setCost(e.target.value)} inputMode="numeric" required />
        </label>
        <label className="grid gap-1">
          {t("itemsSell")}
          <input className="rounded border px-3 py-2" value={sell} onChange={(e) => setSell(e.target.value)} inputMode="numeric" required />
        </label>
        <label className="grid gap-1">
          {t("itemsThreshold")}
          <input className="rounded border px-3 py-2" value={threshold} onChange={(e) => setThreshold(e.target.value)} inputMode="numeric" />
        </label>
      </div>
      <p className="text-sm text-stone-600" data-testid="profit-preview">
        {profit !== null ? t("itemsProfitPerUnit", { profit }) : "…"}
      </p>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button className="rounded-lg bg-stone-900 py-2 text-white" type="submit">
        {t("itemsSave")}
      </button>
    </form>
  );
}

function ItemList() {
  const { t } = useTranslation();
  const items = useQuery(orpc.itemsList.queryOptions());

  // first load: skeleton rows matching the table shape so layout does not jump
  if (items.isPending || !items.data) {
    return (
      <div className="mt-6 grid gap-3 rounded border bg-white p-3">
        {[0, 1, 2, 3].map((row) => (
          <Skeleton key={row} className="h-6 w-full" />
        ))}
      </div>
    );
  }

  if (items.data.items.length === 0) {
    return <p className="mt-6 rounded border bg-white p-3 text-stone-500">{t("itemsEmpty")}</p>;
  }

  return (
    <table className="mt-6 w-full rounded border bg-white">
      <thead>
        <tr className="border-b text-right text-sm text-stone-500">
          <th className="p-3">{t("itemsName")}</th>
          <th className="p-3">{t("itemsCategory")}</th>
          <th className="p-3">{t("itemsCost")}</th>
          <th className="p-3">{t("itemsSell")}</th>
          <th className="p-3">{t("itemsProfitPerUnit", { profit: "" })}</th>
          <th className="p-3">{t("dashboardItemsCount")}</th>
          <th className="p-3" />
        </tr>
      </thead>
      <tbody>
        {items.data?.items.map((item) => (
          <tr key={item.id} className="border-b last:border-0">
            <td className="p-3">{item.name}</td>
            <td className="p-3">{item.categoryId}</td>
            <td className="p-3">{item.costPrice}</td>
            <td className="p-3">{item.sellingPrice}</td>
            <td className="p-3">{item.sellingPrice - item.costPrice}</td>
            <td className="p-3">
              {item.stockOnHand} {item.stockOnHand <= item.lowStockThreshold && <span className="text-xs text-red-600">{t("itemsLowBadge")}</span>}
            </td>
            <td className="p-3">
              <Link to="/items/$itemId/history" params={{ itemId: item.id }} className="text-stone-600 underline hover:text-stone-900">
                {t("historyLink")}
              </Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}