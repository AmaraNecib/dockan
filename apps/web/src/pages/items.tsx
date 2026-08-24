import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Link } from "@tanstack/react-router";
import type { Item, ItemCreate } from "@dokan/contracts";

import { Skeleton } from "@/components/ui/skeleton";

import { orpc, rpcClient } from "../lib/rpc";
import { tError } from "../lib/i18n";
import { normalizeBarcode } from "@dokan/contracts";
import { useBarcodeScanner } from "../lib/use-barcode-scanner";
import { ItemPickerDialog, matchBadgeKey } from "@/components/catalog/item-picker-dialog";
import { UnknownScanDialog } from "@/components/catalog/unknown-scan-dialog";
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
  const queryClient = useQueryClient();

  /** what the item form gets prefilled with after an unknown-scan choice */
  const [formSeed, setFormSeed] = useState<{ barcode: string; withStock: boolean } | null>(null);
  const [unknownCode, setUnknownCode] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // serializes scan lookups by recency: only the NEWEST scan may write state.
  // Without this, an older slow lookup that settles after a newer fast one can
  // overwrite its notice or open the unknown-scan dialog with the wrong code.
  const scanSeqRef = useRef(0);

  // window-level wedge capture: works without any input focus
  async function handleScan(code: string) {
    const seq = ++scanSeqRef.current;
    // a new scan supersedes ALL previous feedback immediately: a confirmed
    // miss must not display under an older found-item/lookup-error notice,
    // and a found item must not leave a stale dialog open (review P2)
    setNotice(null);
    setUnknownCode(null);
    let result;
    try {
      result = await rpcClient.catalogSearch({ query: code });
    } catch {
      // auth/transport/server failure is NOT a confirmed miss — never offer
      // to create an item that may already exist (greptile P1)
      if (seq !== scanSeqRef.current) return; // a newer scan superseded this one
      setNotice(t("scanLookupError"));
      return;
    }
    if (seq !== scanSeqRef.current) return; // a newer scan superseded this one
    if (result.exact !== null) {
      setNotice(t("scanFoundItem", { name: result.exact.item.name }));
      return;
    }
    setUnknownCode(code);
  }
  useBarcodeScanner((code) => void handleScan(code));

  function refreshItems() {
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.itemsList.queryKey() }),
      queryClient.invalidateQueries({ queryKey: orpc.itemsLowStock.queryKey() }),
    ]);
  }

  return (
    <section>
      <h1 className="text-xl font-bold">{t("itemsTitle")}</h1>
      {notice && (
        <p className="mt-2 rounded border bg-green-50 p-2 text-sm text-green-800" data-testid="scan-found" role="status" aria-live="polite">
          {notice}
        </p>
      )}
      <CatalogSearch />
      <ItemForm seed={formSeed} onSeedConsumed={() => setFormSeed(null)} onSaved={refreshItems} />
      <StockForm />
      <ItemList />
      {unknownCode !== null && (
        <UnknownScanDialog
          code={unknownCode}
          onClose={() => setUnknownCode(null)}
          onCreate={() => {
            setFormSeed({ barcode: unknownCode, withStock: false });
            setUnknownCode(null);
          }}
          onCreateWithStock={() => {
            setFormSeed({ barcode: unknownCode, withStock: true });
            setUnknownCode(null);
          }}
          onManualLine={() => {
            // honest deferral: wired to the invoice builder in ticket #30
            setNotice(t("scanDeferredToast"));
            setUnknownCode(null);
          }}
        />
      )}
    </section>
  );
}

function CatalogSearch() {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 150);
    return () => clearTimeout(timer);
  }, [query]);

  const search = useQuery({
    ...orpc.catalogSearch.queryOptions({ input: { query: debounced || " " }, enabled: debounced.length > 0 }),
  });

  return (
    <div className="mt-4 rounded border bg-white p-3">
      <input
        className="w-full rounded border px-3 py-2"
        placeholder={t("itemsSearchPlaceholder")}
        aria-label={t("itemsSearchPlaceholder")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        data-testid="catalog-search"
      />
      {search.isError && (
        <div className="mt-2 flex items-center justify-between rounded border bg-red-50 p-2 text-sm text-red-700">
          <span>{t("itemsSearchError")}</span>
          <button type="button" className="underline" onClick={() => void search.refetch()}>
            {t("itemsSearchRetry")}
          </button>
        </div>
      )}
      {debounced.length > 0 && !search.isError && (
        <ul className="mt-2" data-testid="search-results">
          {search.data?.exact && (
            <li className="flex items-center justify-between rounded bg-stone-50 p-2 font-semibold">
              <span>{search.data.exact.item.name}</span>
              <span dir="ltr" className="font-mono text-xs">
                {search.data.exact.item.barcode}
              </span>
            </li>
          )}
          {(search.data?.matches ?? []).map((match) => (
            <li key={match.item.id} className="flex items-center justify-between p-2">
              <span>{match.item.name}</span>
              <span className="flex items-center gap-2">
                {match.item.barcode && (
                  <span dir="ltr" className="font-mono text-xs text-stone-500">
                    {match.item.barcode}
                  </span>
                )}
                <span className="rounded bg-stone-200 px-2 py-0.5 text-xs text-stone-600">{t(matchBadgeKey(match.matchedBy))}</span>
              </span>
            </li>
          ))}
          {debounced.length > 0 && !search.isPending && !search.isError && !search.data?.exact && (search.data?.matches.length ?? 0) === 0 && (
            <li className="p-2 text-sm text-stone-500">{t("itemsSearchEmpty")}</li>
          )}
        </ul>
      )}
      <button type="button" className="mt-2 text-sm text-stone-600 underline" onClick={() => setPickerOpen(true)} data-testid="open-picker">
        {t("itemsOpenPicker")}
      </button>
      <ItemPickerDialog
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        onSelect={() => {
          setPickerOpen(false);
        }}
      />
    </div>
  );
}

