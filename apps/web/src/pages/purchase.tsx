import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { InvoiceDetail, Item } from "@dokan/contracts";
import { PackagePlus, X } from "lucide-react";

import { ItemPickerDialog } from "@/components/catalog/item-picker-dialog";
import { InvoiceHeader } from "@/components/invoice-header";
import { PartyPicker, type PartySelection } from "@/components/parties/party-picker";
import { Amount } from "@/components/ui/amount";
import { AmountPercentageInput } from "@/components/ui/amount-percentage-input";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { inputClass } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SuccessCard, SuccessCardSpacer } from "@/components/ui/success-card";
import { parseLooseNumber, percentageDraftInvalid } from "@/lib/amount-parse";
import { firstCommitError, lineQuantity, nextUnitCost, parseQuantityDraft, purchaseUnitPrice, quantityDraftInvalid, resolvedInitialPaid, resolveInitialPaid, type PurchaseDraftLine } from "@/lib/invoice-draft";
import { useInvoiceDraft, usePaymentPair, useQuickAdd, type QuickAddOutcome, type QuickAddSpec } from "@/lib/use-invoice-draft";
import { cn } from "@/lib/utils";
import { CheckoutBar } from "../components/app/checkout-bar";

import { tError } from "../lib/i18n";
import { orpc } from "../lib/rpc";

/**
 * Ticket 29 — purchase intake (/purchase): multi-line PURCHASE invoices with
 * an inline quick-add, then the deferred-linking proposal panel that attributes
 * earlier uninvoiced stock (stock_links) to the saved invoice.
 *
 * #146 — the draft mechanics (line list, quantity parser, totals, the
 * amount ⇄ percentage payment pair, the quick-add flow) come from the shared
 * invoice-draft module; this page adds only the fields a purchase has.
 */

/** The per-kind draft rules; module scope keeps the config identity stable. */
const PURCHASE_DRAFT = {
  emptyLine: (item: Item): PurchaseDraftLine => ({ item, quantityDraft: "1", unitCost: item.costPrice }),
  unitPrice: purchaseUnitPrice,
};

/** The quick-add field bag; purchase keeps what is typed across a close. */
type PurchaseQuickFields = { name: string; barcode: string; categoryId: string; sellPrice: string; threshold: string; qty: string; unitCost: string };

const PURCHASE_QUICK = {
  empty: (): PurchaseQuickFields => ({ name: "", barcode: "", categoryId: "", sellPrice: "", threshold: "", qty: "1", unitCost: "" }),
  resetOnOpen: false,
  // the owner stocks several items in one sitting, so a successful create keeps
  // the destination category. The old handler cleared the item fields and kept
  // quickCategoryId for the same reason.
  keepOnCreate: ["categoryId"],
} satisfies QuickAddSpec<PurchaseQuickFields>;

