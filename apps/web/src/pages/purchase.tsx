import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Fragment, useEffect, useRef, useState } from "react";
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
import { draftBlank, parseLooseNumber, percentageDraftInvalid } from "@/lib/amount-parse";
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
 *
 * #257 — the screen has two create entry points on purpose. The header's
 * «منتج جديد سريعاً» form is the "stock several products in one sitting" path
 * (it asks for quantity and cost itself and lands each created item as a new
 * line, keeping the category pick); a line's «منتج جديد» form is the "this row
 * is the product I am missing" path, seeding the product's cost from the line
 * and keeping the quantity and cost already typed there. They share the
 * `itemsCreate` call and the catalogue refresh, not a form.
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

/**
 * The line-scoped create form (#257). It asks only for what the line cannot
 * already answer: the name, the category and the selling price. The cost comes
 * from the line's own unit cost — the price the owner says he paid, or the zero
 * he is about to replace. It deliberately does NOT go through `useQuickAdd`: the
 * hook's `submit` ends by resetting a bag for a FRESH form, while this form owns
 * a target line, an abandonment guard and a focus obligation, so its lifecycle
 * is not the hook's. Sharing one hook is a follow-up, not a copy worth growing.
 *
 * The caret obligation: after a create the quantity input takes focus (the cost
 * is the field the owner is likely to type next, but the ticket's "quantity,
 * then unit cost" is read as the typing order of the line, and the caret on the
 * quantity is where that order starts).
 */
interface LineCreateDraft {
  /** the line being created for, by the item id it currently holds */
  target: string;
  name: string;
  categoryId: string;
  sellPrice: string;
}

/** Which line the catalog picker is choosing for; an append is not a line yet. */
type PickerTarget = { kind: "append" } | { kind: "line"; itemId: string };

/** What owes the caret after a commit: a line's quantity, or its create trigger. */
interface FocusRequest {
  kind: "quantity" | "trigger";
  itemId: string;
  /** monotonic, so a repeat request for the same line still runs the effect */
  seq: number;
}

/**
 * The line create whose landing is still owed (#257 review round 2): the item id
 * it will re-point, and the attempt that owns it. `attempt` keeps an answered
 * request from clearing a newer create's place in the queue.
 */
interface PendingLineCreate {
  target: string;
  attempt: number;
}

/** The create row's id, so the line's button can point `aria-controls` at it. */
function lineCreateFormId(itemId: string): string {
  return `purchase-line-product-form-${itemId}`;
}

/**
 * The frozen-state status line's id. The lines region points `aria-describedby`
 * at it while the save is in flight (#257 round 5, F1): the region is where a
 * cancel lands the caret when every control in it is disabled, and a focus move
 * onto an unnamed box with no stated reason tells a screen-reader user nothing
 * about why his controls stopped working.
 */
const LINES_FROZEN_ID = "purchase-lines-frozen-status";

