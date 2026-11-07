import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMutation } from "../lib/scoped-mutation";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ScanBarcode, X } from "lucide-react";

import type { Category, InvoiceCreate, InvoiceDetail, Item } from "@dokan/contracts";
import { Amount } from "@/components/ui/amount";
import { AmountPercentageInput } from "@/components/ui/amount-percentage-input";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { inputClass } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SuccessCard, SuccessCardSpacer } from "@/components/ui/success-card";
import { useDiscardNavigationGuard } from "@/hooks/use-discard-navigation-guard";
import { cn } from "@/lib/utils";
import { anyTyped } from "@/lib/invoice-draft";
import { draftBlank, parseGroupedAmount, parseLooseNumber, percentageDraftInvalid } from "@/lib/amount-parse";
import {
  draftTotals,
  firstCommitError,
  lineQuantity,
  nonNegativeOr,
  parseQuantityDraft,
  quantityDraftInvalid,
  resolvedInitialPaid,
  resolveInitialPaid,
  saleOverrideInvalid,
  saleUnitPrice,
  toAmountKind,
  type AmountKind,
  type SaleDraftLine,
} from "@/lib/invoice-draft";
import { useInvoiceDraft, usePaymentPair, useQuickAdd, type QuickAddOutcome, type QuickAddSpec } from "@/lib/use-invoice-draft";

import { ItemPickerDialog, matchBadgeKey } from "@/components/catalog/item-picker-dialog";
import { SaleLinePriceEditor } from "@/components/catalog/sale-line-price-editor";
import { parseSalePriceMode } from "@/lib/sale-price-editor";
import { usePreference } from "@/lib/preferences";
import { UnknownScanDialog } from "@/components/catalog/unknown-scan-dialog";
import { PartyPicker, type PartySelection } from "@/components/parties/party-picker";
import { EntityPicker } from "@/components/entity-picker";
import { useSaleDraft } from "@/components/app/sale-draft";
import { useInvoiceEntryShortcut } from "@/hooks/use-invoice-entry-shortcut";
import { shortcutKeys } from "@/lib/keyboard-actions";

import { useBarcodeScanner } from "../lib/use-barcode-scanner";
import { CheckoutBar } from "../components/app/checkout-bar";
import { useRpc } from "../lib/rpc-context";
import { tError } from "../lib/i18n";
import { resolveOpeningStock } from "../lib/numeric-input";

/**
 * Whether a pre-commit paid draft is usable, and the debt it leaves.
 *
 * #146 moved the quantity parser, the totals, and the amount and percentage
 * pair into `@/lib/invoice-draft`. This preview stays sale-only: a purchase has
 * no customer debt notice.
 */
export interface SaleDebt {
  valid: boolean;
  debt: number;
}

/**
 * Debt a pending SALE will carry: `total` minus whatever the raw paid draft
 * records as the initial payment. Mirrors the commit invariant
 * `initialPaid: paid === 0 ? undefined : paid`, an empty or zero draft leaves
 * the whole total unpaid (carried as customer debt), a partial payment leaves
 * the remainder, and a draft covering the total leaves none. Invalid drafts
 * report `valid: false` so the pre-commit preview can stay hidden while
 * `submit` surfaces its own validation error. A draft above the total is also
 * invalid: invoice creation rejects an overpayment, so it is not a zero-debt
 * commit. Blankness asks the shared `draftBlank` predicate (#238), the same one
 * `resolveInitialPaid` commits with, so a mark-only paid draft previews as
 * unpaid instead of diverging from the commit.
 */
export function saleDebt(total: number, paidDraft: string): SaleDebt {
  if (draftBlank(paidDraft)) return { valid: true, debt: Math.max(total, 0) };
  const paid = parseGroupedAmount(paidDraft);
  if (paid === null || paid > total) return { valid: false, debt: 0 };
  return { valid: true, debt: Math.max(total - paid, 0) };
}

/** The per-kind draft rules; module scope keeps the config identity stable. */
const SALE_DRAFT = {
  emptyLine: (item: Item): SaleDraftLine => ({ item, quantityDraft: "1", overrideType: "", overrideValue: "" }),
  unitPrice: saleUnitPrice,
};