export function PurchasePage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const categories = useQuery(orpc.categoriesList.queryOptions());

  const [pickerOpen, setPickerOpen] = useState(false);
  const [supplier, setSupplier] = useState<PartySelection>({ id: null, name: "", needsChoice: false });
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savedInvoice, setSavedInvoice] = useState<InvoiceDetail | null>(null);

  const draft = useInvoiceDraft(PURCHASE_DRAFT);
  const { lines } = draft;

  const addLine = (item: Item) => {
    draft.addItem(item);
    setPickerOpen(false);
  };

  const createItem = useMutation(orpc.itemsCreate.mutationOptions());

  const total = draft.subtotal;
  // #162 — the initial payment is a share of the cart total; the shared pair
  // keeps amount and percentage linked as the total changes.
  const payment = usePaymentPair(total);

  const createInvoice = useMutation(
    orpc.invoicesCreate.mutationOptions({
      onSuccess: (invoice) => {
        setSavedInvoice(invoice);
        draft.reset();
        setSupplier({ id: null, name: "", needsChoice: false });
        setNotes("");
        payment.reset();
        void queryClient.invalidateQueries({ queryKey: orpc.itemsAll.queryKey() });
      },
      onError: (err) => setError(tError(err.message)),
    }),
  );

  // the explicit type argument pins F, so a later edit to the callbacks cannot
  // widen the bag and quietly disable key checking
  const quick = useQuickAdd<PurchaseQuickFields>(PURCHASE_QUICK, {
    onCreated: (item, fields) => {
      // straight back to the line: the purchase line itself is the stock event,
      // so the freshly created item lands as a line immediately, replacing any
      // line the same item already had
      draft.remove(item.id);
      // SAFETY: quickSubmit rejects any quantity the shared parser cannot read
      // as a whole 1..MAX_DRAFT_QUANTITY, so the resolved number is always a
      // valid draft here.
      draft.addItem(item, { quantityDraft: String(parseQuantityDraft(fields.qty)), unitCost: parseLooseNumber(fields.unitCost) });
    },
    setError,
  });

  function submit() {
    setError(null);
    // `firstCommitError` owns the check order — empty cart → party → per-line
    // quantity → payment — shared with sale, so a future reorder cannot fix one
    // screen and miss the other. The raw quantity drafts are validated before
    // the payment: a cleared quantity zeroes the total, so a payment typed
    // against the old total would otherwise fail the amount-vs-total check and
    // show «purchasesInvalidPaid», masking the real problem.
    //
    // #146: the quantity field is the shared draft now, so an unusable draft is
    // refused instead of silently keeping a stale quantity (the old
    // `Number(event.target.value)` handler dropped the keystroke).
    const paid = resolveInitialPaid(total, payment.amount, payment.percentage);
    const commitError = firstCommitError({
      lines,
      linesEmpty: t("purchasesLinesEmpty"),
      partyNeedsChoice: supplier.needsChoice === true,
      partyNeedsChoiceMessage: t("partyChooseExisting"),
      quantity: { invalid: (line) => quantityDraftInvalid(line.quantityDraft), message: t("purchasesInvalidQuantity") },
      payment: { invalid: !paid.ok, message: t("purchasesInvalidPaid") },
    });
    if (commitError !== null) {
      setError(commitError);
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
      initialPaid: resolvedInitialPaid(paid),
      lines: lines.map((line) => ({ itemId: line.item.id, quantity: parseQuantityDraft(line.quantityDraft), unitPrice: line.unitCost })),
    });
  }

  function quickSubmit() {
    void quick.submit(async (fields) => {
      if (fields.categoryId === "") return { ok: false, error: t("itemsChooseCategory") };
      // the shared draft rule bounds the quick quantity too: an over-cap value
      // would land a line that resolves to zero and could never be saved
      const qty = parseQuantityDraft(fields.qty);
      const unitCost = parseLooseNumber(fields.unitCost);
      if (qty < 1) return { ok: false, error: t("purchasesInvalidQuantity") };
      if (!Number.isInteger(unitCost) || unitCost <= 0) return { ok: false, error: t("purchasesInvalidCost") };
      return await new Promise<QuickAddOutcome>((resolve) => {
        createItem.mutate(
          {
            name: fields.name,
            categoryId: fields.categoryId,
            costPrice: unitCost,
            sellingPrice: fields.sellPrice === "" ? unitCost : parseLooseNumber(fields.sellPrice),
            lowStockThreshold: fields.threshold === "" ? undefined : parseLooseNumber(fields.threshold),
            barcode: fields.barcode.trim() === "" ? undefined : fields.barcode.trim(),
          },
          { onSuccess: (item) => resolve({ ok: true, item }), onError: (err) => resolve({ ok: false, error: tError(err.message) }) },
        );
      });
    });
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
                value={{ amount: payment.amount, percentage: payment.percentage }}
                onChange={payment.onChange}
                amountLabel={t("purchasesPaidNow")}
                amountTestId="purchase-paid"
                percentageTestId="purchase-paid-percentage"
                referenceTestId="purchase-paid-reference"
                percentageInvalid={percentageDraftInvalid(payment.percentage)}
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
              <Button variant="outline" data-testid="purchase-toggle-quick" aria-expanded={quick.open} onClick={() => quick.toggle()}>
                {t("purchasesQuickAddBtn")}
              </Button>
            </div>

            {lines.length === 0 && error && <p className="mx-4 mt-3 rounded border border-destructive/20 bg-destructive/10 p-2 text-sm text-destructive" data-testid="purchase-error" role="alert">{error}</p>}

            {quick.open && (
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
                    <input className="h-9 rounded-lg border border-input bg-background px-3 text-sm" name="quickName" autoComplete="off" required value={quick.fields.name} onChange={(e) => quick.setField("name", e.target.value)} data-testid="quick-name" />
                  </label>
                  <label className="grid gap-1 text-sm font-medium">
                    {t("purchasesQuickBarcode")}
                    <input className="h-9 rounded-lg border border-input bg-background px-3 text-sm" name="quickBarcode" autoComplete="off" dir="ltr" value={quick.fields.barcode} onChange={(e) => quick.setField("barcode", e.target.value)} />
                  </label>
                  <label className="grid gap-1 text-sm font-medium">
                    {t("purchasesQuickCategory")}
                    <Select
                      value={quick.fields.categoryId}
                      onValueChange={(value) => quick.setField("categoryId", value ?? "")}
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
                    <input className="h-9 rounded-lg border border-input bg-background px-3 text-sm" name="quickSell" autoComplete="off" inputMode="numeric" value={quick.fields.sellPrice} onChange={(e) => quick.setField("sellPrice", e.target.value)} />
                  </label>
                  <label className="grid gap-1 text-sm font-medium">
                    {t("itemsThreshold")}
                    <input className="h-9 rounded-lg border border-input bg-background px-3 text-sm" name="quickThreshold" autoComplete="off" inputMode="numeric" value={quick.fields.threshold} onChange={(e) => quick.setField("threshold", e.target.value)} />
                  </label>
                  <label className="grid gap-1 text-sm font-medium">
                    {t("purchasesLineQty")}
                    <input className="h-9 rounded-lg border border-input bg-background px-3 text-sm" name="quickQty" autoComplete="off" required inputMode="numeric" value={quick.fields.qty} onChange={(e) => quick.setField("qty", e.target.value)} data-testid="quick-qty" />
                  </label>
                  <label className="grid gap-1 text-sm font-medium">
                    {t("purchasesLineCost")}
                    <input className="h-9 rounded-lg border border-input bg-background px-3 text-sm" name="quickUnitCost" autoComplete="off" required inputMode="numeric" value={quick.fields.unitCost} onChange={(e) => quick.setField("unitCost", e.target.value)} data-testid="quick-cost" />
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
                    {lines.map((line) => (
                      <tr key={line.item.id} className="border-b last:border-0">
                        <td className="p-2">{line.item.name}</td>
                        <td className="p-2">
                          <input
                            className={cn(inputClass, "w-16 px-2 py-1")}
                            name={`quantity-${line.item.id}`}
                            autoComplete="off"
                            inputMode="numeric"
                            value={line.quantityDraft}
                            onChange={(e) => draft.setQuantity(line.item.id, e.target.value)}
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
                            onChange={(e) => draft.patch(line.item.id, { unitCost: nextUnitCost(e.target.value, line.unitCost) })}
                            aria-label={`${line.item.name}: ${t("purchasesLineCost")}`}
                          />
                        </td>
                        <td className="p-2">{lineQuantity(line) * line.unitCost}</td>
                        <td className="p-2">
                          <button type="button" className="rounded p-1 text-destructive hover:bg-destructive/10" aria-label={`${t("removeRow")} ${line.item.name}`} onClick={() => draft.remove(line.item.id)}>
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