export function PurchasePage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const categories = useQuery(orpc.categoriesList.queryOptions());

  const [pickerTarget, setPickerTarget] = useState<PickerTarget | null>(null);
  const [supplier, setSupplier] = useState<PartySelection>({ id: null, name: "", needsChoice: false });
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savedInvoice, setSavedInvoice] = useState<InvoiceDetail | null>(null);

  /** the line create that is open, or null (#257) */
  const [lineDraft, setLineDraft] = useState<LineCreateDraft | null>(null);
  const [lineError, setLineError] = useState<string | null>(null);
  /**
   * The category the last line create recorded. It seeds the next one, so one
   * pick serves several products — the same keep policy the page-level form
   * states, and the reason the old shared reset was wrong (wisdom
   * 2026-10-15-shared-reset-drops-per-caller-state).
   */
  const [lineCategory, setLineCategory] = useState("");
  /**
   * Monotonic create attempt. Bumped whenever the owner opens, retargets or
   * closes a line create, and captured by the submit that is in flight: the
   * product is created either way (a write is a server fact), but only the
   * attempt still on screen may re-point a line.
   */
  const lineAttemptRef = useRef(0);
  /**
   * The line create whose landing the invoice is still waiting for (#257 review
   * round 2, F2). While it is set, `lines` still names the product being
   * replaced, so a save would stock the wrong product and is refused.
   */
  const [lineCreatePending, setLineCreatePending] = useState<PendingLineCreate | null>(null);
  /**
   * The caret a commit owes. A create re-points the line and remounts its row
   * (the item id is the React key), and closing the form unmounts the field the
   * caret is in, so the request has to be applied after the commit rather than
   * derived from the draft — and keyed on a sequence, because a repeated request
   * for the same line would otherwise not re-run the effect.
   */
  const [focusRequest, setFocusRequest] = useState<FocusRequest | null>(null);
  const focusSeqRef = useRef(0);
  /** the line each quantity input belongs to, so a create can leave the caret there */
  const quantityRefs = useRef(new Map<string, HTMLInputElement>());
  /** the line each create trigger belongs to, so a cancel can hand the caret back */
  const createTriggerRefs = useRef(new Map<string, HTMLButtonElement>());
  /**
   * The lines region, where the caret lands when a control a commit named cannot
   * take focus — missing, or (during the invoice save) disabled (#257 round 5,
   * F1). While the save is in flight every control in the region is disabled on
   * purpose (round 4), so a cancel during that freeze has no enabled control left
   * to hand the caret to. The region itself is a programmatic focus target
   * (`tabIndex -1`) and carries `aria-describedby` to the frozen status line, so
   * a screen reader hears the region's name AND the reason its controls are dead
   * instead of being dropped on `document.body` with the tab order restarted at
   * the top of the page. Round 6 (F2) adds the region's visible `focus:` ring and
   * the guarded retry: a landing here is announced AND seen, and the caret
   * returns to the control the owner asked for once the freeze lifts.
   */
  const linesRegionRef = useRef<HTMLTableElement | null>(null);
  /** the request a frozen control could not take, retried when the freeze lifts */
  const frozenFocusRef = useRef<FocusRequest | null>(null);
  const lineNameRef = useRef<HTMLInputElement>(null);

  const draft = useInvoiceDraft(PURCHASE_DRAFT);
  const { lines } = draft;

  function requestFocus(kind: FocusRequest["kind"], itemId: string) {
    focusSeqRef.current += 1;
    setFocusRequest({ kind, itemId, seq: focusSeqRef.current });
  }

  /**
   * Land an item on one line and put the caret on its quantity (#257).
   */
  function landOnLine(itemId: string, item: Item) {
    draft.replaceItem(itemId, item);
    requestFocus("quantity", item.id);
  }

  function pickItem(item: Item) {
    // belt for the disabled picker button (#257 review round 4, F1): a dialog that
    // was already open when the save went out must not re-point a line the request
    // serialised. The dialog is left as it is, so a refused pick cannot look
    // like it worked.
    if (savePending) return;
    const target = pickerTarget;
    setPickerTarget(null);
    if (target === null) return;
    if (target.kind === "append") {
      draft.addItem(item);
      return;
    }
    // the picker was opened from a line: a picked replacement keeps that line's
    // quantity and unit cost (the cost the owner typed is his, so it is never
    // rewritten from the incoming record)
    landOnLine(target.itemId, item);
  }

  // the caret follows the line a create or a pick landed on, or the trigger a
  // cancel handed it back to
  useEffect(() => {
    if (focusRequest === null) return;
    const target =
      focusRequest.kind === "quantity"
        ? quantityRefs.current.get(focusRequest.itemId)
        : createTriggerRefs.current.get(focusRequest.itemId);
    // A disabled control cannot take focus, and `.focus()` on one silently does
    // nothing — so naming one would drop the owner on `document.body`, which is
    // the one place he cannot afford to be (WCAG 2.4.3). The request is REDIRECTED
    // when this effect runs — one immediate landing, in the same render pass as
    // the unmount that started it. Round 5 refused any retry here, because a
    // delayed `.focus()` would steal the caret back from wherever the owner has
    // moved on to by then; round 6 (F2) keeps that refusal and adds the guarded
    // retry below, which fires only while this redirect still owns the caret.
    if (target !== undefined && !target.disabled) {
      frozenFocusRef.current = null;
      target.focus();
    } else {
      // #257 round 6 (F2) — the control comes back when the freeze lifts, so keep
      // the request instead of dropping it on the floor (see the retire effect
      // below); the landing is visible meanwhile (the region's `focus:` ring)
      frozenFocusRef.current = focusRequest;
      linesRegionRef.current?.focus();
    }
  }, [focusRequest]);

  const lineCreateOpen = lineDraft?.target ?? null;
  // opening a line create starts the typing on its name
  useEffect(() => {
    if (lineCreateOpen !== null) lineNameRef.current?.focus();
  }, [lineCreateOpen]);

  // #257 review round 2 (F1) — the line the open form belongs to is gone: the
  // owner deleted it, or re-pointed it from its own picker. The form must not
  // outlive its line, or it comes back on a line that later reuses that item id
  // with a draft nobody asked for; and the write must not re-point that new line
  // when it answers. Abandoning the attempt settles both; the write still lands.
  // The draft's target is the one that matters — every other path that clears the
  // draft clears the pending in the same commit — so the pending target is only a
  // defensive fallback.
  const lineDraftTarget = lineDraft?.target ?? null;
  const linePendingTarget = lineCreatePending?.target ?? null;
  useEffect(() => {
    const target = lineDraftTarget ?? linePendingTarget;
    if (target === null) return;
    if (lines.some((line) => line.item.id === target)) return;
    abandonLineCreate();
    setLineDraft(null);
    setLineError(null);
  }, [lines, lineDraftTarget, linePendingTarget]);

  function openLineCreate(itemId: string) {
    abandonLineCreate();
    setLineError(null);
    // the picker is an action on the same lines; leaving it open behind the form
    // would be two answers to "which line is this for" on one screen
    setPickerTarget(null);
    setLineDraft({ target: itemId, name: "", categoryId: lineCategory, sellPrice: "" });
  }

  /**
   * Abandon the placement a line create owes (#257 review round 2). The write
   * still lands as a server fact, but no line may be re-pointed by an attempt the
   * owner has left, and the invoice save stops waiting for it. A retarget, an
   * explicit cancel and a deleted target all go through here.
   */
  function abandonLineCreate() {
    lineAttemptRef.current += 1;
    setLineCreatePending(null);
  }

  /**
   * The line's own button toggles its form. It must COLLAPSE when it is pressed
   * again: rebuilding the draft there would wipe what was just typed while the
   * button still reported itself expanded (review round 1, M3).
   */
  function toggleLineCreate(itemId: string) {
    if (lineDraft?.target === itemId) {
      closeLineCreate();
      return;
    }
    openLineCreate(itemId);
  }

  function closeLineCreate() {
    // abandoning the form abandons the landing, synchronously: a create that is
    // already in flight must not re-point a line the owner has left, and it is no
    // longer an answer the invoice save has to wait for. Cancel is never disabled
    // — a hung write must not trap the owner.
    const target = lineDraft?.target ?? null;
    abandonLineCreate();
    setLineDraft(null);
    setLineError(null);
    // the form unmounts out from under the caret, so hand it back to the button
    // that opened it (WCAG 2.4.3) — and when the in-flight save has frozen that
    // button, the focus effect lands on the lines region instead of leaving the
    // owner on `document.body` (#257 round 5, F1)
    if (target !== null) requestFocus("trigger", target);
  }

  function patchLineDraft(patch: Partial<Omit<LineCreateDraft, "target">>) {
    setLineDraft((current) => (current === null ? current : { ...current, ...patch }));
  }

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

  /**
   * The save in flight owns the draft (#257 review round 4, F1). `submit()` maps
   * `lines` into the request body, so from that moment the request carries a
   * snapshot the screen can still edit: a replacement after it went out leaves the
   * invoice stocking the old product, the new one off it, and the success
   * handler's `draft.reset()` wipes the evidence. The order is fixed at the source
   * instead — while the save is pending every control that changes the draft is
   * dead, and the two handlers a submit or a pick can still reach refuse.
   *
   * The supplier picker and the payment pair read the same predicate, so the whole
   * request is frozen by one value instead of two spellings of it.
   */
  const savePending = createInvoice.isPending;

  /**
   * The request the freeze could not honor (#257 round 6, F2). Round 5 redirects
   * the caret to the lines region, which is right while the save is out — but the
   * control the owner asked for comes back the moment the freeze lifts, and
   * leaving him on a region he never chose is the place the finding says he
   * loses. The retry is GUARDED: it fires only while the region still owns the
   * caret, so it cannot grab focus from wherever the owner has moved on to. A
   * successful save unmounts the whole draft in the same commit, so the region
   * owns nothing by the time this runs and the page's own save-completed swap is
   * left alone; the case left is a failed save, where the trigger really does
   * come back. Written with `document.activeElement` rather than a flag because
   * the question is exactly "is the caret still where this freeze put it".
   */
  useEffect(() => {
    if (savePending) return;
    const owed = frozenFocusRef.current;
    if (owed === null) return;
    frozenFocusRef.current = null;
    if (document.activeElement !== linesRegionRef.current) return;
    const target = owed.kind === "quantity" ? quantityRefs.current.get(owed.itemId) : createTriggerRefs.current.get(owed.itemId);
    if (target !== undefined && !target.disabled) target.focus();
  }, [savePending]);

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

  /**
   * Create the product the open line form describes and land it on its line
   * (#257): the line keeps its raw quantity and its typed unit cost, because the
   * only thing that changes is which item it points at.
   */
  async function submitLineCreate() {
    const current = lineDraft;
    if (current === null) return;
    // belt for the disabled submit (#257 review round 4, F1): a create started now
    // would re-point the line the in-flight save already serialised, and its
    // product would be left off the invoice. Refuse before the write starts.
    if (savePending) return;
    setLineError(null);
    const line = lines.find((entry) => entry.item.id === current.target);
    // the owner deleted the line while the form was open: nothing to land on
    if (line === undefined) return;
    const name = current.name.trim();
    if (name === "") {
      setLineError(t("itemsNameRequired"));
      return;
    }
    if (current.categoryId === "") {
      setLineError(t("itemsChooseCategory"));
      return;
    }
    // the line's unit cost is the price the product is created at. A zero cost
    // is allowed on purpose: the line itself takes 0 (a cleared cost field reads
    // as 0), the ticket's owner may be "about to" type the price, and the
    // invoice line's own movement re-derives the product's cost from the ledger
    // at save time — so refusing here would block the shortcut on a price the
    // form does not even offer to edit (review round 1, F2).
    const sellPrice = draftBlank(current.sellPrice) ? line.unitCost : parseLooseNumber(current.sellPrice);
    if (!Number.isInteger(sellPrice) || sellPrice < 0) {
      setLineError(t("itemsSellInvalid"));
      return;
    }
    // captured before the await: a later open, retarget or cancel abandons the
    // landing, never the write
    const attempt = lineAttemptRef.current;
    const target = current.target;
    // the invoice save waits for this placement (#257 review round 2, F2): until
    // the write answers, `lines` still names the product being replaced
    setLineCreatePending({ target, attempt });
    const outcome = await new Promise<QuickAddOutcome>((resolve) => {
      createItem.mutate(
        { name, categoryId: current.categoryId, costPrice: line.unitCost, sellingPrice: sellPrice },
        { onSuccess: (item) => resolve({ ok: true, item }), onError: (err) => resolve({ ok: false, error: tError(err.message) }) },
      );
    });
    // this attempt is answered, so it no longer holds the save back; the updater
    // keeps a newer create's place in the queue if the owner already started one
    setLineCreatePending((pending) => (pending?.attempt === attempt ? null : pending));
    // the product exists either way, so the catalogue refresh is unconditional
    void queryClient.invalidateQueries({ queryKey: orpc.itemsAll.queryKey() });
    if (attempt !== lineAttemptRef.current) return;
    if (!outcome.ok) {
      setLineError(outcome.error);
      return;
    }
    setLineCategory(current.categoryId);
    setLineDraft(null);
    landOnLine(target, outcome.item);
    // the picker may still be OPEN for the line this landing just replaced: it
    // was opened while the form was open, and the submit came from somewhere no
    // mouse reaches (round 6, F1). Retarget it to the new product so a choice
    // made after this point re-points the row the picker was opened from —
    // `replaceDraftLineItem` drops a replace that matches no row, and the dialog
    // has already closed by the time a stale id would be noticed.
    setPickerTarget((current) =>
      current !== null && current.kind === "line" && current.itemId === target ? { kind: "line", itemId: outcome.item.id } : current,
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
              disabled={savePending}
              testId="purchase-supplier"
            />
            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-1 text-sm font-medium">
                {t("purchasesNotes")}
                <input className="h-9 rounded-lg border border-input bg-background px-3 text-sm" name="notes" autoComplete="off" disabled={savePending} value={notes} onChange={(e) => setNotes(e.target.value)} />
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
                disabled={savePending}
              />
            </div>
          </div>

          <div className="rounded border border-border bg-card">
            {/* Same hierarchy as the sale screen: the list picker is the single
                primary path; the inline create form is demoted to outline. */}
            <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
              <h2 className="me-auto text-sm font-semibold">{t("purchasesLinesTitle")}</h2>
              {lines.length > 0 && (
                <Button data-testid="purchase-open-picker" disabled={savePending} onClick={() => setPickerTarget({ kind: "append" })}>
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
                <Button type="submit" disabled={createItem.isPending || savePending}>
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
                      <Button size="lg" data-testid="purchase-open-picker" disabled={savePending} onClick={() => setPickerTarget({ kind: "append" })}>
                        {t("purchasesAddItem")}
                      </Button>
                    }
                  />
                </div>
              ) : (
                <table
                  // #257 round 6 (F2) — the ring is written on `focus:`, not
                  // `focus-visible:`: the caret arrives here by script when a
                  // cancel races the in-flight save, and a script-issued focus
                  // never matches `:focus-visible`, so a `focus-visible:` ring
                  // would leave the only landing that freeze allows invisible
                  className="w-full focus:outline-2 focus:outline-offset-[-2px] focus:outline-ring"
                  data-testid="purchase-lines"
                  ref={linesRegionRef}
                  tabIndex={-1}
                  aria-label={t("purchasesLinesTitle")}
                  // the caret lands here when the save has frozen the control a
                  // commit named, so it carries the frozen line's reason with it
                  aria-describedby={savePending ? LINES_FROZEN_ID : undefined}
                >
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
                      <Fragment key={line.item.id}>
                        <tr className="border-b last:border-0">
                          <td className="p-2">
                            <div className="flex flex-wrap items-center gap-1">
                              {/* #257 — the line carries its own product picker, so a
                                  mis-picked line is corrected in place instead of being
                                  deleted and re-added, and the create action sits next
                                  to it exactly as it does on the expenses screen. */}
                              <button
                                type="button"
                                className="rounded px-1 text-start underline decoration-dotted underline-offset-4 hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent"
                                // #257 review round 4 (F1) — the request already carries
                                // this line's product, so replacing it now would leave the
                                // invoice stocking the old one. Round 6 (F1): while this
                                // line's own create is in flight its product is about to
                                // move, so a pick through here would name the id the landing
                                // removes and be dropped — dead for that window too.
                                disabled={savePending || lineCreatePending?.target === line.item.id}
                                // the accessible name starts with the visible text, so
                                // a voice-control user can say the name he reads
                                aria-label={`${line.item.name} — ${t("purchasesChangeItem")}`}
                                onClick={() => setPickerTarget({ kind: "line", itemId: line.item.id })}
                                data-testid={`purchase-line-pick-${line.item.id}`}
                              >
                                {line.item.name}
                              </button>
                              <Button
                                type="button"
                                variant="ghost"
                                size="xs"
                                disabled={savePending}
                                ref={(element) => {
                                  if (element === null) createTriggerRefs.current.delete(line.item.id);
                                  else createTriggerRefs.current.set(line.item.id, element);
                                }}
                                aria-label={`${t("purchasesLineNewProduct")}: ${line.item.name}`}
                                aria-expanded={lineCreateOpen === line.item.id}
                                aria-controls={lineCreateOpen === line.item.id ? lineCreateFormId(line.item.id) : undefined}
                                onClick={() => toggleLineCreate(line.item.id)}
                                data-testid={`purchase-line-new-${line.item.id}`}
                              >
                                <PackagePlus size={12} aria-hidden="true" />
                                {t("purchasesLineNewProduct")}
                              </Button>
                            </div>
                          </td>
                          <td className="p-2">
                            <input
                              className={cn(inputClass, "w-16 px-2 py-1")}
                              name={`quantity-${line.item.id}`}
                              ref={(element) => {
                                if (element === null) quantityRefs.current.delete(line.item.id);
                                else quantityRefs.current.set(line.item.id, element);
                              }}
                              autoComplete="off"
                              inputMode="numeric"
                              disabled={savePending}
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
                              disabled={savePending}
                              onChange={(e) => draft.patch(line.item.id, { unitCost: nextUnitCost(e.target.value, line.unitCost) })}
                              aria-label={`${line.item.name}: ${t("purchasesLineCost")}`}
                            />
                          </td>
                          <td className="p-2">{lineQuantity(line) * line.unitCost}</td>
                          <td className="p-2">
                            <button type="button" className="rounded p-1 text-destructive hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-transparent" disabled={savePending} aria-label={`${t("removeRow")} ${line.item.name}`} onClick={() => draft.remove(line.item.id)}>
                              <X size={16} aria-hidden="true" />
                            </button>
                          </td>
                        </tr>
                        {lineDraft !== null && lineDraft.target === line.item.id && (
                          <tr data-testid="purchase-line-create-row">
                            <td colSpan={5} className="p-2">
                              <form
                                className="grid gap-3 rounded bg-accent p-3"
                                id={lineCreateFormId(line.item.id)}
                                // the form owns its submit: preventDefault keeps the SPA from a
                                // native post, and stopPropagation keeps the event away from any
                                // wrapper form (the line's own values are untouched either way)
                                onSubmit={(e) => {
                                  e.preventDefault();
                                  e.stopPropagation();
                                  void submitLineCreate();
                                }}
                                data-testid="purchase-line-product-form"
                              >
                                <div className="grid grid-cols-2 gap-3">
                                  <label className="grid gap-1 text-sm font-medium">
                                    {t("purchasesLineProductName")}
                                    <input
                                      ref={lineNameRef}
                                      className={inputClass}
                                      name="lineProductName"
                                      autoComplete="off"
                                      value={lineDraft.name}
                                      onChange={(e) => patchLineDraft({ name: e.target.value })}
                                      data-testid="line-product-name"
                                    />
                                  </label>
                                  <label className="grid gap-1 text-sm font-medium">
                                    {t("purchasesLineProductCategory")}
                                    <Select
                                      value={lineDraft.categoryId}
                                      onValueChange={(value) => patchLineDraft({ categoryId: value ?? "" })}
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
                                    <input
                                      className={inputClass}
                                      name="lineProductSell"
                                      autoComplete="off"
                                      inputMode="numeric"
                                      placeholder={String(line.unitCost)}
                                      value={lineDraft.sellPrice}
                                      onChange={(e) => patchLineDraft({ sellPrice: e.target.value })}
                                      data-testid="line-product-sell"
                                    />
                                  </label>
                                </div>
                                <p className="flex items-center gap-1 text-xs text-muted-foreground" data-testid="line-product-cost">
                                  {t("purchasesLineCreateCost")} <Amount value={line.unitCost} />
                                </p>
                                {lineError !== null && (
                                  <p className="rounded border border-destructive/20 bg-destructive/10 p-2 text-sm text-destructive" data-testid="line-product-error" role="alert">
                                    {lineError}
                                  </p>
                                )}
                                <div className="flex items-center gap-2">
                                  <Button type="submit" disabled={createItem.isPending || savePending} data-testid="line-product-save">
                                    {t("purchasesLineCreateSave")}
                                  </Button>
                                  <Button type="button" variant="outline" onClick={closeLineCreate} data-testid="line-product-cancel">
                                    {t("itemsCancel")}
                                  </Button>
                                </div>
                              </form>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {lines.length > 0 && (
            <CheckoutBar testId="purchase-checkout-bar">
                {error && <p className="rounded border border-destructive/20 bg-destructive/10 p-2 text-sm text-destructive" data-testid="purchase-error" role="alert">{error}</p>}
                {/* Why the save is disabled while a line create is in flight (#257
                    review round 2, F2): until the write answers, `lines` still
                    names the product being replaced, so a save here would stock
                    the wrong one. The disabled save is the block; this line states
                    the reason, because a disabled control with no stated reason is
                    a dead end for a keyboard or screen-reader user. role="status"
                    announces it without stealing focus. */}
                {lineCreatePending !== null && (
                  <p className="text-sm text-muted-foreground" role="status" data-testid="purchase-save-pending">
                    {t("purchasesLineCreatePending")}
                  </p>
                )}
                {/* Why the lines are read-only while the save is in flight (#257
                    review round 4, F1): `submit()` already mapped them into the
                    request body, so a control left live would let the screen and the
                    payload diverge. The disabled controls are the block; this states
                    the reason, because a frozen table with no reason is a dead end
                    for a keyboard or screen-reader user. role="status" announces it
                    without stealing focus. */}
                {savePending && (
                  <p className="text-sm text-muted-foreground" role="status" id={LINES_FROZEN_ID} data-testid="purchase-lines-frozen">
                    {t("purchasesSaveInFlight")}
                  </p>
                )}
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <p className="text-lg font-bold" data-testid="purchase-total">
                    {t("purchasesTotal")}: <Amount value={total} />
                  </p>
                  <Button size="lg" className="min-w-44" type="button" onClick={submit} disabled={createInvoice.isPending || lineCreatePending !== null} data-testid="purchase-save">
                    {t("purchasesSave")}
                  </Button>
                </div>
            </CheckoutBar>
          )}
        </div>
      )}

      <ItemPickerDialog open={pickerTarget !== null} onClose={() => setPickerTarget(null)} onSelect={pickItem} />
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
        <p className="mt-1 text-sm text-muted-foreground" data-testid="link-proposal-empty">{t("purchasesProposalEmpty")}</p>
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
