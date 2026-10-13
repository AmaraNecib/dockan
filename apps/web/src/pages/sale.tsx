import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScanBarcode, X } from "lucide-react";

import type { InvoiceCreate, InvoiceDetail, Item } from "@dokan/contracts";
import { Amount } from "@/components/ui/amount";
import { AmountPercentageInput, amountFromPercentage, parseWholeAmount, parseWholePercentage, percentageDraftInvalid, percentageFromAmount } from "@/components/ui/amount-percentage-input";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { inputClass } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SuccessCard, SuccessCardSpacer } from "@/components/ui/success-card";
import { cn } from "@/lib/utils";

import { ItemPickerDialog } from "@/components/catalog/item-picker-dialog";
import { UnknownScanDialog } from "@/components/catalog/unknown-scan-dialog";
import { PartyPicker, type PartySelection } from "@/components/parties/party-picker";
import { useSaleDraft } from "@/components/app/sale-draft";

import { useBarcodeScanner } from "../lib/use-barcode-scanner";
import { CheckoutBar } from "../components/app/checkout-bar";
import { orpc, rpcClient } from "../lib/rpc";
import { tError } from "../lib/i18n";
import { resolveOpeningStock } from "../lib/numeric-input";

type OverrideType = "" | "AMOUNT" | "PERCENTAGE";
type DiscountType = "" | "AMOUNT" | "PERCENTAGE";
type SaleLine = {
  item: Item;
  /** raw quantity input text; empty is a valid transient draft while typing */
  quantityDraft: string;
  overrideType: OverrideType;
  overrideValue: string;
};

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
  const [customer, setCustomer] = useState<PartySelection>({ id: null, name: "", needsChoice: false });
  const [discountType, setDiscountType] = useState<DiscountType>("");
  const [discountValue, setDiscountValue] = useState("");
  const [paidNow, setPaidNow] = useState("");
  // #162 — the initial payment is a share of the cart total; amount and
  // percentage mirror each other. The full total is the default until the
  // owner edits either field.
  const [paidPercentage, setPaidPercentage] = useState("");
  // which field the owner edits is the source of truth when the cart total
  // later changes: a percentage rescales the amount, an amount re-derives the
  // percentage. `null` = untouched, so the pair follows the full total.
  const paidSource = useRef<"amount" | "percentage" | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** the saved sale whose completion card is shown; the server's response is
   * kept whole so the card reads the authoritative number, remaining and party */
  const [savedSale, setSavedSale] = useState<InvoiceDetail | null>(null);
  // Pre-save notice frozen at submit time: the pending request already carries
  // these values, so in-flight edits must not contradict it.
  const [submittedNotice, setSubmittedNotice] = useState<SaleDebt | null>(null);

  const [quickOpen, setQuickOpen] = useState(false);
  const [quickName, setQuickName] = useState("");
  const [quickBarcode, setQuickBarcode] = useState("");
  const [quickCategoryId, setQuickCategoryId] = useState("");
  const [quickCost, setQuickCost] = useState("");
  const [quickSell, setQuickSell] = useState("");
  const [quickStock, setQuickStock] = useState("");
  // The stock field is always visible. The unknown-scan "create with stock"
  // choice promises an opening movement, so its path refuses a blank/zero
  // quantity; the plain create keeps blank = no opening stock (stock 0).
  const [quickStockRequired, setQuickStockRequired] = useState(false);
  const quickStockRef = useRef<HTMLInputElement>(null);
  // Monotonic focus request. A later unknown scan can choose "create with
  // stock" while this same form is already open, when `quickOpen` never
  // changes, so the focus effect keys off this request instead of the boolean.
  const [quickStockFocusRequest, setQuickStockFocusRequest] = useState(0);
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
      setError(tError(err instanceof Error ? err.message : undefined));
    }
  }
  useBarcodeScanner((code) => void handleScan(code));

  const createItem = useMutation(orpc.itemsCreate.mutationOptions());
  const createWithStock = useMutation(orpc.itemsCreateWithStock.mutationOptions());
  const createInvoice = useMutation(
    orpc.invoicesCreate.mutationOptions({
      onSuccess: (invoice) => {
        commitRef.current = false;
        // The confirmation card opens the invoice the server actually wrote;
        // its id and remaining amount are authoritative, unlike cart-price math
        // which can drift from current item prices.
        setSavedSale(invoice);
        setLines([]);
        setCustomer({ id: null, name: "", needsChoice: false });
        setDiscountType("");
        setDiscountValue("");
        setPaidNow("");
        setPaidPercentage("");
        paidSource.current = null;
        setError(null);
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.itemsAll.queryKey() }),
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
    customer.name.trim() !== "" ||
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

  // #162 — keep the pair linked as the cart total changes: untouched follows
  // the full total, an edited percentage rescales the amount, an edited amount
  // keeps the amount and re-derives the percentage. Recomputing from the same
  // values is a no-op, so the effect stays convergent.
  useEffect(() => {
    if (total === 0) {
      // a percentage-based payment must fall to zero when a discount zeroes the
      // total, or the old positive amount is sent and the api rejects it
      if (paidSource.current === "percentage") {
        setPaidNow("0");
        return;
      }
      // an amount typed while the cart was still empty (no reference yet) is
      // the owner's to keep; an untouched pair follows the empty cart
      if (paidSource.current === null) {
        setPaidNow("");
        setPaidPercentage("");
      }
      return;
    }
    if (paidSource.current === null) {
      setPaidNow(String(total));
      setPaidPercentage("100");
      return;
    }
    if (paidSource.current === "percentage") {
      const percentage = parseWholePercentage(paidPercentage);
      if (percentage !== null) setPaidNow(String(amountFromPercentage(total, percentage)));
      return;
    }
    const amount = parseWholeAmount(paidNow);
    setPaidPercentage(amount === null ? "" : String(percentageFromAmount(total, amount)));
  }, [total, paidNow, paidPercentage]);

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
  const hasCustomer = customer.name.trim() !== "";
  const hasSavedCustomer = savedSale !== null && savedSale.counterpartyName !== null && savedSale.counterpartyName.trim() !== "";

  function submit() {
    setError(null);
    if (lines.length === 0) {
      setError(t("saleLinesEmpty"));
      return;
    }
    // an exact typed name that belongs to a record must be picked first: saving
    // it as typed-only would hide the invoice from that record (P1.1)
    if (customer.needsChoice === true) {
      setError(t("partyChooseExisting"));
      return;
    }
    const paid = paidNow === "" ? undefined : Number(paidNow);
    // an invalid percentage draft clears the amount, which would otherwise take
    // the intentional "unpaid" path and save silently
    if (percentageDraftInvalid(paidPercentage)) {
      setError(t("saleInvalidPaid"));
      return;
    }
    if (paid !== undefined && (!Number.isInteger(paid) || paid < 0)) {
      setError(t("saleInvalidPaid"));
      return;
    }
    // an over-total amount is refused here, not by the api round-trip
    if (paid !== undefined && paid > total) {
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
      // the picker keeps the picked record's id; a typed-only name stays null
      counterpartyId: customer.id === null ? undefined : customer.id,
      counterpartyName: customer.name.trim() === "" ? undefined : customer.name.trim(),
      initialPaid: paid === 0 ? undefined : paid,
      lines: invoiceLines,
    };
    if (discountType !== "") invoiceInput.discount = { type: discountType, value: enteredDiscount };
    setSubmittedNotice(liveNotice);
    commitRef.current = true;
    void createInvoice.mutate(invoiceInput);
  }

  // what the quick-add will save into: the operator's pick, or the first
  // category the shop has. Display and submit read this one value.
  const quickCategory = quickCategoryId || categories.data?.items[0]?.id || "";
  /** the list has not answered yet: nothing to pick, nothing to submit */
  const quickCategoriesLoading = categories.data === undefined;

  function openQuick(code = "", withStock = false) {
    setQuickStockRequired(withStock);
    if (withStock) setQuickStockFocusRequest((request) => request + 1);
    setQuickOpen(true);
    setQuickBarcode(code);
    setQuickCategoryId(categories.data?.items[0]?.id ?? "");
    setQuickStock("");
    setQuickCost("");
    setQuickSell("");
    setQuickName("");
  }

  // "create with stock" always moves focus to the quantity, whether the form is
  // opening now or was already open for an earlier scan.
  useEffect(() => {
    if (quickStockFocusRequest === 0) return;
    quickStockRef.current?.focus();
  }, [quickStockFocusRequest]);

  function quickSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    const categoryId = quickCategory;
    const cost = Number(quickCost);
    const sell = Number(quickSell);
    // the plain path reads blank and 0 as "no opening stock"; the scan's
    // create-with-stock path requires a positive count — the resolver owns
    // that rule, the messages stay here
    const stock = resolveOpeningStock(quickStock, quickStockRequired);
    if (!categoryId) {
      setError(t("itemsChooseCategory"));
      return;
    }
    if (quickName.trim() === "" || !Number.isInteger(cost) || cost < 0 || !Number.isInteger(sell) || sell < 0) {
      setError(t("saleQuickInvalid"));
      return;
    }
    if (!stock.ok) {
      setError(t(stock.reason === "required" ? "scanStockRequired" : "scanStockInvalid"));
      return;
    }
    const input = {
      name: quickName.trim(),
      categoryId,
      costPrice: cost,
      sellingPrice: sell,
      barcode: quickBarcode.trim() === "" ? undefined : quickBarcode.trim(),
    };
    if (stock.value > 0) {
      void createWithStock.mutate(
        { ...input, stockOnHand: stock.value },
        { onSuccess: (item) => { addLine(item); setQuickOpen(false); }, onError: (err) => setError(tError(err.message)) },
      );
    } else {
      void createItem.mutate(input, { onSuccess: (item) => { addLine(item); setQuickOpen(false); }, onError: (err) => setError(tError(err.message)) });
    }
  }

  if (savedSale !== null) {
    return (
      <section data-testid="sale-saved" className="grid gap-4">
        <h1 className="text-xl font-bold">{t("saleTitle")}</h1>
        <SuccessCard
          title={<span data-testid="sale-saved-number">{t("saleSaved", { number: savedSale.invoiceNumber })}</span>}
          detail={
            savedSale.remainingAmount > 0 ? (
              <span data-testid="sale-saved-debt">
                {hasSavedCustomer ? t("saleDebtSavedPrefix") : t("saleRemainderSavedPrefix")} <Amount value={savedSale.remainingAmount} suffix={t("dzd")} />{" "}
                {hasSavedCustomer && t("saleDebtCustomer")}
              </span>
            ) : undefined
          }
        >
          <Button asChild>
            <Link to="/invoices/$invoiceId" params={{ invoiceId: savedSale.id }} data-testid="sale-open-invoice">{t("savedViewInvoice")}</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/invoices/$invoiceId/print" params={{ invoiceId: savedSale.id }} data-testid="sale-print">{t("savedPrint")}</Link>
          </Button>
          <SuccessCardSpacer />
          <Button variant="ghost" onClick={() => setSavedSale(null)} data-testid="sale-new">{t("saleNew")}</Button>
        </SuccessCard>
      </section>
    );
  }

  return (
    <section data-testid="sale-form">
      <h1 className="text-xl font-bold">{t("saleTitle")}</h1>

      <div className="mt-4 grid gap-4">
        <div className="grid grid-cols-2 gap-3 rounded border border-border bg-card p-4">
          <PartyPicker
            role="customer"
            label={t("saleCustomer")}
            value={customer}
            onChange={setCustomer}
            disabled={createInvoice.isPending}
            testId="sale-customer"
          />
          <AmountPercentageInput
            referenceTotal={total > 0 ? total : null}
            value={{ amount: paidNow, percentage: paidPercentage }}
            onChange={(next, edited) => {
              paidSource.current = edited;
              setPaidNow(next.amount);
              setPaidPercentage(next.percentage);
            }}
            amountLabel={t("salePaid")}
            amountTestId="sale-paid"
            percentageTestId="sale-paid-percentage"
            referenceTestId="sale-paid-reference"
            percentageInvalid={percentageDraftInvalid(paidPercentage)}
            disabled={createInvoice.isPending}
          />
        </div>

        <div className="rounded border border-border bg-card">
          {/* One primary path (the list picker); creating a missing item is a
              single demoted action — the stock quantity lives on its form, so
              a first-day user is never asked to choose between two creates. */}
          <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
            <h2 className="me-auto text-sm font-semibold">{t("invoiceLinesTitle")}</h2>
            {lines.length > 0 && (
              <Button data-testid="sale-open-picker" onClick={() => setPickerOpen(true)} disabled={createInvoice.isPending}>
                {t("saleAddItem")}
              </Button>
            )}
            <Button variant="outline" data-testid="sale-quick-add" onClick={() => openQuick()} disabled={createInvoice.isPending}>
              {t("saleQuickAdd")}
            </Button>
          </div>

          {lines.length === 0 && error && <p className="mx-4 mt-3 rounded border border-destructive/20 bg-destructive/10 p-2 text-sm text-destructive" data-testid="sale-error" role="alert">{error}</p>}

          {quickOpen && (
            <form className="m-4 grid gap-3 rounded bg-accent p-3" onSubmit={quickSubmit} data-testid="sale-quick-form">
              <div className="grid grid-cols-2 gap-3">
                <label className="grid gap-1 text-sm font-medium">{t("saleQuickName")}<input className="h-9 rounded-lg border border-input bg-background px-3 text-sm" name="quickName" autoComplete="off" value={quickName} onChange={(event) => setQuickName(event.target.value)} required data-testid="sale-quick-name" /></label>
                <label className="grid gap-1 text-sm font-medium">{t("saleQuickBarcode")}<input dir="ltr" className="h-9 rounded-lg border border-input bg-background px-3 text-sm" name="quickBarcode" autoComplete="off" value={quickBarcode} onChange={(event) => setQuickBarcode(event.target.value)} data-testid="sale-quick-barcode" /></label>
                <label className="grid gap-1 text-sm font-medium">
                  {t("itemsCategory")}
                  <Select
                    value={quickCategory}
                    onValueChange={(value) => setQuickCategoryId(value ?? "")}
                    name="quickCategory"
                    disabled={quickCategoriesLoading}
                    items={categories.data?.items.map((category) => ({ value: category.id, label: category.name })) ?? []}
                  >
                    <SelectTrigger className="w-full" data-testid="sale-quick-category">
                      <SelectValue placeholder={quickCategoriesLoading ? t("itemsLoading") : undefined} />
                    </SelectTrigger>
                    <SelectContent>
                      {categories.data?.items.map((category) => <SelectItem key={category.id} value={category.id}>{category.name}</SelectItem>)}
                    </SelectContent>
                  </Select>
                </label>
                <label className="grid gap-1 text-sm font-medium">{t("itemsCost")}<input className="h-9 rounded-lg border border-input bg-background px-3 text-sm" name="quickCost" autoComplete="off" inputMode="numeric" value={quickCost} onChange={(event) => setQuickCost(event.target.value)} required /></label>
                <label className="grid gap-1 text-sm font-medium">{t("itemsSell")}<input className="h-9 rounded-lg border border-input bg-background px-3 text-sm" name="quickSell" autoComplete="off" inputMode="numeric" value={quickSell} onChange={(event) => setQuickSell(event.target.value)} required /></label>
                <label className="grid gap-1 text-sm font-medium">
                  {quickStockRequired ? t("saleQuickStockRequired") : t("saleQuickStock")}
                  <input ref={quickStockRef} className="h-9 rounded-lg border border-input bg-background px-3 text-sm" name="quickStock" autoComplete="off" inputMode="numeric" value={quickStock} onChange={(event) => setQuickStock(event.target.value)} aria-required={quickStockRequired || undefined} data-testid="sale-quick-stock" />
                </label>
              </div>
              <div className="flex gap-2"><Button type="submit" disabled={createItem.isPending || createWithStock.isPending || createInvoice.isPending}>{t("saleQuickSave")}</Button><Button type="button" variant="outline" onClick={() => setQuickOpen(false)}>{t("dialogClose")}</Button></div>
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
                <tbody>{lines.map((line, index) => { const price = actualPrice(line); const quantity = parseQuantityDraft(line.quantityDraft); return <tr key={line.item.id} className="border-b last:border-0"><td className="p-2">{line.item.name}</td><td className="p-2"><input className={cn(inputClass, "w-16 px-2 py-1")} name={`quantity-${line.item.id}`} autoComplete="off" inputMode="numeric" value={line.quantityDraft} onChange={(event) => setLines((current) => current.map((entry, i) => i === index ? { ...entry, quantityDraft: event.target.value } : entry))} disabled={createInvoice.isPending} aria-label={`${line.item.name}: ${t("saleQuantity")}`} /></td><td className="p-2"><Amount value={line.item.sellingPrice} /></td><td className="p-2"><div className="flex gap-1"><Select value={line.overrideType} onValueChange={(value) => { const next = toOverrideType(value ?? ""); if (next === line.overrideType) return; setLines((current) => current.map((entry, i) => i === index ? { ...entry, overrideType: next, overrideValue: "" } : entry)); }} disabled={createInvoice.isPending} items={[{ value: "", label: t("saleDefault") }, { value: "AMOUNT", label: t("saleOverrideAmount") }, { value: "PERCENTAGE", label: t("saleOverridePercentage") }]}><SelectTrigger className="w-28" aria-label={`${line.item.name}: ${t("saleOverrideType")}`}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="">{t("saleDefault")}</SelectItem><SelectItem value="AMOUNT">{t("saleOverrideAmount")}</SelectItem><SelectItem value="PERCENTAGE">{t("saleOverridePercentage")}</SelectItem></SelectContent></Select>{line.overrideType !== "" && <input className={cn(inputClass, "w-20 px-2 py-1")} inputMode="numeric" value={line.overrideValue} onChange={(event) => setLines((current) => current.map((entry, i) => i === index ? { ...entry, overrideValue: event.target.value } : entry))} disabled={createInvoice.isPending} aria-label={`${line.item.name}: ${t("saleOverrideValue")}`} />}</div><span className="text-xs text-muted-foreground"><Amount value={price} /></span></td><td className="p-2"><Amount value={quantity * price} /></td><td className="p-2"><button type="button" className="rounded p-1 text-destructive hover:bg-destructive/10 disabled:opacity-50" aria-label={`${t("removeRow")} ${line.item.name}`} onClick={() => { const next = lines.filter((_, i) => i !== index); setLines(next); if (next.length === 0) { setDiscountType(""); setDiscountValue(""); } }} disabled={createInvoice.isPending}><X size={16} aria-hidden="true" /></button></td></tr>; })}</tbody>
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
              <label className="grid gap-1 text-sm font-medium">{t("saleDiscountType")}<Select value={discountType} onValueChange={(value) => setDiscountType(toDiscountType(value ?? ""))} disabled={createInvoice.isPending} name="discountType" items={[{ value: "", label: t("saleNoDiscount") }, { value: "AMOUNT", label: t("saleDiscountAmount") }, { value: "PERCENTAGE", label: t("saleDiscountPercentage") }]}><SelectTrigger className="w-40" data-testid="sale-discount-type"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="">{t("saleNoDiscount")}</SelectItem><SelectItem value="AMOUNT">{t("saleDiscountAmount")}</SelectItem><SelectItem value="PERCENTAGE">{t("saleDiscountPercentage")}</SelectItem></SelectContent></Select></label>
              <label className="grid gap-1 text-sm font-medium">{t("saleDiscountValue")}<input className="h-9 w-32 rounded-lg border border-input bg-background px-3 text-sm" name="discountValue" autoComplete="off" inputMode="numeric" value={discountValue} onChange={(event) => setDiscountValue(event.target.value)} disabled={discountType === "" || createInvoice.isPending} data-testid="sale-discount-value" /></label>
              <dl className="ms-auto flex items-center gap-6 text-sm"><div className="flex items-baseline gap-2"><dt className="text-muted-foreground">{t("saleSubtotal")}</dt><dd data-testid="sale-subtotal"><Amount value={subtotal} /></dd></div><div className="flex items-baseline gap-2"><dt className="text-muted-foreground">{t("saleDiscount")}</dt><dd data-testid="sale-discount"><Amount value={discountAmount > 0 ? -discountAmount : 0} /></dd></div><div className="flex items-baseline gap-2 text-lg font-bold"><dt>{t("saleTotal")}</dt><dd data-testid="sale-total"><Amount value={total} /></dd></div></dl>
            </div>
            {notice.valid && notice.debt > 0 && (
              <p className="rounded border border-warning/30 bg-warning/10 p-2 text-sm" data-testid="sale-debt-notice">
                {hasCustomer ? t("saleDebtWillBeCreated") : t("saleRemainderWillBeCreated")} <Amount value={notice.debt} /> {hasCustomer && t("saleDebtCustomer")} {t("saleDebtEstimate")}
              </p>
            )}
            {error && <p className="rounded border border-destructive/20 bg-destructive/10 p-2 text-sm text-destructive" data-testid="sale-error" role="alert">{error}</p>}
            <Button size="lg" className="w-full" onClick={submit} disabled={createInvoice.isPending || createItem.isPending || createWithStock.isPending} data-testid="sale-save">{createInvoice.isPending ? t("saleSaving") : t("saleSave")}</Button>
        </CheckoutBar>
      )}

      <ItemPickerDialog open={pickerOpen} onClose={() => setPickerOpen(false)} onSelect={addLine} />
      {unknownCode !== null && <UnknownScanDialog code={unknownCode} onClose={() => setUnknownCode(null)} onCreate={() => { setUnknownCode(null); openQuick(unknownCode); }} onCreateWithStock={() => { setUnknownCode(null); openQuick(unknownCode, true); }} onManualLine={() => { setUnknownCode(null); setPickerOpen(true); }} />}
    </section>
  );
}
