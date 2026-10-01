import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Link } from "@tanstack/react-router";
import type { ItemListItem, ItemCreate, ItemUpdate } from "@dokan/contracts";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Amount } from "@/components/ui/amount";

import { orpc, rpcClient } from "../lib/rpc";
import { tError } from "../lib/i18n";
import { normalizeBarcode } from "@dokan/contracts";
import { parseWholeNumber, resolveOpeningStock } from "../lib/numeric-input";
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
  /** the row as loaded, so save can send only the fields that changed */
  baseline: { name: string; categoryId: string; costPrice: number; sellingPrice: number; lowStockThreshold: number };
};

/** The two jobs on the items page: browse the table, or add item/stock. */
type ItemsTab = "products" | "add";

const ITEMS_TABS: ReadonlyArray<{ id: ItemsTab; labelKey: "itemsTabProducts" | "itemsTabAddStock" }> = [
  { id: "products", labelKey: "itemsTabProducts" },
  { id: "add", labelKey: "itemsTabAddStock" },
];

/** Every list the items page can change: the table, the low-stock badge source,
 * the catalog search the picker reads, and the dashboard panel. Invalidation is
 * app-wide on purpose — this is a local-first app with a handful of active
 * queries, and a missed key shows a stale price on some other screen. */
function invalidateItems(queryClient: QueryClient) {
  void queryClient.invalidateQueries();
}