function ItemForm({
  seed,
  onSeedConsumed,
  onSaved,
}: {
  seed: { barcode: string; withStock: boolean } | null;
  onSeedConsumed: () => void;
  onSaved: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const categories = useQuery(orpc.categoriesList.queryOptions());
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [cost, setCost] = useState("");
  const [sell, setSell] = useState("");
  const [threshold, setThreshold] = useState("5");
  const [barcode, setBarcode] = useState("");
  const [initialStock, setInitialStock] = useState("");
  const [error, setError] = useState<string | null>(null);

  // prefill from an unknown-scan choice
  useEffect(() => {
    if (seed !== null) {
      setBarcode(seed.barcode);
      if (!seed.withStock) setInitialStock("");
      setError(null);
    }
  }, [seed]);

  function invalidate() {
    void Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.itemsList.queryKey() }),
      queryClient.invalidateQueries({ queryKey: orpc.itemsLowStock.queryKey() }),
    ]);
    onSaved();
  }

  const create = useMutation(
    orpc.itemsCreate.mutationOptions({
      onSuccess: () => {
        resetFields();
        invalidate();
      },
      onError: (err) => setError(tError(err.message)),
    }),
  );

  const createWithStock = useMutation(
    orpc.itemsCreateWithStock.mutationOptions({
      onSuccess: () => {
        resetFields();
        invalidate();
      },
      onError: (err) => setError(tError(err.message)),
    }),
  );

  function resetFields() {
    setName("");
    setCost("");
    setSell("");
    setThreshold("5");
    setBarcode("");
    setInitialStock("");
    setError(null);
    onSeedConsumed();
  }

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
    // blank stays uncoded; typed codes get the same normalization as scans
    let normalizedBarcode: string | undefined;
    if (barcode.trim() !== "") {
      const normalized = normalizeBarcode(barcode);
      if (normalized === null) {
        setError(t("INVALID_BARCODE"));
        return;
      }
      normalizedBarcode = normalized;
    }
    const wantsStock = seed?.withStock === true;
    const stock = Number(initialStock);
    if (wantsStock && (!Number.isFinite(stock) || stock < 1)) {
      setError(t("scanStockInvalid"));
      return;
    }
    const base: ItemCreate = {
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
    };
    if (normalizedBarcode !== undefined) base.barcode = normalizedBarcode;
    if (wantsStock) void createWithStock.mutate({ ...base, stockOnHand: Math.floor(stock) });
    else void create.mutate(base);
  }

  return (
    <form className="mt-4 grid gap-3 rounded border bg-white p-4" onSubmit={submit}>
      <label className="grid gap-1">
        {t("itemsName")}
        <input className="rounded border px-3 py-2" value={name} onChange={(e) => setName(e.target.value)} required data-testid="item-name" />
      </label>
      <div className="grid grid-cols-2 gap-3">
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
        <label className="grid gap-1">
          {t("itemsBarcode")}
          <input
            dir="ltr"
            className="rounded border px-3 py-2 font-mono"
            value={barcode}
            onChange={(e) => setBarcode(e.target.value)}
            data-testid="item-barcode"
          />
        </label>
      </div>
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
      {seed?.withStock === true && (
        <label className="grid gap-1">
          {t("scanStockInitial")}
          <input
            className="rounded border px-3 py-2"
            value={initialStock}
            onChange={(e) => setInitialStock(e.target.value)}
            inputMode="numeric"
            data-testid="initial-stock"
          />
        </label>
      )}
      <p className="text-sm text-stone-600" data-testid="profit-preview">
        {profit !== null ? t("itemsProfitPerUnit", { profit }) : "…"}
      </p>
      {error && (
        <p className="text-sm text-red-600" data-testid="form-error">
          {error}
        </p>
      )}
      <button className="rounded-lg bg-stone-900 py-2 text-white" type="submit" data-testid="item-save">
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
          <th className="p-3">{t("itemsBarcode")}</th>
          <th className="p-3">{t("itemsCategory")}</th>
          <th className="p-3">{t("itemsCost")}</th>
          <th className="p-3">{t("itemsSell")}</th>
          <th className="p-3">{t("itemsProfitPerUnit", { profit: "" })}</th>
          <th className="p-3">{t("dashboardItemsCount")}</th>
          <th className="p-3" />
        </tr>
      </thead>
      <tbody>
        {items.data?.items.map((item: Item) => (
          <tr key={item.id} className="border-b last:border-0">
            <td className="p-3">{item.name}</td>
            <td className="p-3">
              {item.barcode ? (
                <span dir="ltr" className="font-mono text-xs">
                  {item.barcode}
                </span>
              ) : (
                "—"
              )}
            </td>
            <td className="p-3">{item.categoryId}</td>
            <td className="p-3">{item.costPrice}</td>
            <td className="p-3">{item.sellingPrice}</td>
            <td className="p-3">{item.sellingPrice - item.costPrice}</td>
            <td className="p-3">
              <span data-testid="stock-after-cell">
                {item.stockOnHand} {item.stockOnHand <= item.lowStockThreshold && <span className="text-xs text-red-600">{t("itemsLowBadge")}</span>}
              </span>
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
