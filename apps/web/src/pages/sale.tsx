import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScanBarcode, X } from "lucide-react";

import type { InvoiceCreate, Item } from "@dokan/contracts";
import { Amount } from "@/components/ui/amount";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";

import { ItemPickerDialog } from "@/components/catalog/item-picker-dialog";
import { UnknownScanDialog } from "@/components/catalog/unknown-scan-dialog";
import { useSaleDraft } from "@/components/app/sale-draft";

import { useBarcodeScanner } from "../lib/use-barcode-scanner";
import { CheckoutBar } from "../components/app/checkout-bar";
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

/** Whether a pre-commit paid draft is usable, and the debt it leaves. */
export interface SaleDebt {
  valid: boolean;
  debt: number;
}

/**
 * Debt a pending SALE will carry: `total` minus whatever the raw paid draft
 * records as the initial payment. Mirrors the commit invariant
 * `initialPaid: paid === 0 ? undefined : paid` — an empty or zero draft leaves
 * the whole total unpaid (carried as customer debt), a partial payment leaves
 * the remainder, and a draft covering the total leaves none. Invalid drafts
 * report `valid: false` so the pre-commit preview can stay hidden while
 * `submit` surfaces its own validation error. A draft above the total is also
 * invalid: invoice creation rejects an overpayment, so it is not a zero-debt
 * commit.
 */
