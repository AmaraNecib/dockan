import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Link } from "@tanstack/react-router";
import type { ItemListItem, ItemCreate } from "@dokan/contracts";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Amount } from "@/components/ui/amount";

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
  /** scan feedback carries a tone: found/deferred are ok, lookup errors render red */
  const [notice, setNotice] = useState<{ text: string; tone: "ok" | "error" } | null>(null);

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
      setNotice({ text: t("scanLookupError"), tone: "error" });
      return;
    }
    if (seq !== scanSeqRef.current) return; // a newer scan superseded this one
    if (result.exact !== null) {
      setNotice({ text: t("scanFoundItem", { name: result.exact.item.name }), tone: "ok" });
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
        <p
          className={
            notice.tone === "error"
              ? "mt-2 rounded border border-destructive/20 bg-destructive/10 p-2 text-sm text-destructive"
              : "mt-2 rounded border bg-green-500/10 p-2 text-sm text-green-700"
          }
          data-testid={notice.tone === "error" ? "scan-error" : "scan-found"}
          role="status"
          aria-live="polite"
        >
          {notice.text}
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
            setNotice({ text: t("scanDeferredToast"), tone: "ok" });
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
    <div className="mt-4 rounded border bg-card p-3">
      <input
        className="w-full rounded border px-3 py-2"
        placeholder={t("itemsSearchPlaceholder")}
        aria-label={t("itemsSearchPlaceholder")}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        data-testid="catalog-search"
      />
      {search.isError && (
        <div className="mt-2 flex items-center justify-between rounded border bg-destructive/10 p-2 text-sm text-destructive">
          <span>{t("itemsSearchError")}</span>
          <button type="button" className="underline" onClick={() => void search.refetch()}>
            {t("itemsSearchRetry")}
          </button>
        </div>
      )}
      {debounced.length > 0 && !search.isError && (
        <ul className="mt-2" data-testid="search-results">
          {search.data?.exact && (
            <li className="flex items-center justify-between rounded bg-accent p-2 font-semibold">
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
                  <span dir="ltr" className="font-mono text-xs text-muted-foreground">
                    {match.item.barcode}
                  </span>
                )}
                <span className="rounded bg-muted px-2 py-0.5 text-xs text-muted-foreground">{t(matchBadgeKey(match.matchedBy))}</span>
              </span>
            </li>
          ))}
          {debounced.length > 0 && !search.isPending && !search.isError && !search.data?.exact && (search.data?.matches.length ?? 0) === 0 && (
            <li className="p-2 text-sm text-muted-foreground">{t("itemsSearchEmpty")}</li>
          )}
        </ul>
      )}
      <button type="button" className="mt-2 text-sm text-muted-foreground underline" onClick={() => setPickerOpen(true)} data-testid="open-picker">
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

  // Submit falls back to the first category when none was picked, so surface
  // that same choice in the trigger: the operator must always see the category
  // the item will be filed under (greptile PR #80).
  const selectedCategoryId = categoryId || categories.data?.items[0]?.id || "";

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
    if (!selectedCategoryId) {
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
      categoryId: selectedCategoryId,
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
    <form className="mt-4 grid gap-3 rounded border bg-card p-4" onSubmit={submit}>
      <label className="grid gap-1">
        {t("itemsName")}
        <input className="rounded border px-3 py-2" value={name} onChange={(e) => setName(e.target.value)} required data-testid="item-name" />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="grid gap-1">
          {t("itemsCategory")}
          <Select
            value={selectedCategoryId}
            onValueChange={(value) => setCategoryId(value ?? "")}
            items={categories.data?.items.map((category) => ({ value: category.id, label: category.name })) ?? []}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder={categories.data?.items.length === 0 ? t("itemsChooseCategory") : undefined} />
            </SelectTrigger>
            <SelectContent>
              {categories.data?.items.map((category) => (
                <SelectItem key={category.id} value={category.id}>
                  {category.name}
                </SelectItem>
              ))}
              {categories.data?.items.length === 0 && <SelectItem value="">{t("itemsChooseCategory")}</SelectItem>}
            </SelectContent>
          </Select>
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
      <p className="text-sm text-muted-foreground" data-testid="profit-preview">
        {profit !== null ? t("itemsProfitPerUnit", { profit }) : "…"}
      </p>
      {error && (
        <p className="text-sm text-destructive" data-testid="form-error">
          {error}
        </p>
      )}
      <button className="rounded-lg bg-primary py-2 text-primary-foreground" type="submit" data-testid="item-save">
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
      <div className="mt-6 grid gap-3 rounded border bg-card p-3">
        {[0, 1, 2, 3].map((row) => (
          <Skeleton key={row} className="h-6 w-full" />
        ))}
      </div>
    );
  }

  if (items.data.items.length === 0) {
    return <p className="mt-6 rounded border bg-card p-3 text-muted-foreground">{t("itemsEmpty")}</p>;
  }

  return (
    <table className="mt-6 w-full rounded border bg-card">
      <thead>
        <tr className="border-b text-right text-sm text-muted-foreground">
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
        {items.data?.items.map((item: ItemListItem) => (
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
            <td className="p-3">{item.categoryName ?? "—"}</td>
            <td className="p-3"><Amount value={item.costPrice} /></td>
            <td className="p-3"><Amount value={item.sellingPrice} /></td>
            <td className="p-3"><Amount value={item.sellingPrice - item.costPrice} /></td>
            <td className="p-3">
              <span data-testid="stock-after-cell">
                {item.stockOnHand} {item.stockOnHand <= item.lowStockThreshold && <span className="text-xs text-destructive">{t("itemsLowBadge")}</span>}
              </span>
            </td>
            <td className="p-3">
              <Link to="/items/$itemId/history" params={{ itemId: item.id }} className="text-muted-foreground underline hover:text-foreground">
                {t("historyLink")}
              </Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
