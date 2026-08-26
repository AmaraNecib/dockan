import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { InvoiceCreate, Item } from "@dokan/contracts";

import { ItemPickerDialog } from "@/components/catalog/item-picker-dialog";
import { UnknownScanDialog } from "@/components/catalog/unknown-scan-dialog";

import { useBarcodeScanner } from "../lib/use-barcode-scanner";
import { orpc, rpcClient } from "../lib/rpc";
import { tError } from "../lib/i18n";

type OverrideType = "" | "AMOUNT" | "PERCENTAGE";
type DiscountType = "" | "AMOUNT" | "PERCENTAGE";
type SaleLine = {
  item: Item;
  /** raw quantity input text; empty is a valid transient draft while typing */
  quantityDraft: string;
  overrideType: OverrideType;
  overrideValue: string;
};

type QuickAddMode = "EMPTY" | "STOCK";

function nonNegativeOr(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function toOverrideType(value: string): OverrideType {
  return value === "AMOUNT" || value === "PERCENTAGE" ? value : "";
}

function toDiscountType(value: string): DiscountType {
  return value === "AMOUNT" || value === "PERCENTAGE" ? value : "";
}

/**
 * Resolve a cart quantity draft to its effective line quantity. Empty,
 * non-integer, or over-cap drafts yield 0 (invalid); the input never rewrites
 * the draft, so clearing it stays visually empty instead of snapping back to
 * the previous value (the field is NOT a controlled number). The 1_000_000
 * cap mirrors the RPC contract's line-quantity max — an oversized draft is
 * refused client-side instead of surfacing an opaque server error. Only an
 * explicit add-line action (scan / duplicate picker entry) repairs a cleared
 * draft to a single unit.
 */
const MAX_LINE_QUANTITY = 1_000_000;

export function parseQuantityDraft(draft: string): number {
  const trimmed = draft.trim();
  if (trimmed === "" || !/^\d+$/u.test(trimmed)) return 0;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) && value >= 1 && value <= MAX_LINE_QUANTITY ? value : 0;
}

/** True when the draft cannot form a sellable line (empty, zero, or garbage). */
export function quantityDraftInvalid(draft: string): boolean {
  return parseQuantityDraft(draft) < 1;
}

function actualPrice(line: SaleLine): number {
  const value = nonNegativeOr(line.overrideValue, line.item.sellingPrice);
  if (line.overrideValue.trim() === "") return line.item.sellingPrice;
  if (line.overrideType === "AMOUNT") return Math.round(value);
  if (line.overrideType === "PERCENTAGE") return Math.round((line.item.sellingPrice * value) / 100);
  return line.item.sellingPrice;
}

/** A chosen price override must carry a usable value: empty input parses to 0
 * (Number("") === 0) and would bill the line as free while the preview still
 * shows the default price, so it is rejected here before submission. */
export function overrideInputInvalid(line: Pick<SaleLine, "overrideType" | "overrideValue">): boolean {
  if (line.overrideType === "") return false;
  if (line.overrideValue.trim() === "") return true;
  const value = Number(line.overrideValue);
  if (!Number.isFinite(value)) return true;
  if (line.overrideType === "AMOUNT") return !Number.isInteger(value) || value < 0;
  return !Number.isInteger(value) || value < 0 || value > 100;
}