export function saleDebt(total: number, paidDraft: string): SaleDebt {
  const paid = paidDraft === "" ? undefined : Number(paidDraft);
  const valid = paid === undefined || (Number.isInteger(paid) && paid >= 0 && paid <= total);
  if (!valid) return { valid: false, debt: 0 };
  const effectivePaid = paid !== undefined && paid > 0 ? paid : 0;
  return { valid: true, debt: Math.max(total - effectivePaid, 0) };
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
  const [savedDebt, setSavedDebt] = useState<number | null>(null);
  const [savedCustomer, setSavedCustomer] = useState<string | null>(null);
  // Pre-save notice frozen at submit time: the pending request already carries
  // these values, so in-flight edits must not contradict it.
  const [submittedNotice, setSubmittedNotice] = useState<SaleDebt | null>(null);

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
  // Live "a commit is in flight" flag. Async callbacks (e.g. a quick-add that
  // settles after Save) read this ref instead of a render-time isPending value,
  // whose captured copy would be stale, so they cannot mutate the cart once a
  // commit has started.
  const commitRef = useRef(false);

  const addLine = (item: Item) => {
    // The sale is frozen once a commit is in flight: ignore late adds (scanner,
    // an already-open dialog, or a quick-add that settles after Save) so the
    // cart cannot drift from the request.
    if (commitRef.current) return;
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
        commitRef.current = false;
        setSavedNumber(invoice.invoiceNumber);
        // Confirmation uses the invoice the server actually wrote: its
        // remaining amount is authoritative, unlike cart-price math which can
        // drift from current item prices.
        setSavedDebt(invoice.remainingAmount);
        setSavedCustomer(invoice.counterpartyName);
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
      onError: (err) => {
        commitRef.current = false;
        setError(tError(err.message));
      },
    }),
  );

  const { setDraftDirty, setSavePending } = useSaleDraft();
  // Quick-add inputs count too: a half-created item in that form is live work the
  // header's New Sale action must not silently discard.
  const quickDraft =
    quickName.trim() !== "" ||
    quickBarcode.trim() !== "" ||
    quickCost.trim() !== "" ||
    quickSell.trim() !== "";
  const draftDirty =
    lines.length > 0 ||
    customer.trim() !== "" ||
    discountType !== "" ||
    discountValue.trim() !== "" ||
    paidNow.trim() !== "" ||
    quickDraft;
  const savePending = createInvoice.isPending || createItem.isPending || createWithStock.isPending;

  useEffect(() => {
    setDraftDirty(draftDirty);
  }, [draftDirty, setDraftDirty]);
  useEffect(() => {
    setSavePending(savePending);
  }, [savePending, setSavePending]);
  // Leaving the sale screen (or resetting to a fresh sale) clears both flags so
  // the header action never warns about a draft that no longer exists.
  useEffect(
    () => () => {
      setDraftDirty(false);
      setSavePending(false);
    },
    [setDraftDirty, setSavePending],
  );

  const subtotal = lines.reduce((sum, line) => sum + parseQuantityDraft(line.quantityDraft) * actualPrice(line), 0);
  const enteredDiscount = nonNegativeOr(discountValue, 0);
  const discountAmount = discountType === "AMOUNT" ? Math.min(enteredDiscount, subtotal) : discountType === "PERCENTAGE" ? Math.min(Math.round((subtotal * enteredDiscount) / 100), subtotal) : 0;
  const total = subtotal - discountAmount;

  // Live debt preview for the pending sale — see `saleDebt` for the invariant.
  const { valid: paidInputValid, debt: totalDebt } = saleDebt(total, paidNow);
  const liveNotice: SaleDebt = { valid: paidInputValid, debt: totalDebt };
  // While a commit is in flight the request carries the values captured at
  // click time, so keep showing those instead of recomputing from editable
  // fields (editing a partial payment to full must not hide the recorded debt).
  const notice = createInvoice.isPending && submittedNotice !== null ? submittedNotice : liveNotice;
  // Only claim a customer debt when a party name is present; otherwise the
  // unpaid remainder is unattributed and the Debts screen (grouped by party)
  // cannot show it.
  const hasCustomer = customer.trim() !== "";
  const hasSavedCustomer = savedCustomer !== null && savedCustomer.trim() !== "";

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
    setSubmittedNotice(liveNotice);
    commitRef.current = true;
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
        <div className="rounded border bg-card p-5">
          <p className="font-semibold text-green-700" data-testid="sale-saved-number">{t("saleSaved", { number: savedNumber })}{savedDebt !== null && savedDebt > 0 && <span data-testid="sale-saved-debt">{" "}{hasSavedCustomer ? t("saleDebtSavedPrefix") : t("saleRemainderSavedPrefix")} <Amount value={savedDebt} /> {hasSavedCustomer && t("saleDebtCustomer")}</span>}</p>
          <button type="button" className="mt-4 rounded-lg border px-3 py-2" onClick={() => setSavedNumber(null)}>{t("saleNew")}</button>
        </div>
      </section>
    );
  }

  return (
    <section data-testid="sale-form">
      <h1 className="text-xl font-bold">{t("saleTitle")}</h1>

      <div className="mt-4 grid gap-4">
        <div className="grid grid-cols-2 gap-3 rounded border border-border bg-card p-4">
          <label className="grid gap-1 text-sm font-medium">
            {t("saleCustomer")}
            <input
              className="h-9 rounded-lg border border-input bg-background px-3 text-sm"
              name="counterpartyName"
              autoComplete="off"
              value={customer}
              onChange={(event) => setCustomer(event.target.value)}
              disabled={createInvoice.isPending}
              data-testid="sale-customer"
            />
          </label>
          <label className="grid gap-1 text-sm font-medium">
            {t("salePaid")}
            <input
              className="h-9 rounded-lg border border-input bg-background px-3 text-sm"
              name="initialPaid"
              autoComplete="off"
              inputMode="numeric"
              value={paidNow}
              onChange={(event) => setPaidNow(event.target.value)}
              disabled={createInvoice.isPending}
              data-testid="sale-paid"
            />
          </label>
        </div>

        <div className="rounded border border-border bg-card">
          {/* One primary path (the list picker); the two create paths are
              demoted to outline so a first-day user is not asked to choose
              between equal-looking actions. */}
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
            <h2 className="me-auto text-sm font-semibold">{t("invoiceLinesTitle")}</h2>
            {lines.length > 0 && (
              <Button data-testid="sale-open-picker" onClick={() => setPickerOpen(true)} disabled={createInvoice.isPending}>
                {t("saleAddItem")}
              </Button>
            )}
            <Button variant="outline" data-testid="sale-quick-add" onClick={() => openQuick("EMPTY")} disabled={createInvoice.isPending}>
              {t("saleQuickAdd")}
            </Button>
            <Button variant="outline" data-testid="sale-quick-stock-add" onClick={() => openQuick("STOCK")} disabled={createInvoice.isPending}>
              {t("saleQuickStockBtn")}
            </Button>
          </div>

          {lines.length === 0 && error && <p className="mx-4 mt-3 rounded border border-destructive/20 bg-destructive/10 p-2 text-sm text-destructive" data-testid="sale-error" role="alert">{error}</p>}

          {quickMode !== null && (
            <form className="m-4 grid gap-3 rounded bg-accent p-3" onSubmit={quickSubmit} data-testid="sale-quick-form">
              <div className="grid grid-cols-2 gap-3">
                <label className="grid gap-1 text-sm font-medium">{t("saleQuickName")}<input className="h-9 rounded-lg border border-input bg-background px-3 text-sm" name="quickName" autoComplete="off" value={quickName} onChange={(event) => setQuickName(event.target.value)} required data-testid="sale-quick-name" /></label>
                <label className="grid gap-1 text-sm font-medium">{t("saleQuickBarcode")}<input dir="ltr" className="h-9 rounded-lg border border-input bg-background px-3 text-sm" name="quickBarcode" autoComplete="off" value={quickBarcode} onChange={(event) => setQuickBarcode(event.target.value)} data-testid="sale-quick-barcode" /></label>
                <label className="grid gap-1 text-sm font-medium">{t("itemsCategory")}<select className="h-9 rounded-lg border border-input bg-background px-3 text-sm" name="quickCategory" value={quickCategoryId} onChange={(event) => setQuickCategoryId(event.target.value)}>{categories.data?.items.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label>
                <label className="grid gap-1 text-sm font-medium">{t("itemsCost")}<input className="h-9 rounded-lg border border-input bg-background px-3 text-sm" name="quickCost" autoComplete="off" inputMode="numeric" value={quickCost} onChange={(event) => setQuickCost(event.target.value)} required /></label>
                <label className="grid gap-1 text-sm font-medium">{t("itemsSell")}<input className="h-9 rounded-lg border border-input bg-background px-3 text-sm" name="quickSell" autoComplete="off" inputMode="numeric" value={quickSell} onChange={(event) => setQuickSell(event.target.value)} required /></label>
                {quickMode === "STOCK" && <label className="grid gap-1 text-sm font-medium">{t("saleQuickStock")}<input className="h-9 rounded-lg border border-input bg-background px-3 text-sm" name="quickStock" autoComplete="off" inputMode="numeric" value={quickStock} onChange={(event) => setQuickStock(event.target.value)} required data-testid="sale-quick-stock" /></label>}
              </div>
              <div className="flex gap-2"><Button type="submit" disabled={createItem.isPending || createWithStock.isPending || createInvoice.isPending}>{t("saleQuickSave")}</Button><Button type="button" variant="outline" onClick={() => setQuickMode(null)}>{t("dialogClose")}</Button></div>
            </form>
          )}

          <div className="p-4">
            {lines.length === 0 ? (
              <div data-testid="sale-empty">
                <EmptyState
                  icon={<ScanBarcode size={28} />}
                  title={t("saleEmptyTitle")}
                  hint={t("saleScanHint")}
                  action={
                    <Button size="lg" data-testid="sale-open-picker" onClick={() => setPickerOpen(true)} disabled={createInvoice.isPending}>
                      {t("saleAddItem")}
                    </Button>
                  }
                />
              </div>
            ) : (
              <table className="w-full" data-testid="sale-lines">
                <thead><tr className="border-b text-right text-sm text-muted-foreground"><th className="p-2">{t("itemsName")}</th><th className="p-2">{t("saleQuantity")}</th><th className="p-2">{t("saleDefaultPrice")}</th><th className="p-2">{t("saleActualPrice")}</th><th className="p-2">{t("saleLineTotal")}</th><th className="p-2" /></tr></thead>
                <tbody>{lines.map((line, index) => { const price = actualPrice(line); const quantity = parseQuantityDraft(line.quantityDraft); return <tr key={line.item.id} className="border-b last:border-0"><td className="p-2">{line.item.name}</td><td className="p-2"><input className="w-16 rounded border px-2 py-1" name={`quantity-${line.item.id}`} autoComplete="off" inputMode="numeric" value={line.quantityDraft} onChange={(event) => setLines((current) => current.map((entry, i) => i === index ? { ...entry, quantityDraft: event.target.value } : entry))} disabled={createInvoice.isPending} aria-label={`${line.item.name}: ${t("saleQuantity")}`} /></td><td className="p-2"><Amount value={line.item.sellingPrice} /></td><td className="p-2"><div className="flex gap-1"><select className="w-28 rounded border px-1 py-1" value={line.overrideType} onChange={(event) => setLines((current) => current.map((entry, i) => i === index ? { ...entry, overrideType: toOverrideType(event.target.value), overrideValue: "" } : entry))} disabled={createInvoice.isPending} aria-label={`${line.item.name}: ${t("saleOverrideType")}`}><option value="">{t("saleDefault")}</option><option value="AMOUNT">{t("saleOverrideAmount")}</option><option value="PERCENTAGE">{t("saleOverridePercentage")}</option></select>{line.overrideType !== "" && <input className="w-20 rounded border px-2 py-1" inputMode="numeric" value={line.overrideValue} onChange={(event) => setLines((current) => current.map((entry, i) => i === index ? { ...entry, overrideValue: event.target.value } : entry))} disabled={createInvoice.isPending} aria-label={`${line.item.name}: ${t("saleOverrideValue")}`} />}</div><span className="text-xs text-muted-foreground"><Amount value={price} /></span></td><td className="p-2"><Amount value={quantity * price} /></td><td className="p-2"><button type="button" className="rounded p-1 text-destructive hover:bg-destructive/10 disabled:opacity-50" aria-label={`${t("removeRow")} ${line.item.name}`} onClick={() => { const next = lines.filter((_, i) => i !== index); setLines(next); if (next.length === 0) { setDiscountType(""); setDiscountValue(""); } }} disabled={createInvoice.isPending}><X size={16} aria-hidden="true" /></button></td></tr>; })}</tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* Checkout bar: the total and the finish action stay in the viewport at
          short window heights. It exists only once there is something to
          check out, so the discount controls cannot appear on an empty
          invoice. */}
      {lines.length > 0 && (
        <CheckoutBar testId="sale-checkout-bar" className="mt-4">
            <div className="flex flex-wrap items-end gap-3">
              <label className="grid gap-1 text-sm font-medium">{t("saleDiscountType")}<select className="h-9 w-40 rounded-lg border border-input bg-background px-3 text-sm" name="discountType" value={discountType} onChange={(event) => setDiscountType(toDiscountType(event.target.value))} disabled={createInvoice.isPending} data-testid="sale-discount-type"><option value="">{t("saleNoDiscount")}</option><option value="AMOUNT">{t("saleDiscountAmount")}</option><option value="PERCENTAGE">{t("saleDiscountPercentage")}</option></select></label>
              <label className="grid gap-1 text-sm font-medium">{t("saleDiscountValue")}<input className="h-9 w-32 rounded-lg border border-input bg-background px-3 text-sm" name="discountValue" autoComplete="off" inputMode="numeric" value={discountValue} onChange={(event) => setDiscountValue(event.target.value)} disabled={discountType === "" || createInvoice.isPending} data-testid="sale-discount-value" /></label>
              <dl className="ms-auto flex items-center gap-6 text-sm"><div className="flex items-baseline gap-2"><dt className="text-muted-foreground">{t("saleSubtotal")}</dt><dd data-testid="sale-subtotal"><Amount value={subtotal} /></dd></div><div className="flex items-baseline gap-2"><dt className="text-muted-foreground">{t("saleDiscount")}</dt><dd data-testid="sale-discount"><Amount value={discountAmount > 0 ? -discountAmount : 0} /></dd></div><div className="flex items-baseline gap-2 text-lg font-bold"><dt>{t("saleTotal")}</dt><dd data-testid="sale-total"><Amount value={total} /></dd></div></dl>
            </div>
            {notice.valid && notice.debt > 0 && (
              <p className="rounded border border-amber-600/30 bg-amber-500/10 p-2 text-sm" data-testid="sale-debt-notice">
                {hasCustomer ? t("saleDebtWillBeCreated") : t("saleRemainderWillBeCreated")} <Amount value={notice.debt} /> {hasCustomer && t("saleDebtCustomer")} {t("saleDebtEstimate")}
              </p>
            )}
            {error && <p className="rounded border border-destructive/20 bg-destructive/10 p-2 text-sm text-destructive" data-testid="sale-error" role="alert">{error}</p>}
            <Button size="lg" className="w-full" onClick={submit} disabled={createInvoice.isPending || createItem.isPending || createWithStock.isPending} data-testid="sale-save">{createInvoice.isPending ? t("saleSaving") : t("saleSave")}</Button>
        </CheckoutBar>
      )}

      <ItemPickerDialog open={pickerOpen} onClose={() => setPickerOpen(false)} onSelect={addLine} />
      {unknownCode !== null && <UnknownScanDialog code={unknownCode} onClose={() => setUnknownCode(null)} onCreate={() => { setUnknownCode(null); openQuick("EMPTY", unknownCode); }} onCreateWithStock={() => { setUnknownCode(null); openQuick("STOCK", unknownCode); }} onManualLine={() => { setUnknownCode(null); setPickerOpen(true); }} />}
    </section>
  );
}
