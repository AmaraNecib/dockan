import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import type { InvoiceDetail, Item } from "@dokan/contracts";
import { PackagePlus, X } from "lucide-react";

import { ItemPickerDialog } from "@/components/catalog/item-picker-dialog";
import { InvoiceHeader } from "@/components/invoice-header";
import { PartyPicker, type PartySelection } from "@/components/parties/party-picker";
import { Amount } from "@/components/ui/amount";
import { AmountPercentageInput, amountFromPercentage, parseWholeAmount, parseWholePercentage, percentageDraftInvalid, percentageFromAmount } from "@/components/ui/amount-percentage-input";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { inputClass } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SuccessCard, SuccessCardSpacer } from "@/components/ui/success-card";
import { cn } from "@/lib/utils";
import { CheckoutBar } from "../components/app/checkout-bar";

import { tError } from "../lib/i18n";
import { orpc } from "../lib/rpc";

/**
 * Ticket 29 — purchase intake (/purchase): multi-line PURCHASE invoices with
 * an inline quick-add, then the deferred-linking proposal panel that attributes
 * earlier uninvoiced stock (stock_links) to the saved invoice.
 */

type DraftLine = { item: Item; quantity: number; unitCost: number };

export function PurchasePage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const categories = useQuery(orpc.categoriesList.queryOptions());

  const [pickerOpen, setPickerOpen] = useState(false);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [supplier, setSupplier] = useState<PartySelection>({ id: null, name: "", needsChoice: false });
  const [notes, setNotes] = useState("");
  const [paidNow, setPaidNow] = useState("");
  // #162 — the initial payment is a share of the cart total (amount ⇄ percentage)
  const [paidPercentage, setPaidPercentage] = useState("");
  const paidSource = useRef<"amount" | "percentage" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedInvoice, setSavedInvoice] = useState<InvoiceDetail | null>(null);

  // quick-add mini-form state: item fields + the line it lands as
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickName, setQuickName] = useState("");
  const [quickBarcode, setQuickBarcode] = useState("");
  const [quickCategoryId, setQuickCategoryId] = useState("");
  const [quickSellPrice, setQuickSellPrice] = useState("");
  const [quickThreshold, setQuickThreshold] = useState("");
  const [quickQty, setQuickQty] = useState("1");
  const [quickUnitCost, setQuickUnitCost] = useState("");

  const addLine = (item: Item) => {
    setLines((current) => {
      const existing = current.find((line) => line.item.id === item.id);
      if (existing) {
        return current.map((line) => (line.item.id === item.id ? { ...line, quantity: line.quantity + 1 } : line));
      }
      return [...current, { item, quantity: 1, unitCost: item.costPrice }];
    });
    setPickerOpen(false);
  };

  const createItem = useMutation(orpc.itemsCreate.mutationOptions());

  const createInvoice = useMutation(
    orpc.invoicesCreate.mutationOptions({
      onSuccess: (invoice) => {
        setSavedInvoice(invoice);
        setLines([]);
        setSupplier({ id: null, name: "", needsChoice: false });
        setNotes("");
        setPaidNow("");
        setPaidPercentage("");
        paidSource.current = null;
        void queryClient.invalidateQueries({ queryKey: orpc.itemsList.queryKey() });
      },
      onError: (err) => setError(tError(err.message)),
    }),
  );

  const total = lines.reduce((sum, line) => sum + line.quantity * line.unitCost, 0);

  // #162 — keep the pair linked as the cart total changes (same rule as sale)
  useEffect(() => {
    if (total === 0) {
      // a percentage-based payment falls to zero with the total; a typed amount
      // survives; an untouched pair follows the empty cart
      if (paidSource.current === "percentage") {
        setPaidNow("0");
        return;
      }
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

  function submit() {
    setError(null);
    if (lines.length === 0) {
      setError(t("purchasesLinesEmpty"));
      return;
    }
    // an exact typed name that belongs to a record must be picked first: saving
    // it as typed-only would hide the invoice from that record (P1.1)
    if (supplier.needsChoice === true) {
      setError(t("partyChooseExisting"));
      return;
    }
    const paid = paidNow === "" ? undefined : Number(paidNow);
    // an invalid percentage draft clears the amount, which would otherwise take
    // the intentional "unpaid" path and save silently
    if (percentageDraftInvalid(paidPercentage)) {
      setError(t("purchasesInvalidPaid"));
      return;
    }
    if (paid !== undefined && (!Number.isSafeInteger(paid) || paid < 0)) {
      setError(t("purchasesInvalidPaid"));
      return;
    }
    if (paid !== undefined && paid > total) {
      setError(t("purchasesInvalidPaid"));
      return;
    }
    void createInvoice.mutate({
      kind: "PURCHASE",
      // the picker keeps the picked record's id; a typed-only name stays null
      counterpartyId: supplier.id === null ? undefined : supplier.id,
      counterpartyName: supplier.name.trim() === "" ? undefined : supplier.name.trim(),
      notes: notes.trim() === "" ? undefined : notes.trim(),
      // the api requires a POSITIVE initialPaid; a zero draft (0% or a small
      // percentage that rounds to 0) means "nothing paid now"
      initialPaid: paid === 0 ? undefined : paid,
      lines: lines.map((line) => ({ itemId: line.item.id, quantity: line.quantity, unitPrice: line.unitCost })),
    });
  }

  function quickSubmit() {
    setError(null);
    if (quickCategoryId === "") {
      setError(t("itemsChooseCategory"));
      return;
    }
    const qty = Number(quickQty);
    const unitCost = Number(quickUnitCost);
    if (!Number.isInteger(qty) || qty < 1) {
      setError(t("purchasesInvalidQuantity"));
      return;
    }
    if (!Number.isInteger(unitCost) || unitCost <= 0) {
      setError(t("purchasesInvalidCost"));
      return;
    }
    void createItem.mutate(
      {
        name: quickName,
        categoryId: quickCategoryId,
        costPrice: unitCost,
        sellingPrice: quickSellPrice === "" ? unitCost : Number(quickSellPrice),
        lowStockThreshold: quickThreshold === "" ? undefined : Number(quickThreshold),
        barcode: quickBarcode.trim() === "" ? undefined : quickBarcode.trim(),
      },
      {
        // straight back to the line: the purchase line itself is the stock
        // event, so the freshly created item lands as a line immediately
        onSuccess: (item) => {
          setLines((current) => [...current.filter((line) => line.item.id !== item.id), { item, quantity: qty, unitCost }]);
          setQuickOpen(false);
          setQuickName("");
          setQuickBarcode("");
          setQuickSellPrice("");
          setQuickThreshold("");
          setQuickQty("1");
          setQuickUnitCost("");
        },
        onError: (err) => setError(tError(err.message)),
      },
    );
  }

  return (
    <section>
      <h1 className="text-xl font-bold">{t("purchasesTitle")}</h1>

      {savedInvoice && (
        <div className="mt-4 grid gap-4" data-testid="purchase-saved">
          <div className="rounded border bg-card p-4">
            <InvoiceHeader />
            <SuccessCard
              className="mt-3"
              title={<span data-testid="purchase-saved-number">{t("purchasesSaved", { number: savedInvoice.invoiceNumber })}</span>}
              detail={
                savedInvoice.remainingAmount > 0 ? (
                  <span data-testid="purchase-saved-debt">
                    {savedInvoice.counterpartyName === null || savedInvoice.counterpartyName.trim() === "" ? t("purchasesSavedUnattributed") : t("purchasesSavedRemaining")}{" "}
                    <Amount value={savedInvoice.remainingAmount} suffix={t("dzd")} />
                  </span>
                ) : undefined
              }
            >
              <Button asChild>
                <Link to="/invoices/$invoiceId" params={{ invoiceId: savedInvoice.id }} data-testid="purchase-open-invoice">{t("savedViewInvoice")}</Link>
              </Button>
              <Button asChild variant="outline">
                <Link to="/invoices/$invoiceId/print" params={{ invoiceId: savedInvoice.id }} data-testid="purchase-print">{t("savedPrint")}</Link>
              </Button>
              <SuccessCardSpacer />
              <Button variant="ghost" onClick={() => setSavedInvoice(null)} data-testid="purchase-new">{t("purchasesNewInvoice")}</Button>
            </SuccessCard>
          </div>
          <LinkProposalPanel invoiceId={savedInvoice.id} />
        </div>
      )}

      {!savedInvoice && (
        <div className="mt-4 grid gap-4" data-testid="purchase-form">
          <div className="grid gap-3 rounded border border-border bg-card p-4">
            <PartyPicker
              role="supplier"
              label={t("purchasesSupplier")}
              value={supplier}
              onChange={setSupplier}
              disabled={createInvoice.isPending}
              testId="purchase-supplier"
            />
            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-1 text-sm font-medium">
                {t("purchasesNotes")}
                <input className="h-9 rounded-lg border border-input bg-background px-3 text-sm" name="notes" autoComplete="off" value={notes} onChange={(e) => setNotes(e.target.value)} />
              </label>
              <AmountPercentageInput
                referenceTotal={total > 0 ? total : null}
                value={{ amount: paidNow, percentage: paidPercentage }}
                onChange={(next, edited) => {
                  paidSource.current = edited;
                  setPaidNow(next.amount);
                  setPaidPercentage(next.percentage);
                }}
                amountLabel={t("purchasesPaidNow")}
                amountTestId="purchase-paid"
                percentageTestId="purchase-paid-percentage"
                referenceTestId="purchase-paid-reference"
                percentageInvalid={percentageDraftInvalid(paidPercentage)}
                disabled={createInvoice.isPending}
              />
            </div>
          </div>

          <div className="rounded border border-border bg-card">
            {/* Same hierarchy as the sale screen: the list picker is the single
                primary path; the inline create form is demoted to outline. */}
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
              <h2 className="me-auto text-sm font-semibold">{t("purchasesLinesTitle")}</h2>
              {lines.length > 0 && (
                <Button data-testid="purchase-open-picker" onClick={() => setPickerOpen(true)}>
                  {t("purchasesAddItem")}
                </Button>
              )}
              <Button variant="outline" data-testid="purchase-toggle-quick" aria-expanded={quickOpen} onClick={() => setQuickOpen((open) => !open)}>
                {t("purchasesQuickAddBtn")}
              </Button>
            </div>

            {lines.length === 0 && error && <p className="mx-4 mt-3 rounded border border-destructive/20 bg-destructive/10 p-2 text-sm text-destructive" data-testid="purchase-error" role="alert">{error}</p>}

            {quickOpen && (
              <form
                className="m-4 grid gap-3 rounded bg-accent p-3"
                // SAFETY: preventDefault keeps the SPA from native-posting;
                // stopPropagation keeps the event away from any wrapper form
                onSubmit={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  quickSubmit();
                }} data-testid="purchase-quick-form">
                <div className="grid grid-cols-2 gap-3">
                  <label className="grid gap-1 text-sm font-medium">
                    {t("purchasesQuickName")}
                    <input className="h-9 rounded-lg border border-input bg-background px-3 text-sm" name="quickName" autoComplete="off" required value={quickName} onChange={(e) => setQuickName(e.target.value)} data-testid="quick-name" />
                  </label>
                  <label className="grid gap-1 text-sm font-medium">
                    {t("purchasesQuickBarcode")}
                    <input className="h-9 rounded-lg border border-input bg-background px-3 text-sm" name="quickBarcode" autoComplete="off" dir="ltr" value={quickBarcode} onChange={(e) => setQuickBarcode(e.target.value)} />
                  </label>
                  <label className="grid gap-1 text-sm font-medium">
                    {t("purchasesQuickCategory")}
                    <Select
                      value={quickCategoryId}
                      onValueChange={(value) => setQuickCategoryId(value ?? "")}
                      items={[
                        { value: "", label: "—" },
                        ...(categories.data?.items.map((category) => ({ value: category.id, label: category.name })) ?? []),
                      ]}
                    >
                      <SelectTrigger className="w-full">
                        <SelectValue placeholder="—" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="">—</SelectItem>
                        {categories.data?.items.map((category) => (
                          <SelectItem key={category.id} value={category.id}>
                            {category.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                  <label className="grid gap-1 text-sm font-medium">
                    {t("itemsSell")}
                    <input className="h-9 rounded-lg border border-input bg-background px-3 text-sm" name="quickSell" autoComplete="off" inputMode="numeric" value={quickSellPrice} onChange={(e) => setQuickSellPrice(e.target.value)} />
                  </label>
                  <label className="grid gap-1 text-sm font-medium">
                    {t("itemsThreshold")}
                    <input className="h-9 rounded-lg border border-input bg-background px-3 text-sm" name="quickThreshold" autoComplete="off" inputMode="numeric" value={quickThreshold} onChange={(e) => setQuickThreshold(e.target.value)} />
                  </label>
                  <label className="grid gap-1 text-sm font-medium">
                    {t("purchasesLineQty")}
                    <input className="h-9 rounded-lg border border-input bg-background px-3 text-sm" name="quickQty" autoComplete="off" required inputMode="numeric" value={quickQty} onChange={(e) => setQuickQty(e.target.value)} data-testid="quick-qty" />
                  </label>
                  <label className="grid gap-1 text-sm font-medium">
                    {t("purchasesLineCost")}
                    <input className="h-9 rounded-lg border border-input bg-background px-3 text-sm" name="quickUnitCost" autoComplete="off" required inputMode="numeric" value={quickUnitCost} onChange={(e) => setQuickUnitCost(e.target.value)} data-testid="quick-cost" />
                  </label>
                </div>
                <Button type="submit" disabled={createItem.isPending}>
                  {t("purchasesQuickAddBtn")}
                </Button>
              </form>
            )}

            <div className="p-4">
              {lines.length === 0 ? (
                <div data-testid="purchase-empty">
                  <EmptyState
                    icon={<PackagePlus size={28} />}
                    title={t("purchasesEmptyTitle")}
                    hint={t("purchasesEmptyHint")}
                    action={
                      <Button size="lg" data-testid="purchase-open-picker" onClick={() => setPickerOpen(true)}>
                        {t("purchasesAddItem")}
                      </Button>
                    }
                  />
                </div>
              ) : (
                <table className="w-full" data-testid="purchase-lines">
                  <thead>
                    <tr className="border-b text-right text-sm text-muted-foreground">
                      <th className="p-2">{t("itemsName")}</th>
                      <th className="p-2">{t("purchasesLineQty")}</th>
                      <th className="p-2">{t("purchasesLineCost")}</th>
                      <th className="p-2">{t("purchasesTotal")}</th>
                      <th className="p-2"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {lines.map((line, index) => (
                      <tr key={line.item.id} className="border-b last:border-0">
                        <td className="p-2">{line.item.name}</td>
                        <td className="p-2">
                          <input
                            className={cn(inputClass, "w-16 px-2 py-1")}
                            name={`quantity-${line.item.id}`}
                            autoComplete="off"
                            inputMode="numeric"
                            value={String(line.quantity)}
                            onChange={(e) => {
                              const parsed = Number(e.target.value);
                              if (Number.isInteger(parsed) && parsed >= 1) {
                                setLines((current) => current.map((l, i) => (i === index ? { ...l, quantity: parsed } : l)));
                              }
                            }}
                            aria-label={`${line.item.name}: ${t("purchasesLineQty")}`}
                          />
                        </td>
                        <td className="p-2">
                          <input
                            className={cn(inputClass, "w-20 px-2 py-1")}
                            name={`unitCost-${line.item.id}`}
                            autoComplete="off"
                            inputMode="numeric"
                            value={String(line.unitCost)}
                            onChange={(e) => {
                              const parsed = Number(e.target.value);
                              if (Number.isInteger(parsed) && parsed >= 0) {
                                setLines((current) => current.map((l, i) => (i === index ? { ...l, unitCost: parsed } : l)));
                              }
                            }}
                            aria-label={`${line.item.name}: ${t("purchasesLineCost")}`}
                          />
                        </td>
                        <td className="p-2">{line.quantity * line.unitCost}</td>
                        <td className="p-2">
                          <button type="button" className="rounded p-1 text-destructive hover:bg-destructive/10" aria-label={`${t("removeRow")} ${line.item.name}`} onClick={() => setLines((current) => current.filter((_, i) => i !== index))}>
                            <X size={16} aria-hidden="true" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {lines.length > 0 && (
            <CheckoutBar testId="purchase-checkout-bar">
                {error && <p className="rounded border border-destructive/20 bg-destructive/10 p-2 text-sm text-destructive" data-testid="purchase-error" role="alert">{error}</p>}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-lg font-bold" data-testid="purchase-total">
                    {t("purchasesTotal")}: <Amount value={total} />
                  </p>
                  <Button size="lg" className="min-w-44" type="button" onClick={submit} disabled={createInvoice.isPending} data-testid="purchase-save">
                    {t("purchasesSave")}
                  </Button>
                </div>
            </CheckoutBar>
          )}
        </div>
      )}

      <ItemPickerDialog open={pickerOpen} onClose={() => setPickerOpen(false)} onSelect={addLine} />
    </section>
  );
}

/** Post-save proposal: one-click attribution of earlier uninvoiced stock */
export function LinkProposalPanel({ invoiceId }: { invoiceId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const proposal = useQuery(orpc.purchasesProposal.queryOptions({ input: { invoiceId } }));
  const [linkedMsg, setLinkedMsg] = useState<string | null>(null);

  const link = useMutation(
    orpc.purchasesLinkStock.mutationOptions({
      onSuccess: (result) => {
        setLinkedMsg(t("purchasesLinked", { linked: result.linked, remainder: result.remainderMoved }));
        // SAFETY: without this refetch the stale proposal keeps showing the old
        // proposedLinkQty with an enabled button, and a second submit reports
        // zero units linked (greptile round-2)
        void queryClient.invalidateQueries({
          queryKey: orpc.purchasesProposal.queryKey({ input: { invoiceId } }),
        });
      },
      onError: (err) => setLinkedMsg(tError(err.message)),
    }),
  );

  const linkable = (proposal.data?.items ?? []).filter((row) => row.proposedLinkQty > 0);

  return (
    <div className="mt-3 rounded bg-accent p-3" data-testid="link-proposal">
      <h3 className="font-semibold">{t("purchasesProposalTitle")}</h3>
      {proposal.isPending ? null : linkable.length === 0 ? (
        <p className="mt-1 text-sm text-muted-foreground">{t("purchasesProposalEmpty")}</p>
      ) : (
        <ul className="mt-2 grid gap-2">
          {linkable.map((row) => (
            <li key={row.itemId} className="flex items-center justify-between gap-2">
              <span>
                {row.itemName} — {t("purchasesProposalUninvoiced")} {row.uninvoicedQty}
              </span>
              <button
                type="button"
                className="rounded-lg bg-primary px-3 py-1 text-sm text-primary-foreground disabled:opacity-50"
                disabled={link.isPending}
                onClick={() => link.mutate({ invoiceId, allocations: [{ itemId: row.itemId, quantity: row.proposedLinkQty }] })}
              >
                {t("purchasesLinkBtn")} ({row.proposedLinkQty})
              </button>
            </li>
          ))}
        </ul>
      )}
      {linkedMsg && (
        <p className="mt-2 text-sm text-success" data-testid="link-result">
          {linkedMsg}
        </p>
      )}
    </div>
  );
}
