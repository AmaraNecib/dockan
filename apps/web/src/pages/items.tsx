import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
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

/** One row at a time is editable; this is its draft shape. */
type ItemEditDraft = {
  id: string;
  name: string;
  categoryId: string;
  cost: string;
  sell: string;
  threshold: string;
};

/** The two jobs on the items page: browse the table, or add item/stock. */
type ItemsTab = "products" | "add";

const ITEMS_TABS: ReadonlyArray<{ id: ItemsTab; labelKey: "itemsTabProducts" | "itemsTabAddStock" }> = [
  { id: "products", labelKey: "itemsTabProducts" },
  { id: "add", labelKey: "itemsTabAddStock" },
];

/** Every list the items page can change: the table, the low-stock badge
 * source, and the dashboard's low-stock panel. */
function invalidateItems(queryClient: QueryClient) {
  void Promise.all([
    queryClient.invalidateQueries({ queryKey: orpc.itemsList.queryKey() }),
    queryClient.invalidateQueries({ queryKey: orpc.itemsLowStock.queryKey() }),
    queryClient.invalidateQueries({ queryKey: orpc.dashboardSummary.queryKey() }),
  ]);
}

export function ItemsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  /** table first: browsing is the default; adding is a deliberate step */
  const [tab, setTab] = useState<ItemsTab>("products");
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

  // Keyboard behaviour for the tablist: arrows move focus AND selection
  // (automatic activation), Home/End jump to the ends. RTL users get the same
  // result from either horizontal arrow on a two-tab set.
  function onTabKeyDown(event: React.KeyboardEvent, index: number) {
    let next = index;
    if (event.key === "ArrowRight") next = (index + 1) % ITEMS_TABS.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + ITEMS_TABS.length) % ITEMS_TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = ITEMS_TABS.length - 1;
    else return;
    event.preventDefault();
    const target = ITEMS_TABS[next];
    if (target === undefined) return;
    setTab(target.id);
    document.getElementById(`items-tab-${target.id}`)?.focus();
  }

  function openAddTab(seed: { barcode: string; withStock: boolean }) {
    setFormSeed(seed);
    setTab("add");
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

      <div role="tablist" aria-label={t("itemsTabsLabel")} className="mt-4 flex gap-1 border-b border-border">
        {ITEMS_TABS.map((entry, index) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            id={`items-tab-${entry.id}`}
            aria-selected={tab === entry.id}
            aria-controls={`items-panel-${entry.id}`}
            tabIndex={tab === entry.id ? 0 : -1}
            onClick={() => setTab(entry.id)}
            onKeyDown={(event) => onTabKeyDown(event, index)}
            data-testid={`items-tab-${entry.id}`}
            className={
              tab === entry.id
                ? "-mb-px rounded-t border-b-2 border-primary px-3 py-2 text-sm font-medium text-foreground transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                : "-mb-px rounded-t border-b-2 border-transparent px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            }
          >
            {t(entry.labelKey)}
          </button>
        ))}
      </div>

      <div role="tabpanel" id="items-panel-products" aria-labelledby="items-tab-products" hidden={tab !== "products"}>
        <CatalogSearch />
        <ItemList />
      </div>
      <div role="tabpanel" id="items-panel-add" aria-labelledby="items-tab-add" hidden={tab !== "add"}>
        <ItemForm seed={formSeed} onSeedConsumed={() => setFormSeed(null)} onSaved={() => invalidateItems(queryClient)} />
        <StockForm />
      </div>

      {unknownCode !== null && (
        <UnknownScanDialog
          code={unknownCode}
          onClose={() => setUnknownCode(null)}
          onCreate={() => {
            openAddTab({ barcode: unknownCode, withStock: false });
            setUnknownCode(null);
          }}
          onCreateWithStock={() => {
            openAddTab({ barcode: unknownCode, withStock: true });
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
  const categories = useQuery(orpc.categoriesList.queryOptions());
  const [name, setName] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [cost, setCost] = useState("");
  const [sell, setSell] = useState("");
  const [threshold, setThreshold] = useState("5");
  const [barcode, setBarcode] = useState("");
  const [initialStock, setInitialStock] = useState("");
  const [error, setError] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const initialStockRef = useRef<HTMLInputElement>(null);

  // Submit falls back to the first category when none was picked, so surface
  // that same choice in the trigger: the operator must always see the category
  // the item will be filed under (greptile PR #80).
  const selectedCategoryId = categoryId || categories.data?.items[0]?.id || "";

  // prefill from an unknown-scan choice; "create with stock" only focuses the
  // (now always-visible) quantity field — it never gates or forces it
  useEffect(() => {
    if (seed !== null) {
      setBarcode(seed.barcode);
      // a fresh scan must not inherit a quantity typed for a previous item
      setInitialStock("");
      setError(null);
      if (seed.withStock) initialStockRef.current?.focus();
      else nameRef.current?.focus();
    }
  }, [seed]);

  function invalidate() {
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
  const busy = create.isPending || createWithStock.isPending;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const sellText = sell.trim();
    const selling = Number(sellText);
    if (sellText === "" || !Number.isInteger(selling) || selling <= 0) {
      setError(t("itemsSellAboveCost"));
      return;
    }
    if (!selectedCategoryId) {
      setError(t("itemsChooseCategory"));
      return;
    }
    // a typo must not silently save a money value as zero
    const costText = cost.trim();
    const parsedCost = Number(costText);
    if (costText === "" || !Number.isInteger(parsedCost) || parsedCost < 0) {
      setError(t("itemsCostInvalid"));
      return;
    }
    const thresholdText = threshold.trim();
    const parsedThreshold = thresholdText === "" ? 5 : Number(thresholdText);
    if (!Number.isInteger(parsedThreshold) || parsedThreshold < 0) {
      setError(t("itemsThresholdInvalid"));
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
    // empty means zero (a deliberate "not counted yet"), so only a positive
    // whole number takes the one-step create-with-stock path
    const stockText = initialStock.trim();
    const stock = Number(stockText);
    if (stockText !== "" && (!Number.isInteger(stock) || stock < 0)) {
      setError(t("itemsStockInvalid"));
      return;
    }
    const base: ItemCreate = {
      name,
      categoryId: selectedCategoryId,
      costPrice: parsedCost,
      sellingPrice: selling,
      lowStockThreshold: parsedThreshold,
    };
    if (normalizedBarcode !== undefined) base.barcode = normalizedBarcode;
    if (stockText !== "" && stock > 0) void createWithStock.mutate({ ...base, stockOnHand: stock });
    else void create.mutate(base);
  }

  return (
    <form className="mt-4 grid gap-3 rounded border bg-card p-4" onSubmit={submit} data-testid="item-form">
      <h2 className="font-semibold">{t("itemsNewTitle")}</h2>
      <label className="grid gap-1">
        {t("itemsName")}
        <input ref={nameRef} className="rounded border px-3 py-2" name="itemName" autoComplete="off" value={name} onChange={(e) => setName(e.target.value)} required data-testid="item-name" />
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
            name="itemBarcode"
            autoComplete="off"
            spellCheck={false}
            value={barcode}
            onChange={(e) => setBarcode(e.target.value)}
            data-testid="item-barcode"
          />
        </label>
      </div>
      <div className="grid grid-cols-3 gap-3">
        <label className="grid gap-1">
          {t("itemsCost")}
          <input className="rounded border px-3 py-2" name="itemCost" autoComplete="off" value={cost} onChange={(e) => setCost(e.target.value)} inputMode="numeric" required data-testid="item-cost" />
        </label>
        <label className="grid gap-1">
          {t("itemsSell")}
          <input className="rounded border px-3 py-2" name="itemSell" autoComplete="off" value={sell} onChange={(e) => setSell(e.target.value)} inputMode="numeric" required data-testid="item-sell" />
        </label>
        <label className="grid gap-1">
          {t("itemsThreshold")}
          <input className="rounded border px-3 py-2" name="itemThreshold" autoComplete="off" value={threshold} onChange={(e) => setThreshold(e.target.value)} inputMode="numeric" />
        </label>
      </div>
      <label className="grid gap-1">
        {t("scanStockInitial")}
        <input
          ref={initialStockRef}
          className="rounded border px-3 py-2"
          name="itemInitialStock"
          autoComplete="off"
          value={initialStock}
          onChange={(e) => setInitialStock(e.target.value)}
          inputMode="numeric"
          data-testid="initial-stock"
        />
      </label>
      <p className="text-sm text-muted-foreground" data-testid="profit-preview">
        {profit !== null ? t("itemsProfitPerUnit", { profit }) : "…"}
      </p>
      {error && (
        <p className="text-sm text-destructive" role="alert" data-testid="form-error">
          {error}
        </p>
      )}
      <button
        className="rounded-lg bg-primary py-2 text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
        type="submit"
        disabled={busy}
        data-testid="item-save"
      >
        {busy ? t("itemsSaving") : t("itemsSave")}
      </button>
    </form>
  );
}

function ItemList() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const items = useQuery(orpc.itemsList.queryOptions());
  const categories = useQuery(orpc.categoriesList.queryOptions());
  const [draft, setDraft] = useState<ItemEditDraft | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  /** the row whose edit control regains focus once editing ends */
  const editedRowRef = useRef<string | null>(null);

  const update = useMutation(
    orpc.itemsUpdate.mutationOptions({
      // clear only the row this mutation actually saved: if the operator opened
      // another row while it was in flight, that row's draft must survive
      onSuccess: (_data, variables) => {
        setDraft((current) => (current?.id === variables.id ? null : current));
        setEditError(null);
        invalidateItems(queryClient);
      },
      onError: (err) => setEditError(tError(err.message)),
    }),
  );

  // return focus to the row's edit control after save/cancel (WCAG 2.4.3)
  useEffect(() => {
    if (draft === null && editedRowRef.current !== null) {
      const id = editedRowRef.current;
      editedRowRef.current = null;
      document.getElementById(`edit-button-${id}`)?.focus();
    }
  }, [draft]);

  function beginEdit(item: ItemListItem) {
    editedRowRef.current = item.id;
    setEditError(null);
    setDraft({
      id: item.id,
      name: item.name,
      categoryId: item.categoryId,
      cost: String(item.costPrice),
      sell: String(item.sellingPrice),
      threshold: String(item.lowStockThreshold),
    });
  }

  function patchDraft(patch: Partial<ItemEditDraft>) {
    setDraft((current) => (current === null ? null : { ...current, ...patch }));
  }

  function cancelEdit() {
    setDraft(null);
    setEditError(null);
  }

  function saveEdit() {
    if (draft === null) return;
    setEditError(null);
    const sellText = draft.sell.trim();
    const selling = Number(sellText);
    if (draft.name.trim() === "") {
      setEditError(t("itemsNameRequired"));
      return;
    }
    // 0 is legal (items created with a zero price must stay editable), but the
    // field may not be blank or a non-integer
    if (sellText === "" || !Number.isInteger(selling) || selling < 0) {
      setEditError(t("itemsSellInvalid"));
      return;
    }
    if (!draft.categoryId) {
      setEditError(t("itemsChooseCategory"));
      return;
    }
    const costText = draft.cost.trim();
    const thresholdText = draft.threshold.trim();
    const parsedCost = Number(costText);
    const parsedThreshold = Number(thresholdText);
    // a typo must not silently rewrite a money value or the warn-at quantity
    if (costText !== "" && (!Number.isInteger(parsedCost) || parsedCost < 0)) {
      setEditError(t("itemsCostInvalid"));
      return;
    }
    if (thresholdText !== "" && (!Number.isInteger(parsedThreshold) || parsedThreshold < 0)) {
      setEditError(t("itemsThresholdInvalid"));
      return;
    }
    update.mutate({
      id: draft.id,
      name: draft.name.trim(),
      categoryId: draft.categoryId,
      // blank means a deliberate zero (a free item, or warn-at-zero)
      costPrice: costText === "" ? 0 : parsedCost,
      sellingPrice: selling,
      lowStockThreshold: thresholdText === "" ? 0 : parsedThreshold,
    });
  }

  /** Enter anywhere in the row submits, like the create form. */
  function onEditKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Enter") {
      event.preventDefault();
      saveEdit();
    }
  }

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
    <>
      {editError && (
        <p className="mt-4 rounded border border-destructive/20 bg-destructive/10 p-2 text-sm text-destructive" role="alert" data-testid="items-edit-error">
          {editError}
        </p>
      )}
      <div className="mt-6 w-full overflow-x-auto rounded border bg-card">
      <table className="w-full">
        <thead>
          <tr className="border-b text-right text-sm text-muted-foreground">
            <th className="p-3">{t("itemsName")}</th>
            <th className="p-3">{t("itemsBarcode")}</th>
            <th className="p-3">{t("itemsCategory")}</th>
            <th className="p-3">{t("itemsCost")}</th>
            <th className="p-3">{t("itemsSell")}</th>
            <th className="p-3">{t("itemsProfitPerUnit", { profit: "" })}</th>
            <th className="p-3">{t("itemsStock")}</th>
            <th className="p-3">{t("itemsThreshold")}</th>
            <th className="p-3" />
          </tr>
        </thead>
        <tbody>
          {items.data?.items.map((item: ItemListItem) => {
            const editing = draft !== null && draft.id === item.id;
            const draftProfit = editing ? profitPreview(draft.cost, draft.sell) : null;
            return (
              <tr key={item.id} className="border-b last:border-0">
                <td className="p-3">
                  {editing ? (
                    <input
                      className="w-full rounded border px-2 py-1"
                      name="editName"
                      autoComplete="off"
                      value={draft.name}
                      onChange={(e) => patchDraft({ name: e.target.value })}
                      onKeyDown={onEditKeyDown}
                      disabled={update.isPending}
                      aria-label={t("itemsName")}
                      data-testid="edit-name"
                    />
                  ) : (
                    item.name
                  )}
                </td>
                <td className="p-3">
                  {item.barcode ? (
                    <span dir="ltr" className="font-mono text-xs">
                      {item.barcode}
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="p-3">
                  {editing ? (
                    <Select
                      value={draft.categoryId}
                      onValueChange={(value) => patchDraft({ categoryId: value ?? "" })}
                      disabled={update.isPending}
                      items={categories.data?.items.map((category) => ({ value: category.id, label: category.name })) ?? []}
                    >
                      <SelectTrigger className="w-full" size="sm" aria-label={t("itemsCategory")} data-testid="edit-category">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {categories.data?.items.map((category) => (
                          <SelectItem key={category.id} value={category.id}>
                            {category.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    item.categoryName ?? "—"
                  )}
                </td>
                <td className="p-3">
                  {editing ? (
                    <input
                      className="w-24 rounded border px-2 py-1"
                      name="editCost"
                      autoComplete="off"
                      value={draft.cost}
                      onChange={(e) => patchDraft({ cost: e.target.value })}
                      onKeyDown={onEditKeyDown}
                      disabled={update.isPending}
                      inputMode="numeric"
                      aria-label={t("itemsCost")}
                      data-testid="edit-cost"
                    />
                  ) : (
                    <Amount value={item.costPrice} />
                  )}
                </td>
                <td className="p-3">
                  {editing ? (
                    <input
                      className="w-24 rounded border px-2 py-1"
                      name="editSell"
                      autoComplete="off"
                      value={draft.sell}
                      onChange={(e) => patchDraft({ sell: e.target.value })}
                      onKeyDown={onEditKeyDown}
                      disabled={update.isPending}
                      inputMode="numeric"
                      aria-label={t("itemsSell")}
                      data-testid="edit-sell"
                    />
                  ) : (
                    <Amount value={item.sellingPrice} />
                  )}
                </td>
                <td className="p-3">
                  {editing ? (
                    draftProfit !== null ? <Amount value={draftProfit} /> : "…"
                  ) : (
                    <Amount value={item.sellingPrice - item.costPrice} />
                  )}
                </td>
                <td className="p-3">
                  <span data-testid="stock-after-cell">
                    {item.stockOnHand} {item.stockOnHand <= item.lowStockThreshold && <span className="text-xs text-destructive">{t("itemsLowBadge")}</span>}
                  </span>
                </td>
                <td className="p-3">
                  {editing ? (
                    <input
                      className="w-20 rounded border px-2 py-1"
                      name="editThreshold"
                      autoComplete="off"
                      value={draft.threshold}
                      onChange={(e) => patchDraft({ threshold: e.target.value })}
                      onKeyDown={onEditKeyDown}
                      disabled={update.isPending}
                      inputMode="numeric"
                      aria-label={t("itemsThreshold")}
                      data-testid="edit-threshold"
                    />
                  ) : (
                    item.lowStockThreshold
                  )}
                </td>
                <td className="p-3">
                  {editing ? (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className="rounded-lg bg-primary px-3 py-1.5 text-sm text-primary-foreground transition-colors hover:bg-primary/80 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
                        onClick={saveEdit}
                        disabled={update.isPending}
                        data-testid="edit-save"
                      >
                        {update.isPending ? t("itemsSaving") : t("itemsSave")}
                      </button>
                      <button
                        type="button"
                        className="rounded-lg border px-3 py-1.5 text-sm transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
                        onClick={cancelEdit}
                        disabled={update.isPending}
                        data-testid="edit-cancel"
                      >
                        {t("itemsCancel")}
                      </button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-3">
                      <button
                        type="button"
                        id={`edit-button-${item.id}`}
                        className="rounded text-muted-foreground underline transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
                        onClick={() => beginEdit(item)}
                        disabled={update.isPending}
                        data-testid={`edit-item-${item.id}`}
                      >
                        {t("itemsEdit")}
                      </button>
                      <Link to="/items/$itemId/history" params={{ itemId: item.id }} className="text-muted-foreground underline hover:text-foreground">
                        {t("historyLink")}
                      </Link>
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      </div>
    </>
  );
}