export function ItemsPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();

  /** table first: browsing is the default; adding is a deliberate step */
  const [tab, setTab] = useState<ItemsTab>("products");
  /** what the item form gets prefilled with after an unknown-scan choice */
  const [formSeed, setFormSeed] = useState<{ barcode: string; withStock: boolean } | null>(null);
  const [unknownCode, setUnknownCode] = useState<string | null>(null);
  /** bumps on every committed scan: an edit draft open at scan time is stale */
  const [scanNonce, setScanNonce] = useState(0);
  /** scan feedback carries a tone: found/deferred are ok, lookup errors render red */
  const [notice, setNotice] = useState<{ text: string; tone: "ok" | "error" } | null>(null);

  // serializes scan lookups by recency: only the NEWEST scan may write state.
  // Without this, an older slow lookup that settles after a newer fast one can
  // overwrite its notice or open the unknown-scan dialog with the wrong code.
  const scanSeqRef = useRef(0);

  // window-level wedge capture: works without any input focus
  async function handleScan(code: string) {
    const seq = ++scanSeqRef.current;
    // the wedge's keystrokes land in whatever field has focus, so an open edit
    // row is polluted the moment a scan commits
    setScanNonce((current) => current + 1);
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

  /** A scan seed (and the required-stock mode it carries) belongs to the add
   * session that opened it: leaving the tab ends it, so a return through the
   * tab button is a fresh, plain add. */
  function selectTab(next: ItemsTab) {
    if (next !== "add") setFormSeed(null);
    setTab(next);
  }

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
    selectTab(target.id);
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
              : "mt-2 rounded border bg-success/10 p-2 text-sm text-success"
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
            onClick={() => selectTab(entry.id)}
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
        <ItemList scanNonce={scanNonce} />
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
  // The unknown-scan "create with stock" choice promises an opening movement,
  // so while this form carries that seed a blank/zero quantity is refused; the
  // plain add form (no seed) keeps blank = no opening stock.
  const stockRequired = seed?.withStock === true;

  // prefill from an unknown-scan choice; "create with stock" focuses the
  // (always-visible) quantity field and makes it required for this seed
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
    const selling = parseWholeNumber(sellText);
    if (selling === null || selling <= 0) {
      setError(t("itemsSellAboveCost"));
      return;
    }
    if (!selectedCategoryId) {
      setError(t("itemsChooseCategory"));
      return;
    }
    // a typo must not silently save a money value as zero
    const costText = cost.trim();
    const parsedCost = parseWholeNumber(costText);
    if (parsedCost === null) {
      setError(t("itemsCostInvalid"));
      return;
    }
    const thresholdText = threshold.trim();
    const parsedThreshold = thresholdText === "" ? 5 : parseWholeNumber(thresholdText);
    if (parsedThreshold === null) {
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
    // the plain form reads blank and 0 as a deliberate "not counted yet"; the
    // scan's create-with-stock seed requires a positive count — the resolver
    // owns that rule, the messages stay here
    const stock = resolveOpeningStock(initialStock, stockRequired);
    if (!stock.ok) {
      setError(t(stock.reason === "required" ? "scanStockRequired" : "itemsStockInvalid"));
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
    if (stock.value > 0) void createWithStock.mutate({ ...base, stockOnHand: stock.value });
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

function ItemList({ scanNonce }: { scanNonce: number }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const items = useQuery(orpc.itemsList.queryOptions());
  const categories = useQuery(orpc.categoriesList.queryOptions());
  const [draft, setDraft] = useState<ItemEditDraft | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  /** a save that had nothing to write: distinct from a save that failed */
  const [unchanged, setUnchanged] = useState(false);
  /** the row whose edit control regains focus once editing ends */
  const editedRowRef = useRef<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  const update = useMutation(
    orpc.itemsUpdate.mutationOptions({
      // clear only the row this mutation actually saved: if the operator opened
      // another row while it was in flight, that row's draft must survive
      onSuccess: (_data, variables) => {
        setDraft((current) => (current?.id === variables.id ? null : current));
        setEditError(null);
        setUnchanged(false);
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

  // keyboard entry: opening the editor moves focus into its first field, so
  // the operator can type straight away instead of hunting for the inputs
  const editingId = draft?.id ?? null;
  useEffect(() => {
    if (editingId === null) return;
    nameInputRef.current?.focus();
  }, [editingId]);

  // a background refetch can move a row's prices under an open draft; keep the
  // untouched fields (and the diff baseline) in step with what the row shows
  useEffect(() => {
    if (editingId === null) return;
    const row = items.data?.items.find((item) => item.id === editingId);
    if (row === undefined) return;
    setDraft((current) => {
      if (current === null || current.id !== row.id) return current;
      return {
        ...current,
        baseline: {
          name: row.name,
          categoryId: row.categoryId,
          costPrice: row.costPrice,
          sellingPrice: row.sellingPrice,
          lowStockThreshold: row.lowStockThreshold,
        },
        name: current.name.trim() === current.baseline.name ? row.name : current.name,
        categoryId: current.categoryId === current.baseline.categoryId ? row.categoryId : current.categoryId,
        cost: current.cost.trim() === String(current.baseline.costPrice) ? String(row.costPrice) : current.cost,
        sell: current.sell.trim() === String(current.baseline.sellingPrice) ? String(row.sellingPrice) : current.sell,
        threshold: current.threshold.trim() === String(current.baseline.lowStockThreshold) ? String(row.lowStockThreshold) : current.threshold,
      };
    });
  }, [items.data, editingId]);

  // a scan types its digits into whatever field has focus, so a draft that was
  // open in an edit field holds barcode characters — close it rather than let
  // it be saved as a name, price, or threshold
  useEffect(() => {
    if (scanNonce === 0) return;
    const active = document.activeElement;
    const polluted = active instanceof HTMLElement && active.closest('[data-editing="true"]') !== null;
    if (polluted) setDraft(null);
  }, [scanNonce]);

  // a dirty draft must not be replaced by clicking another row's control: the
  // operator would lose typed work with no warning
  const draftDirty =
    draft !== null &&
    (draft.name.trim() !== draft.baseline.name ||
      draft.categoryId !== draft.baseline.categoryId ||
      draft.cost.trim() !== String(draft.baseline.costPrice) ||
      draft.sell.trim() !== String(draft.baseline.sellingPrice) ||
      draft.threshold.trim() !== String(draft.baseline.lowStockThreshold));

  function beginEdit(item: ItemListItem) {
    if (draftDirty) return;
    editedRowRef.current = item.id;
    setEditError(null);
    setUnchanged(false);
    setDraft({
      id: item.id,
      name: item.name,
      categoryId: item.categoryId,
      cost: String(item.costPrice),
      sell: String(item.sellingPrice),
      threshold: String(item.lowStockThreshold),
      baseline: {
        name: item.name,
        categoryId: item.categoryId,
        costPrice: item.costPrice,
        sellingPrice: item.sellingPrice,
        lowStockThreshold: item.lowStockThreshold,
      },
    });
  }

  function patchDraft(patch: Partial<ItemEditDraft>) {
    setDraft((current) => (current === null ? null : { ...current, ...patch }));
  }

  function cancelEdit() {
    setDraft(null);
    setEditError(null);
    setUnchanged(false);
  }

  function saveEdit() {
    if (draft === null) return;
    setEditError(null);
    setUnchanged(false);
    const name = draft.name.trim();
    if (name === "") {
      setEditError(t("itemsNameRequired"));
      return;
    }
    // 0 is legal (items created with a zero price must stay editable), but the
    // field may not be blank or a non-integer
    const selling = parseWholeNumber(draft.sell);
    if (selling === null) {
      setEditError(t("itemsSellInvalid"));
      return;
    }
    if (!draft.categoryId) {
      setEditError(t("itemsChooseCategory"));
      return;
    }
    // create rejects a blank cost outright, so edit must too: silently writing
    // 0 moves purchase cost, average cost and profit on a select-all + Enter
    const costPrice = parseWholeNumber(draft.cost);
    if (costPrice === null) {
      setEditError(t("itemsCostInvalid"));
      return;
    }
    const thresholdText = draft.threshold.trim();
    const parsedThreshold = parseWholeNumber(thresholdText);
    if (thresholdText !== "" && parsedThreshold === null) {
      setEditError(t("itemsThresholdInvalid"));
      return;
    }
    // send only what changed: a whole-row write would clobber a value corrected
    // elsewhere while this draft sat open. A blanked threshold means "leave it
    // alone", not "warn at zero" — create's blank default is 5, not 0.
    const patch: ItemUpdate = { id: draft.id };
    let changed = false;
    if (name !== draft.baseline.name) {
      patch.name = name;
      changed = true;
    }
    if (draft.categoryId !== draft.baseline.categoryId) {
      patch.categoryId = draft.categoryId;
      changed = true;
    }
    if (costPrice !== draft.baseline.costPrice) {
      patch.costPrice = costPrice;
      changed = true;
    }
    if (selling !== draft.baseline.sellingPrice) {
      patch.sellingPrice = selling;
      changed = true;
    }
    if (parsedThreshold !== null && parsedThreshold !== draft.baseline.lowStockThreshold) {
      patch.lowStockThreshold = parsedThreshold;
      changed = true;
    }
    // nothing to write: close the row, but say so rather than look like a save
    if (!changed) {
      setDraft(null);
      setUnchanged(true);
      return;
    }
    update.mutate(patch);
  }

  /** Enter anywhere in the row submits, like the create form. */
  function onEditKeyDown(event: React.KeyboardEvent) {
    // never submit mid-IME-composition (Arabic input uses it)
    if (event.nativeEvent.isComposing) return;
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
      {unchanged && (
        <p className="mt-4 rounded border bg-muted p-2 text-sm text-muted-foreground" role="status" data-testid="items-edit-unchanged">
          {t("itemsNoChanges")}
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
              <tr key={item.id} className="border-b last:border-0" data-editing={editing ? "true" : undefined}>
                <td className="p-3">
                  {editing ? (
                    <input
                      ref={nameInputRef}
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
                        disabled={update.isPending || draftDirty}
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