/** The quick-add field bag; sale resets it on every open (a scan seeds the barcode). */
type SaleQuickFields = { name: string; barcode: string; categoryId: string; cost: string; sell: string; stock: string };

const SALE_QUICK = {
  empty: (): SaleQuickFields => ({ name: "", barcode: "", categoryId: "", cost: "", sell: "", stock: "" }),
  resetOnOpen: true,
  // sale keeps nothing across a create: its category is a default it re-derives
  // from the list on every open, not an explicit pick to preserve
  keepOnCreate: [],
} satisfies QuickAddSpec<SaleQuickFields>;

export function SalePage() {
  const { orpc, rpcClient } = useRpc();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const {
    claimOwner,
    releaseOwner,
    setDraftDirty: setOwnedDraftDirty,
    setSavePending: setOwnedSavePending,
  } = useSaleDraft();
  const [draftOwner] = useState(() => Symbol("sale-draft"));
  const setDraftDirty = useCallback((dirty: boolean) => setOwnedDraftDirty(draftOwner, dirty), [draftOwner, setOwnedDraftDirty]);
  const setSavePending = useCallback((pending: boolean) => setOwnedSavePending(draftOwner, pending), [draftOwner, setOwnedSavePending]);
  useEffect(() => {
    claimOwner(draftOwner);
    return () => releaseOwner(draftOwner);
  }, [claimOwner, draftOwner, releaseOwner]);
  const categories = useQuery(orpc.categoriesList.queryOptions());
  const [categoryCreateError, setCategoryCreateError] = useState<string | null>(null);
  const categoryCreate = useMutation(
    orpc.categoriesCreate.mutationOptions({
      onSuccess: (category) => {
        queryClient.setQueryData(orpc.categoriesList.queryKey(), (current: { items: Category[] } | undefined) => ({
          items: [...(current?.items ?? []), category].sort((a, b) => a.name.localeCompare(b.name)),
        }));
        void queryClient.invalidateQueries({ queryKey: orpc.categoriesList.queryKey() });
        void queryClient.invalidateQueries({ queryKey: orpc.itemsAll.queryKey() });
        quick.setField("categoryId", category.id);
        setCategoryCreateError(null);
        setDraftDirty(true);
      },
      onError: (err) => setCategoryCreateError(tError(err.message)),
    }),
  );
  const priceMode = usePreference("ui.sale.priceMode", "AMOUNT", parseSalePriceMode, String);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [unknownCode, setUnknownCode] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchDebounced, setSearchDebounced] = useState("");
  const [searchActiveIndex, setSearchActiveIndex] = useState<number | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [customer, setCustomer] = useState<PartySelection>({ id: null, name: "", needsChoice: false });
  const [discountType, setDiscountType] = useState<AmountKind>("");
  const [discountValue, setDiscountValue] = useState("");
  const [discountExpanded, setDiscountExpanded] = useState(false);
  const discountTypeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (discountExpanded) discountTypeRef.current?.focus();
  }, [discountExpanded]);
  const [error, setError] = useState<string | null>(null);
  /** the saved sale whose completion card is shown; the server's response is
   * kept whole so the card reads the authoritative number, remaining and party */
  const [savedSale, setSavedSale] = useState<InvoiceDetail | null>(null);
  // Pre-save notice frozen at submit time: the pending request already carries
  // these values, so in-flight edits must not contradict it.
  const [submittedNotice, setSubmittedNotice] = useState<SaleDebt | null>(null);

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

  const draft = useInvoiceDraft(SALE_DRAFT);
  const { lines } = draft;
  const catalogSearch = useQuery({
    ...orpc.catalogSearch.queryOptions({ input: { query: searchDebounced || " " }, enabled: searchDebounced.length > 0 }),
  });
  const searchMatches = catalogSearch.data?.matches ?? [];
  const searchExact = catalogSearch.data?.exact ?? null;
  const searchMatchSetKey = searchMatches.map((match) => match.item.id).join("|");
  const visibleSearchIndex = searchActiveIndex !== null && searchActiveIndex < searchMatches.length ? searchActiveIndex : null;

  useEffect(() => {
    const timer = setTimeout(() => setSearchDebounced(searchQuery.trim()), 150);
    return () => clearTimeout(timer);
  }, [searchQuery]);
  useEffect(() => setSearchActiveIndex(null), [searchDebounced, searchMatchSetKey]);

  const addLine = (item: Item) => {
    // The sale is frozen once a commit is in flight: ignore late adds (scanner,
    // an already-open dialog, or a quick-add that settles after Save) so the
    // cart cannot drift from the request.
    if (commitRef.current) return;
    setDraftDirty(true);
    draft.addItem(item);
    setPickerOpen(false);
    setSearchQuery("");
    setSearchDebounced("");
    setSearchActiveIndex(null);
    requestAnimationFrame(() => searchRef.current?.focus());
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

  // the explicit type argument pins F, so a later edit to the callbacks cannot
  // widen the bag and quietly disable key checking
  const quick = useQuickAdd<SaleQuickFields>(SALE_QUICK, { onCreated: (item) => addLine(item), setError });

  // The invoice total must be known before the payment pair (its reference) and
  // before the dirty flag reads the payment amount, so the totals are computed
  // first. This is the only ordering constraint the hooks have.
  const enteredDiscount = nonNegativeOr(discountValue, 0);
  // one totals path for both screens; purchase passes no discount
  const { subtotal, discountAmount, total } = draftTotals(lines, saleUnitPrice, discountType, discountValue);
  const payment = usePaymentPair(total);

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
        draft.reset();
        setCustomer({ id: null, name: "", needsChoice: false });
        setDiscountType("");
        setDiscountValue("");
        setDiscountExpanded(false);
        payment.reset();
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

  // Quick-add inputs count too: a half-created item in that form is live work the
  // header's New Sale action must not silently discard. These `draftDirty` gates
  // stay raw `.trim()` on purpose (#244): this is an unsaved-work indicator, not
  // a value decision — a pasted bidi mark IS work the discard warning must keep.
  // `saleDebt` below reads the payment draft through `draftBlank` because there
  // the mark means «nothing paid»; the two deliberately differ here.
  // The question («is any of this work?») is `anyTyped`, the same one the purchase
  // screen asks; the field LIST is this screen's, because a sale's quick bag has
  // cost/sell where a purchase's has a category, a threshold and a unit cost.
  //
  // `stock` is in the list because it is a real input (`sale-quick-stock`) that is
  // blank until the owner types an opening count — leaving it out loses that count
  // silently, which was the bug #321 fixed on the purchase screen (#345 review).
  // The first category is a seeded default, not user work. A different category
  // is an explicit choice and must count even when it is the only quick-add edit.
  const quickCategoryDefault = categories.data?.items[0]?.id ?? "";
  const quickCategoryDefaultAtOpen = useRef(quickCategoryDefault);
  const quickCategory = quick.fields.categoryId || quickCategoryDefault;
  const quickFieldsDirty = anyTyped([quick.fields.name, quick.fields.barcode, quick.fields.cost, quick.fields.sell, quick.fields.stock]);
  const quickCategoryDirty =
    quick.fields.categoryId !== "" && quick.fields.categoryId !== quickCategoryDefaultAtOpen.current;
  const draftDirtyOutsideQuickAdd =
    lines.length > 0 ||
    anyTyped([customer.name, discountValue, payment.amount, payment.percentage]) ||
    discountType !== "";
  const draftDirtyWithoutQuickCategory = draftDirtyOutsideQuickAdd || quickFieldsDirty;
  const quickDraft = quickFieldsDirty || quickCategoryDirty;
  const draftDirty = draftDirtyWithoutQuickCategory || quickCategoryDirty;
  const quickCreatePending = createItem.isPending || createWithStock.isPending || categoryCreate.isPending;
  const savePending = createInvoice.isPending || quickCreatePending;
  // A write cannot be cancelled when its screen unmounts. Refuse new same-tab
  // navigation attempts during the pending window; do not hold a destination.
  const discardGuard = useDiscardNavigationGuard({ dirty: false, lineCount: 0, pending: savePending, pendingRef: commitRef });
  useEffect(() => {
    if (discardGuard.blocked) setPickerOpen(false);
  }, [discardGuard.blocked]);

  useInvoiceEntryShortcut("sale", () => {
    if (savePending) return;
    setSavedSale(null);
    requestAnimationFrame(() => searchRef.current?.focus());
  });

  useEffect(() => {
    setDraftDirty(draftDirty);
  }, [draftDirty, setDraftDirty]);
  useEffect(() => {
    setSavePending(savePending);
  }, [savePending, setSavePending]);

  // Live debt preview for the pending sale — see `saleDebt` for the invariant.
  const { valid: paidInputValid, debt: totalDebt } = saleDebt(total, payment.amount);
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
    // `firstCommitError` owns the check order — empty cart → party → per-line
    // (override before quantity) → discount → payment — so a future reorder
    // cannot fix this screen and miss purchase. The raw drafts are validated
    // before the values derived from them: a cleared quantity or an over-100%
    // discount zeroes the total, and a payment typed against the old total
    // would otherwise fail the amount-vs-total check and mask the real problem.
    const parsedDiscount = parseLooseNumber(discountValue);
    const discountInvalid =
      discountType !== "" &&
      (!Number.isFinite(parsedDiscount) ||
        (discountType === "AMOUNT" && (!Number.isInteger(parsedDiscount) || parsedDiscount < 0)) ||
        (discountType === "PERCENTAGE" && (!Number.isInteger(parsedDiscount) || parsedDiscount < 0 || parsedDiscount > 100)));
    // maps a zero draft to «nothing paid now» (the api requires a positive initialPaid)
    const paid = resolveInitialPaid(total, payment.amount, payment.percentage);
    const commitError = firstCommitError({
      lines,
      linesEmpty: t("saleLinesEmpty"),
      partyNeedsChoice: customer.needsChoice === true,
      partyNeedsChoiceMessage: t("partyChooseExisting"),
      override: { invalid: saleOverrideInvalid, message: t("saleInvalidOverride") },
      quantity: { invalid: (line) => quantityDraftInvalid(line.quantityDraft), message: t("saleInvalidQuantity") },
      discount: { invalid: discountInvalid, message: t("saleInvalidDiscount") },
      payment: { invalid: !paid.ok, message: t("saleInvalidPaid") },
    });
    if (commitError !== null) {
      setError(commitError);
      return;
    }
    const invoiceLines = lines.map((line) => {
      const invoiceLine: InvoiceCreate["lines"][number] = {
        itemId: line.item.id,
        quantity: parseQuantityDraft(line.quantityDraft),
      };
      if (line.overrideType !== "") {
        invoiceLine.priceOverride = { type: line.overrideType, value: parseLooseNumber(line.overrideValue) };
      }
      return invoiceLine;
    });
    const invoiceInput: InvoiceCreate = {
      kind: "SALE",
      // the picker keeps the picked record's id; a typed-only name stays null
      counterpartyId: customer.id === null ? undefined : customer.id,
      counterpartyName: customer.name.trim() === "" ? undefined : customer.name.trim(),
      initialPaid: resolvedInitialPaid(paid),
      lines: invoiceLines,
    };
    if (discountType !== "") invoiceInput.discount = { type: discountType, value: enteredDiscount };
    setSubmittedNotice(liveNotice);
    commitRef.current = true;
    setSavePending(true);
    void createInvoice.mutate(invoiceInput);
  }

  /** the list has not answered yet: nothing to pick, nothing to submit */
  const quickCategoriesLoading = categories.data === undefined;

  function openQuick(code = "", withStock = false) {
    if (quickCreatePending || createInvoice.isPending) return;
    quickCategoryDefaultAtOpen.current = quickCategoryDefault;
    setQuickStockRequired(withStock);
    if (withStock) setQuickStockFocusRequest((request) => request + 1);
    setCategoryCreateError(null);
    quick.openForm({ barcode: code, categoryId: quickCategoryDefault });
  }

  // "create with stock" always moves focus to the quantity, whether the form is
  // opening now or was already open for an earlier scan.
  useEffect(() => {
    if (quickStockFocusRequest === 0) return;
    quickStockRef.current?.focus();
  }, [quickStockFocusRequest]);

  function quickSubmit(event: React.FormEvent) {
    event.preventDefault();
    void quick.submit(async (fields) => {
      const categoryId = quickCategory;
      const cost = parseLooseNumber(fields.cost);
      const sell = parseLooseNumber(fields.sell);
      // the plain path reads blank and 0 as "no opening stock"; the scan's
      // create-with-stock path requires a positive count — the resolver owns
      // that rule, the messages stay here
      const stock = resolveOpeningStock(fields.stock, quickStockRequired);
      if (!categoryId) return { ok: false, error: t("itemsChooseCategory") };
      if (fields.name.trim() === "" || !Number.isInteger(cost) || cost < 0 || !Number.isInteger(sell) || sell < 0) {
        return { ok: false, error: t("saleQuickInvalid") };
      }
      if (!stock.ok) {
        return { ok: false, error: t(stock.reason === "required" ? "scanStockRequired" : "scanStockInvalid") };
      }
      const input = {
        name: fields.name.trim(),
        categoryId,
        costPrice: cost,
        sellingPrice: sell,
        barcode: fields.barcode.trim() === "" ? undefined : fields.barcode.trim(),
      };
      return await new Promise<QuickAddOutcome>((resolve) => {
        setSavePending(true);
        if (stock.value > 0) {
          createWithStock.mutate(
            { ...input, stockOnHand: stock.value },
            { onSuccess: (item) => resolve({ ok: true, item }), onError: (err) => resolve({ ok: false, error: tError(err.message) }) },
          );
          return;
        }
        createItem.mutate(input, { onSuccess: (item) => resolve({ ok: true, item }), onError: (err) => resolve({ ok: false, error: tError(err.message) }) });
      });
    });
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
                {hasSavedCustomer ? t("saleDebtSavedPrefix") : t("saleRemainderSavedPrefix")} <Amount value={savedSale.remainingAmount} />{" "}
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
    <section data-testid="sale-form" onInput={(event) => {
      if (event.target instanceof Element && (
        event.target.closest('[data-testid="picker-dialog"]') !== null ||
        event.target.matches('[data-testid="sale-quick-category"]')
      )) return;
      setDraftDirty(true);
    }}>
      <h1 className="text-xl font-bold">{t("saleTitle")}</h1>

      <div className="mt-4 grid gap-4">
        <div className="grid grid-cols-2 gap-3 rounded border border-border bg-card p-4">
          <PartyPicker
            role="customer"
            label={t("saleCustomer")}
            value={customer}
            onChange={(value) => {
              setCustomer(value);
              setDraftDirty(true);
            }}
            disabled={createInvoice.isPending}
            testId="sale-customer"
          />
          <AmountPercentageInput
            referenceTotal={total > 0 ? total : null}
            value={{ amount: payment.amount, percentage: payment.percentage }}
            onChange={(value, edited) => {
              payment.onChange(value, edited);
              setDraftDirty(true);
            }}
            amountLabel={t("salePaid")}
            amountTestId="sale-paid"
            percentageTestId="sale-paid-percentage"
            referenceTestId="sale-paid-reference"
            percentageInvalid={percentageDraftInvalid(payment.percentage)}
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
              <Button data-testid="sale-open-picker" title={`${t("saleAddItem")} (${shortcutKeys("onSale")})`} onClick={() => setPickerOpen(true)} disabled={createInvoice.isPending}>
                {t("saleAddItem")}
              </Button>
            )}
            <Button variant="outline" data-testid="sale-quick-add" onClick={() => openQuick()} disabled={createInvoice.isPending || quickCreatePending}>
              {t("saleQuickAdd")}
            </Button>
          </div>

          <div className="grid gap-2 border-b border-border p-4">
            <label htmlFor="sale-search" className="text-sm font-medium">{t("itemsSearchPlaceholder")}</label>
            <input
              ref={searchRef}
              id="sale-search"
              role="combobox"
              aria-autocomplete="list"
              aria-controls="sale-search-results"
              aria-expanded={searchDebounced.length > 0}
              aria-activedescendant={visibleSearchIndex !== null ? `sale-search-option-${searchMatches[visibleSearchIndex]?.item.id}` : undefined}
              className={cn(inputClass, "w-full px-3 py-2")}
              autoComplete="off"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  if (searchMatches.length === 0) return;
                  event.preventDefault();
                  const direction = event.key === "ArrowDown" ? 1 : -1;
                  setSearchActiveIndex((current) => current === null
                    ? (direction === 1 ? 0 : searchMatches.length - 1)
                    : (current + direction + searchMatches.length) % searchMatches.length);
                  return;
                }
                if (event.key !== "Enter" || searchQuery.trim() === "") return;
                event.preventDefault();
                if (searchDebounced !== searchQuery.trim() || catalogSearch.isPending || catalogSearch.isError) return;
                if (searchExact !== null) {
                  addLine(searchExact.item);
                } else {
                  const activeMatch = visibleSearchIndex === null ? undefined : searchMatches[visibleSearchIndex];
                  if (activeMatch !== undefined) addLine(activeMatch.item);
                  else if (searchMatches.length === 1 && searchMatches[0] !== undefined) addLine(searchMatches[0].item);
                }
              }}
              data-testid="sale-search"
            />
            {searchDebounced.length > 0 && catalogSearch.isError && <p role="alert" className="text-sm text-destructive" data-testid="sale-search-error">{tError(catalogSearch.error.message)}</p>}
            {searchExact !== null && (
              <button type="button" className="w-full rounded border bg-accent p-2 text-right hover:bg-accent/80" onClick={() => addLine(searchExact.item)} data-testid="sale-search-exact">
                {searchExact.item.name}
              </button>
            )}
            {searchDebounced.length > 0 && !catalogSearch.isPending && !catalogSearch.isError && searchMatches.length === 0 && searchExact === null && (
              <p className="text-sm text-muted-foreground" data-testid="sale-search-empty">{t("itemsSearchEmpty")}</p>
            )}
            {searchMatches.length > 0 && (
              <ul id="sale-search-results" role="listbox" aria-label={t("itemsSearchPlaceholder")} className="max-h-60 overflow-y-auto">
                {searchMatches.map((match, index) => (
                  <li key={match.item.id} id={`sale-search-option-${match.item.id}`} role="option" aria-selected={visibleSearchIndex === index}>
                    <button
                      type="button"
                      className={cn("flex w-full items-center justify-between rounded p-2 text-right", visibleSearchIndex === index ? "bg-accent ring-2 ring-inset ring-ring" : "hover:bg-accent/80")}
                      onClick={() => addLine(match.item)}
                      data-testid="sale-search-result"
                    >
                      <span>{match.item.name}</span>
                      <span className="rounded bg-accent px-2 py-0.5 text-xs text-accent-foreground">{t(matchBadgeKey(match.matchedBy))}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {lines.length === 0 && error && <p className="mx-4 mt-3 rounded border border-destructive/20 bg-destructive/10 p-2 text-sm text-destructive" data-testid="sale-error" role="alert">{error}</p>}

          {quick.open && (
            <form className="m-4 grid gap-3 rounded bg-accent p-3" onSubmit={quickSubmit} data-testid="sale-quick-form" aria-busy={quickCreatePending}>
              <div className="grid grid-cols-2 gap-3">
                <label className="grid gap-1 text-sm font-medium">{t("saleQuickName")}<input className="h-9 rounded-lg border border-input bg-background px-3 text-sm" name="quickName" autoComplete="off" disabled={quickCreatePending} value={quick.fields.name} onChange={(event) => quick.setField("name", event.target.value)} required data-testid="sale-quick-name" /></label>
                <label className="grid gap-1 text-sm font-medium">{t("saleQuickBarcode")}<input dir="ltr" className="h-9 rounded-lg border border-input bg-background px-3 text-sm" name="quickBarcode" autoComplete="off" disabled={quickCreatePending} value={quick.fields.barcode} onChange={(event) => quick.setField("barcode", event.target.value)} data-testid="sale-quick-barcode" /></label>
                <EntityPicker
                  label={t("itemsCategory")}
                  options={categories.data?.items ?? []}
                  value={quickCategory}
                  onChange={(nextCategoryId) => {
                    quick.setField("categoryId", nextCategoryId);
                    setDraftDirty(
                      draftDirtyWithoutQuickCategory ||
                        (nextCategoryId !== "" && nextCategoryId !== quickCategoryDefaultAtOpen.current),
                    );
                  }}
                  onCreate={(name) => {
                    setCategoryCreateError(null);
                    categoryCreate.mutate({ name });
                  }}
                  createLabel={(name) => t("categoriesCreateInline", { name })}
                  noMatchesLabel={t("categoriesNoMatches")}
                  name="quickCategory"
                  disabled={quickCategoriesLoading || quickCreatePending}
                  testId="sale-quick-category"
                />
                <label className="grid gap-1 text-sm font-medium">{t("itemsCost")}<input className="h-9 rounded-lg border border-input bg-background px-3 text-sm" name="quickCost" autoComplete="off" inputMode="numeric" disabled={quickCreatePending} value={quick.fields.cost} onChange={(event) => quick.setField("cost", event.target.value)} required /></label>
                <label className="grid gap-1 text-sm font-medium">{t("itemsSell")}<input className="h-9 rounded-lg border border-input bg-background px-3 text-sm" name="quickSell" autoComplete="off" inputMode="numeric" disabled={quickCreatePending} value={quick.fields.sell} onChange={(event) => quick.setField("sell", event.target.value)} required /></label>
                <label className="grid gap-1 text-sm font-medium">
                  {quickStockRequired ? t("saleQuickStockRequired") : t("saleQuickStock")}
                  <input ref={quickStockRef} className="h-9 rounded-lg border border-input bg-background px-3 text-sm" name="quickStock" autoComplete="off" inputMode="numeric" disabled={quickCreatePending} value={quick.fields.stock} onChange={(event) => quick.setField("stock", event.target.value)} aria-required={quickStockRequired || undefined} data-testid="sale-quick-stock" />
                </label>
              </div>
              {categoryCreateError && <p className="text-sm text-destructive" role="alert" data-testid="sale-quick-category-error">{categoryCreateError}</p>}
              <div className="flex gap-2"><Button type="submit" disabled={quickCreatePending || createInvoice.isPending}>{t("saleQuickSave")}</Button><Button type="button" variant="outline" onClick={() => quick.close()} disabled={quickCreatePending}>{t("dialogClose")}</Button></div>
            </form>
          )}

          {(priceMode.writeFailed || priceMode.isError) && <p role="status" className="px-4 text-sm text-destructive">{t("salePriceModeNotSaved")}</p>}
          <div className="p-4">
            {lines.length === 0 ? (
              <div data-testid="sale-empty">
                <EmptyState
                  icon={<ScanBarcode size={28} />}
                  title={t("saleEmptyTitle")}
                  hint={t("saleScanHint")}
                  action={
                    <Button size="lg" data-testid="sale-open-picker" title={`${t("saleAddItem")} (${shortcutKeys("onSale")})`} onClick={() => setPickerOpen(true)} disabled={createInvoice.isPending}>
                      {t("saleAddItem")}
                    </Button>
                  }
                />
              </div>
            ) : (
              <table className="w-full" data-testid="sale-lines">
                <thead><tr className="border-b text-right text-sm text-muted-foreground"><th className="p-2">{t("itemsName")}</th><th className="p-2">{t("saleQuantity")}</th><th className="p-2">{t("saleDefaultPrice")}</th><th className="p-2">{t("saleActualPrice")}</th><th className="p-2">{t("saleLineTotal")}</th><th className="p-2" /></tr></thead>
                <tbody>{lines.map((line) => { const price = saleUnitPrice(line); const quantity = lineQuantity(line); return <tr key={line.item.id} className="border-b last:border-0"><td className="p-2">{line.item.name}</td><td className="p-2"><input className={cn(inputClass, "w-16 px-2 py-1")} name={`quantity-${line.item.id}`} autoComplete="off" inputMode="numeric" value={line.quantityDraft} onChange={(event) => draft.setQuantity(line.item.id, event.target.value)} disabled={createInvoice.isPending} aria-label={`${line.item.name}: ${t("saleQuantity")}`} /></td><td className="p-2"><Amount value={line.item.sellingPrice} /></td><td className="p-2"><SaleLinePriceEditor line={line} preferredMode={priceMode.value} onMode={(mode) => priceMode.setValue(mode)} onChange={(override) => { draft.patch(line.item.id, override); setDraftDirty(true); }} disabled={createInvoice.isPending} /></td><td className="p-2"><Amount value={quantity * price} /></td><td className="p-2"><button type="button" className="rounded p-1 text-destructive hover:bg-destructive/10 disabled:opacity-50" aria-label={`${t("removeRow")} ${line.item.name}`} onClick={() => { const last = lines.length === 1; draft.remove(line.item.id); if (last) { setDiscountType(""); setDiscountValue(""); setDiscountExpanded(false); } setDraftDirty(lines.length > 1 || anyTyped([customer.name, last ? "" : discountValue, payment.amount, payment.percentage]) || (!last && discountType !== "") || quickDraft); }} disabled={createInvoice.isPending}><X size={16} aria-hidden="true" /></button></td></tr>; })}</tbody>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* The existing sticky bar keeps totals and checkout reachable at short heights. */}
      {lines.length > 0 && (
        <CheckoutBar testId="sale-checkout-bar" className="mt-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
            {discountExpanded ? (
              <div className="flex flex-wrap items-end gap-3">
                <label className="grid gap-1 text-sm font-medium">{t("saleDiscountType")}<Select value={discountType} onValueChange={(value) => { setDiscountType(toAmountKind(value ?? "")); setDraftDirty(true); }} disabled={createInvoice.isPending} name="discountType" items={[{ value: "", label: t("saleNoDiscount") }, { value: "AMOUNT", label: t("saleDiscountAmount") }, { value: "PERCENTAGE", label: t("saleDiscountPercentage") }]}><SelectTrigger ref={discountTypeRef} className="w-40" data-testid="sale-discount-type"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="">{t("saleNoDiscount")}</SelectItem><SelectItem value="AMOUNT">{t("saleDiscountAmount")}</SelectItem><SelectItem value="PERCENTAGE">{t("saleDiscountPercentage")}</SelectItem></SelectContent></Select></label>
                <label className="grid gap-1 text-sm font-medium">{t("saleDiscountValue")}<input className="h-9 w-32 rounded-lg border border-input bg-background px-3 text-sm" name="discountValue" autoComplete="off" inputMode="numeric" value={discountValue} onChange={(event) => setDiscountValue(event.target.value)} disabled={discountType === "" || createInvoice.isPending} data-testid="sale-discount-value" /></label>
              </div>
            ) : (
              <Button type="button" variant="outline" size="sm" data-testid="sale-add-discount" onClick={() => setDiscountExpanded(true)} disabled={createInvoice.isPending}>
                {t("saleAddDiscount")}
              </Button>
            )}
            <dl data-testid="sale-totals" className="grid gap-1 text-end text-sm">
              <div className="flex items-baseline justify-between gap-6"><dt className="text-muted-foreground">{t("saleSubtotal")}</dt><dd data-testid="sale-subtotal"><Amount value={subtotal} /></dd></div>
              {discountAmount > 0 && <div className="flex items-baseline justify-between gap-6"><dt className="text-muted-foreground">{t("saleDiscount")}</dt><dd data-testid="sale-discount"><Amount value={-discountAmount} /></dd></div>}
              <div className="flex items-baseline justify-between gap-6 text-lg font-bold"><dt>{t("saleTotal")}</dt><dd data-testid="sale-total"><Amount value={total} /></dd></div>
            </dl>
          </div>
          {notice.valid && notice.debt > 0 && (
            <p className="rounded border border-warning/30 bg-warning/10 p-2 text-sm" data-testid="sale-debt-notice">
              {hasCustomer ? t("saleDebtWillBeCreated") : t("saleRemainderWillBeCreated")} <Amount value={notice.debt} /> {hasCustomer && t("saleDebtCustomer")} {t("saleDebtEstimate")}
            </p>
          )}
          {error && <p className="rounded border border-destructive/20 bg-destructive/10 p-2 text-sm text-destructive" data-testid="sale-error" role="alert">{error}</p>}
          <Button size="lg" className="w-full" onClick={submit} disabled={createInvoice.isPending || createItem.isPending || createWithStock.isPending} data-testid="sale-save">
            {createInvoice.isPending ? t("saleSaving") : t("saleSave")} <span aria-hidden="true"> · </span><Amount value={total} />
          </Button>
        </CheckoutBar>
      )}

      <ItemPickerDialog open={pickerOpen} onClose={() => setPickerOpen(false)} onSelect={addLine} />
      {unknownCode !== null && <UnknownScanDialog code={unknownCode} onClose={() => setUnknownCode(null)} onCreate={() => { setUnknownCode(null); openQuick(unknownCode); }} onCreateWithStock={() => { setUnknownCode(null); openQuick(unknownCode, true); }} onManualLine={() => { setUnknownCode(null); setPickerOpen(true); }} />}
    </section>
  );
}