export function SalePage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const categories = useQuery(orpc.categoriesList.queryOptions());
  const [pickerOpen, setPickerOpen] = useState(false);
  const [unknownCode, setUnknownCode] = useState<string | null>(null);
  const [lines, setLines] = useState<SaleLine[]>([]);
  const [customer, setCustomer] = useState("");
  const [discountType, setDiscountType] = useState<DiscountType>("");
  const [discountValue, setDiscountValue] = useState("");
  const [paidNow, setPaidNow] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savedNumber, setSavedNumber] = useState<string | null>(null);

  const [quickMode, setQuickMode] = useState<QuickAddMode | null>(null);
  const [quickName, setQuickName] = useState("");
  const [quickBarcode, setQuickBarcode] = useState("");
  const [quickCategoryId, setQuickCategoryId] = useState("");
  const [quickCost, setQuickCost] = useState("");
  const [quickSell, setQuickSell] = useState("");
  const [quickStock, setQuickStock] = useState("1");
  // Only the newest lookup may open the unknown-scan choice or add a line;
  // this prevents a slow older response from overwriting a later scan.
  const scanSeqRef = useRef(0);

  const addLine = (item: Item) => {
    setLines((current) => {
      const existing = current.find((line) => line.item.id === item.id);
      if (existing) {
        // a scanned/added unit bumps the effective quantity by one, repairing
        // an invalid (cleared) draft to a single unit
        return current.map((line) => (line.item.id === item.id ? { ...line, quantityDraft: String(parseQuantityDraft(line.quantityDraft) + 1) } : line));
      }
      return [...current, { item, quantityDraft: "1", overrideType: "", overrideValue: "" }];
    });
    setPickerOpen(false);
  };

  async function handleScan(code: string) {
    const seq = ++scanSeqRef.current;
    setError(null);
    try {
      const result = await rpcClient.catalogSearch({ query: code });
      if (seq !== scanSeqRef.current) return;
      if (result.exact !== null) {
        addLine(result.exact.item);
        return;
      }
      setUnknownCode(code);
    } catch (err) {
      if (seq !== scanSeqRef.current) return;
      setError(tError(err instanceof Error ? err.message : "UNEXPECTED"));
    }
  }
  useBarcodeScanner((code) => void handleScan(code));

  const createItem = useMutation(orpc.itemsCreate.mutationOptions());
  const createWithStock = useMutation(orpc.itemsCreateWithStock.mutationOptions());
  const createInvoice = useMutation(
    orpc.invoicesCreate.mutationOptions({
      onSuccess: (invoice) => {
        setSavedNumber(invoice.invoiceNumber);
        setLines([]);
        setCustomer("");
        setDiscountType("");
        setDiscountValue("");
        setPaidNow("");
        setError(null);
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.itemsList.queryKey() }),
          queryClient.invalidateQueries({ queryKey: orpc.itemsLowStock.queryKey() }),
        ]);
      },
      onError: (err) => setError(tError(err.message)),
    }),
  );

  const subtotal = lines.reduce((sum, line) => sum + parseQuantityDraft(line.quantityDraft) * actualPrice(line), 0);
  const enteredDiscount = nonNegativeOr(discountValue, 0);
  const discountAmount = discountType === "AMOUNT" ? Math.min(enteredDiscount, subtotal) : discountType === "PERCENTAGE" ? Math.min(Math.round((subtotal * enteredDiscount) / 100), subtotal) : 0;
  const total = subtotal - discountAmount;

  function submit() {
    setError(null);
    if (lines.length === 0) {
      setError(t("saleLinesEmpty"));
      return;
    }
    const paid = paidNow === "" ? undefined : Number(paidNow);
    if (paid !== undefined && (!Number.isInteger(paid) || paid < 0)) {
      setError(t("saleInvalidPaid"));
      return;
    }
    if (discountType !== "") {
      const parsedDiscount = Number(discountValue);
      const invalidAmount = discountType === "AMOUNT" && (!Number.isInteger(parsedDiscount) || parsedDiscount < 0);
      const invalidPercentage = discountType === "PERCENTAGE" && (!Number.isInteger(parsedDiscount) || parsedDiscount < 0 || parsedDiscount > 100);
      if (!Number.isFinite(parsedDiscount) || invalidAmount || invalidPercentage) {
        setError(t("saleInvalidDiscount"));
        return;
      }
    }
    for (const line of lines) {
      if (overrideInputInvalid(line)) {
        setError(t("saleInvalidOverride"));
        return;
      }
      if (quantityDraftInvalid(line.quantityDraft)) {
        setError(t("saleInvalidQuantity"));
        return;
      }
    }
    const invoiceLines = lines.map((line) => {
      const invoiceLine: InvoiceCreate["lines"][number] = {
        itemId: line.item.id,
        quantity: parseQuantityDraft(line.quantityDraft),
      };
      if (line.overrideType !== "") {
        invoiceLine.priceOverride = { type: line.overrideType, value: Number(line.overrideValue) };
      }
      return invoiceLine;
    });
    const invoiceInput: InvoiceCreate = {
      kind: "SALE",
      counterpartyName: customer.trim() === "" ? undefined : customer.trim(),
      initialPaid: paid === 0 ? undefined : paid,
      lines: invoiceLines,
    };
    if (discountType !== "") invoiceInput.discount = { type: discountType, value: enteredDiscount };
    void createInvoice.mutate(invoiceInput);
  }

  function openQuick(mode: QuickAddMode, code = "") {
    setQuickMode(mode);
    setQuickBarcode(code);
    setQuickCategoryId(categories.data?.items[0]?.id ?? "");
    setQuickStock("1");
    setQuickCost("");
    setQuickSell("");
    setQuickName("");
  }

  function quickSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const categoryId = quickCategoryId || categories.data?.items[0]?.id;
    const cost = Number(quickCost);
    const sell = Number(quickSell);
    const stock = Number(quickStock);
    if (!categoryId) {
      setError(t("itemsChooseCategory"));
      return;
    }
    if (quickName.trim() === "" || !Number.isInteger(cost) || cost < 0 || !Number.isInteger(sell) || sell < 0) {
      setError(t("saleQuickInvalid"));
      return;
    }
    if (quickMode === "STOCK" && (!Number.isInteger(stock) || stock < 1)) {
      setError(t("scanStockInvalid"));
      return;
    }
    const input = {
      name: quickName.trim(),
      categoryId,
      costPrice: cost,
      sellingPrice: sell,
      barcode: quickBarcode.trim() === "" ? undefined : quickBarcode.trim(),
    };
    if (quickMode === "STOCK") {
      void createWithStock.mutate(
        { ...input, stockOnHand: stock },
        { onSuccess: (item) => { addLine(item); setQuickMode(null); }, onError: (err) => setError(tError(err.message)) },
      );
    } else {
      void createItem.mutate(input, { onSuccess: (item) => { addLine(item); setQuickMode(null); }, onError: (err) => setError(tError(err.message)) });
    }
  }

  if (savedNumber !== null) {
    return (
      <section data-testid="sale-saved" className="grid gap-4">
        <h1 className="text-xl font-bold">{t("saleTitle")}</h1>
        <div className="rounded border bg-white p-5">
          <p className="font-semibold text-green-700" data-testid="sale-saved-number">{t("saleSaved", { number: savedNumber })}</p>
          <button type="button" className="mt-4 rounded-lg border px-3 py-2" onClick={() => setSavedNumber(null)}>{t("saleNew")}</button>
        </div>
      </section>
    );
  }

  return (
    <section data-testid="sale-form">
      <h1 className="text-xl font-bold">{t("saleTitle")}</h1>
      <div className="mt-4 grid gap-4 rounded border bg-white p-4">
        <div className="grid grid-cols-2 gap-3">
          <label className="grid gap-1">{t("saleCustomer")}<input className="rounded border px-3 py-2" value={customer} onChange={(event) => setCustomer(event.target.value)} data-testid="sale-customer" /></label>
          <label className="grid gap-1">{t("salePaid")}<input className="rounded border px-3 py-2" inputMode="numeric" value={paidNow} onChange={(event) => setPaidNow(event.target.value)} data-testid="sale-paid" /></label>
        </div>
        <div className="flex flex-wrap items-end gap-2">
          <button type="button" className="rounded-lg bg-stone-900 px-3 py-2 text-sm text-white" onClick={() => setPickerOpen(true)} data-testid="sale-open-picker">{t("saleAddItem")}</button>
          <button type="button" className="rounded-lg border px-3 py-2 text-sm" onClick={() => openQuick("EMPTY")} data-testid="sale-quick-add">{t("saleQuickAdd")}</button>
          <button type="button" className="rounded-lg border px-3 py-2 text-sm" onClick={() => openQuick("STOCK")} data-testid="sale-quick-stock-add">{t("saleQuickStockBtn")}</button>
          <span className="text-xs text-stone-500">{t("saleScanHint")}</span>
        </div>

        {quickMode !== null && (
          <form className="grid gap-3 rounded border bg-stone-50 p-3" onSubmit={quickSubmit} data-testid="sale-quick-form">
            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-1">{t("saleQuickName")}<input className="rounded border px-3 py-2" value={quickName} onChange={(event) => setQuickName(event.target.value)} required data-testid="sale-quick-name" /></label>
              <label className="grid gap-1">{t("saleQuickBarcode")}<input dir="ltr" className="rounded border px-3 py-2" value={quickBarcode} onChange={(event) => setQuickBarcode(event.target.value)} data-testid="sale-quick-barcode" /></label>
              <label className="grid gap-1">{t("itemsCategory")}<select className="rounded border px-3 py-2" value={quickCategoryId} onChange={(event) => setQuickCategoryId(event.target.value)}>{categories.data?.items.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
              <label className="grid gap-1">{t("itemsCost")}<input className="rounded border px-3 py-2" inputMode="numeric" value={quickCost} onChange={(event) => setQuickCost(event.target.value)} required /></label>
              <label className="grid gap-1">{t("itemsSell")}<input className="rounded border px-3 py-2" inputMode="numeric" value={quickSell} onChange={(event) => setQuickSell(event.target.value)} required /></label>
              {quickMode === "STOCK" && <label className="grid gap-1">{t("saleQuickStock")}<input className="rounded border px-3 py-2" inputMode="numeric" value={quickStock} onChange={(event) => setQuickStock(event.target.value)} required data-testid="sale-quick-stock" /></label>}
            </div>
            <div className="flex gap-2"><button type="submit" className="rounded-lg bg-stone-900 px-3 py-2 text-white" disabled={createItem.isPending || createWithStock.isPending}>{t("saleQuickSave")}</button><button type="button" className="rounded-lg border px-3 py-2" onClick={() => setQuickMode(null)}>{t("dialogClose")}</button></div>
          </form>
        )}

        {lines.length === 0 ? <p className="text-sm text-stone-500">{t("saleLinesEmpty")}</p> : (
          <table className="w-full" data-testid="sale-lines">
            <thead><tr className="border-b text-right text-sm text-stone-500"><th className="p-2">{t("itemsName")}</th><th className="p-2">{t("saleQuantity")}</th><th className="p-2">{t("saleDefaultPrice")}</th><th className="p-2">{t("saleActualPrice")}</th><th className="p-2">{t("saleLineTotal")}</th><th className="p-2" /></tr></thead>
            <tbody>{lines.map((line, index) => { const price = actualPrice(line); const quantity = parseQuantityDraft(line.quantityDraft); return <tr key={line.item.id} className="border-b last:border-0"><td className="p-2">{line.item.name}</td><td className="p-2"><input className="w-16 rounded border px-2 py-1" inputMode="numeric" value={line.quantityDraft} onChange={(event) => setLines((current) => current.map((entry, i) => i === index ? { ...entry, quantityDraft: event.target.value } : entry))} aria-label={`${line.item.name}: ${t("saleQuantity")}`} /></td><td className="p-2">{line.item.sellingPrice}</td><td className="p-2"><div className="flex gap-1"><select className="w-28 rounded border px-1 py-1" value={line.overrideType} onChange={(event) => setLines((current) => current.map((entry, i) => i === index ? { ...entry, overrideType: toOverrideType(event.target.value), overrideValue: "" } : entry))} aria-label={`${line.item.name}: ${t("saleOverrideType")}`}><option value="">{t("saleDefault")}</option><option value="AMOUNT">{t("saleOverrideAmount")}</option><option value="PERCENTAGE">{t("saleOverridePercentage")}</option></select>{line.overrideType !== "" && <input className="w-20 rounded border px-2 py-1" inputMode="numeric" value={line.overrideValue} onChange={(event) => setLines((current) => current.map((entry, i) => i === index ? { ...entry, overrideValue: event.target.value } : entry))} aria-label={`${line.item.name}: ${t("saleOverrideValue")}`} />}</div><span className="text-xs text-stone-500">{price} دج</span></td><td className="p-2">{quantity * price}</td><td className="p-2"><button type="button" className="text-red-600" aria-label={`${t("saleRemove")} ${line.item.name}`} onClick={() => setLines((current) => current.filter((_, i) => i !== index))}>✕</button></td></tr>; })}</tbody>
          </table>
        )}
      </div>

      <div className="mt-4 grid gap-3 rounded border bg-white p-4">
        <h2 className="font-semibold">{t("saleTotalsTitle")}</h2>
        <div className="grid grid-cols-2 gap-3"><label className="grid gap-1">{t("saleDiscountType")}<select className="rounded border px-3 py-2" value={discountType} onChange={(event) => setDiscountType(toDiscountType(event.target.value))} data-testid="sale-discount-type"><option value="">{t("saleNoDiscount")}</option><option value="AMOUNT">{t("saleDiscountAmount")}</option><option value="PERCENTAGE">{t("saleDiscountPercentage")}</option></select></label><label className="grid gap-1">{t("saleDiscountValue")}<input className="rounded border px-3 py-2" inputMode="numeric" value={discountValue} onChange={(event) => setDiscountValue(event.target.value)} disabled={discountType === ""} data-testid="sale-discount-value" /></label></div>
        <dl className="grid gap-1 text-left"><div className="flex justify-between"><dt>{t("saleSubtotal")}</dt><dd data-testid="sale-subtotal">{subtotal} دج</dd></div><div className="flex justify-between"><dt>{t("saleDiscount")}</dt><dd data-testid="sale-discount">{discountAmount > 0 ? `-${discountAmount}` : "0"} دج</dd></div><div className="flex justify-between border-t pt-2 text-lg font-bold"><dt>{t("saleTotal")}</dt><dd data-testid="sale-total">{total} دج</dd></div></dl>
      </div>
      {error && <p className="mt-3 rounded border border-red-200 bg-red-50 p-2 text-sm text-red-700" data-testid="sale-error" role="alert">{error}</p>}
      <button type="button" className="mt-4 w-full rounded-lg bg-stone-900 py-2 text-white disabled:opacity-50" onClick={submit} disabled={createInvoice.isPending} data-testid="sale-save">{t("saleSave")}</button>

      <ItemPickerDialog open={pickerOpen} onClose={() => setPickerOpen(false)} onSelect={addLine} />
      {unknownCode !== null && <UnknownScanDialog code={unknownCode} onClose={() => setUnknownCode(null)} onCreate={() => { setUnknownCode(null); openQuick("EMPTY", unknownCode); }} onCreateWithStock={() => { setUnknownCode(null); openQuick("STOCK", unknownCode); }} onManualLine={() => { setUnknownCode(null); setPickerOpen(true); }} />}
    </section>
  );
}
