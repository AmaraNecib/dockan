import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { orpc } from "../lib/rpc";
import { strings } from "../lib/strings";

/** Live profit preview: selling - cost, recomputed on every keystroke. */
function profitPreview(costText: string, sellText: string): number | null {
  const cost = Number(costText);
  const sell = Number(sellText);
  if (!Number.isFinite(cost) || !Number.isFinite(sell)) return null;
  return sell - cost;
}

export function ItemsPage() {
  return (
    <section>
      <h1 className="text-xl font-bold">{strings.items.title}</h1>
      <ItemForm />
      <ItemList />
    </section>
  );
}

function ItemForm() {
  const queryClient = useQueryClient();
  const categories = useQuery(orpc.categoriesList.queryOptions());
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [cost, setCost] = useState("");
  const [sell, setSell] = useState("");
  const [threshold, setThreshold] = useState("5");
  const [error, setError] = useState<string | null>(null);

  const create = useMutation(orpc.itemsCreate.mutationOptions());

  const profit = profitPreview(cost, sell);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const selling = Number(sell);
    if (!Number.isFinite(selling) || selling <= 0) {
      setError(strings.items.sellAboveCost);
      return;
    }
    const chosenCategory = categoryId || categories.data?.items[0]?.id;
    if (!chosenCategory) {
      setError(strings.categories.empty);
      return;
    }
    try {
      await create.mutateAsync({
        name,
        categoryId: chosenCategory,
        costPrice: Number(cost) || 0,
        sellingPrice: selling,
        // blank means default 5; 0 is a legitimate threshold (warn at zero)
        lowStockThreshold: (() => {
          if (threshold === "") return 5;
          const t = Number(threshold);
          return Number.isFinite(t) && t >= 0 ? t : 5;
        })(),
      });
      setName("");
      setCost("");
      setSell("");
      setThreshold("5");
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: orpc.itemsList.queryKey() }),
        queryClient.invalidateQueries({ queryKey: orpc.itemsLowStock.queryKey() }),
      ]);
    } catch (err) {
      setError(String(err));
    }
  }

  return (
    <form className="mt-4 grid gap-3 rounded border bg-white p-4" onSubmit={submit}>
      <label className="grid gap-1">
        {strings.items.fieldName}
        <input className="rounded border px-3 py-2" value={name} onChange={(e) => setName(e.target.value)} required />
      </label>
      <label className="grid gap-1">
        {strings.items.fieldCategory}
        <select className="rounded border px-3 py-2" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          {categories.data?.items.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
          {categories.data?.items.length === 0 && <option value="">{strings.categories.empty}</option>}
        </select>
      </label>
      <div className="grid grid-cols-3 gap-3">
        <label className="grid gap-1">
          {strings.items.fieldCost}
          <input className="rounded border px-3 py-2" type="number" min="0" value={cost} onChange={(e) => setCost(e.target.value)} />
        </label>
        <label className="grid gap-1">
          {strings.items.fieldSell}
          <input className="rounded border px-3 py-2" type="number" min="0" value={sell} onChange={(e) => setSell(e.target.value)} required />
        </label>
        <label className="grid gap-1">
          {strings.items.fieldThreshold}
          <input className="rounded border px-3 py-2" type="number" min="0" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
        </label>
      </div>

      {profit !== null && (
        <p className="font-semibold text-emerald-700" data-testid="profit-preview">
          {strings.profitPerUnit(profit)}
        </p>
      )}

      {error && <p className="text-red-600">{error}</p>}

      <button className="rounded bg-stone-900 px-4 py-2 text-white disabled:opacity-50" disabled={create.isPending}>
        {strings.items.save}
      </button>
    </form>
  );
}

function ItemList() {
  const itemsQuery = useQuery(orpc.itemsList.queryOptions());
  const categoriesQuery = useQuery(orpc.categoriesList.queryOptions());
  const categoryName = new Map((categoriesQuery.data?.items ?? []).map((c) => [c.id, c.name]));

  return (
    <div className="mt-6 overflow-x-auto rounded border bg-white">
      <table className="w-full text-sm">
        <thead className="border-b text-stone-500">
          <tr>
            <th className="p-3 text-right">{strings.items.columns.name}</th>
            <th className="p-3 text-right">{strings.items.columns.category}</th>
            <th className="p-3 text-right">{strings.items.columns.cost}</th>
            <th className="p-3 text-right">{strings.items.columns.sell}</th>
            <th className="p-3 text-right">{strings.items.columns.profit}</th>
            <th className="p-3 text-right">{strings.items.columns.stock}</th>
            <th className="p-3 text-right">{strings.items.columns.threshold}</th>
          </tr>
        </thead>
        <tbody>
          {itemsQuery.data?.items.map((item) => (
            <tr key={item.id} className="border-b last:border-0">
              <td className="p-3">{item.name}</td>
              <td className="p-3">{categoryName.get(item.categoryId) ?? "—"}</td>
              <td className="p-3">{item.costPrice}</td>
              <td className="p-3">{item.sellingPrice}</td>
              <td className="p-3">{item.sellingPrice - item.costPrice}</td>
              <td className="p-3">
                {item.stockOnHand}{" "}
                {item.stockOnHand <= item.lowStockThreshold && (
                  <span className="rounded bg-red-100 px-2 py-0.5 text-xs text-red-700">{strings.items.low}</span>
                )}
              </td>
              <td className="p-3">{item.lowStockThreshold}</td>
            </tr>
          ))}
          {itemsQuery.data?.items.length === 0 && (
            <tr>
              <td className="p-3 text-stone-500" colSpan={7}>
                {strings.items.empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}