import { Link, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Trans, useTranslation } from "react-i18next";

import { computeReturnRefund, derivedRefundSplit, explicitRefundSplit, returnSettlementDefault } from "@dokan/contracts";
import type { InvoiceDetail, PaymentMethod, ReturnDetail } from "@dokan/contracts";

import { Amount } from "@/components/ui/amount";
import { AmountPercentageInput, amountFromPercentage, parseWholePercentage, percentageDraftInvalid, percentageFromAmount, type AmountPercentageValue } from "@/components/ui/amount-percentage-input";
import { draftBlank, parseGroupedAmount, parseWholeAmount } from "@/lib/amount-parse";
import { Button } from "@/components/ui/button";
import { InvoiceHeader } from "@/components/invoice-header";
import { inputClass } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SuccessCard, SuccessCardSpacer } from "@/components/ui/success-card";
import { EmptyState } from "@/components/ui/empty-state";

import { tError } from "../lib/i18n";
import { orpc } from "../lib/rpc";
import { invalidatePartyBalance, partyBalanceInput } from "../lib/party-cache-key";
import { LEDGER_REFETCH_MS, hotCounterRefresh } from "../lib/freshness";
import { combineBusinessDateTime, formatDateTime } from "../lib/dates";
import { debtOffsetDisplay } from "../lib/return-voucher";

/**
 * Ticket 8 — invoice detail (/invoices/$invoiceId). Shows the header, the
 * totals that matter for settling (total / paid / remaining), the FULL
 * payment history, and a record-payment form that enforces the money
 * boundary client-side exactly like the api: any instalment above the
 * remaining amount is refused before it is sent.
 */

/** Pure boundary check shared with the unit tests (mirrors overrideInputInvalid).
 * Returns the reason a later payment must be rejected, or null when valid.
 * Client-side mirror of the api guard: digits only (no "1e3"/"0x10" forms),
 * a whole DA integer, within the safe-integer range, at most the remaining. */
export function paymentAmountError(amount: string, remaining: number): "INVALID" | "EXCEEDS" | null {
  const value = parseGroupedAmount(amount);
  if (value === null || value <= 0) return "INVALID";
  if (value > remaining) return "EXCEEDS";
  return null;
}

/**
 * The instalment's initial draft: the full remaining at 100%, or an empty pair
 * on a settled invoice (there is no reference left to take a share of).
 */
function seedPaid(remaining: number): AmountPercentageValue {
  return remaining > 0 ? { amount: String(remaining), percentage: "100" } : { amount: "", percentage: "" };
}

/**
 * The first enabled control inside a form. Focus-based actions and the
 * completion-card restore both need a real field, never a disabled one, and
 * must not hard-code which field happens to be first (issue #96).
 */
function firstEnabledField(form: HTMLFormElement | null): HTMLInputElement | null {
  return (
    Array.from(form?.querySelectorAll<HTMLInputElement>("input") ?? []).find((field) => !field.disabled) ?? null
  );
}

/**
 * Router-free payment panel (same shape as purchase's LinkProposalPanel):
 * full history + record-payment form, unit-testable without a router.
 */
export function PaymentPanel({ invoice }: { invoice: InvoiceDetail }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  // #162 — the instalment is a share of this invoice's remaining, so both the
  // amount and the percentage are offered; the default is the full remaining.
  const [paid, setPaid] = useState<AmountPercentageValue>(() => seedPaid(invoice.remainingAmount));
  // #171 — the edited field stays the source when the remaining changes
  // underneath the form (a return accepted, a payment recorded elsewhere)
  const paidSource = useRef<"amount" | "percentage" | null>(null);
  const [method, setMethod] = useState<PaymentMethod>("CASH");
  const [note, setNote] = useState("");
  // a ReactNode: the overpay copy carries <Amount> so its digits are grouped
  // and its currency comes from the primitive (#254 round 2)
  const [error, setError] = useState<ReactNode>(null);
  /** the just-recorded instalment whose completion card is shown */
  const [savedPayment, setSavedPayment] = useState<{ amount: number; method: PaymentMethod } | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  // The card is focusable so the form->card transition can move focus there
  // instead of losing it with the submitting control (issue #169 round 2).
  const cardRef = useRef<HTMLDivElement>(null);
  // The paid-off state has no enabled field; its message is the focus fallback.
  const paidOffRef = useRef<HTMLParagraphElement>(null);
  // Set while the completion card is shown; on the card->form transition the
  // button that held focus unmounts, so focus moves to the restored form's
  // first enabled field (issue #169).
  const restoreFocusPending = useRef(false);

  useEffect(() => {
    if (savedPayment !== null) {
      restoreFocusPending.current = true;
      cardRef.current?.focus();
      return;
    }
    if (!restoreFocusPending.current) return;
    const target = firstEnabledField(formRef.current) ?? paidOffRef.current;
    if (target === null || target === undefined) return;
    target.focus();
    // consume the flag only once focus actually moved; a failed move leaves it
    // set for the next saved-state transition
    if (document.activeElement === target) restoreFocusPending.current = false;
  }, [savedPayment]);

  const pay = useMutation(
    orpc.invoicesPay.mutationOptions({
      onSuccess: (_updated, variables) => {
        paidSource.current = null;
        setPaid(seedPaid(_updated.remainingAmount));
        setNote("");
        setError(null);
        setSavedPayment({ amount: variables.amount, method: variables.method ?? "CASH" });
        // the detail read refetches with its exact key (proven mechanism);
        // the list/activity invalidations use prefix keys as best effort — if
        // a filter variant does not match, the list still refetches on remount
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.invoicesGet.queryKey({ input: { id: invoice.id } }) }),
          queryClient.invalidateQueries({ queryKey: ["invoicesList"] }),
          queryClient.invalidateQueries({ queryKey: ["activitiesList"] }),
          // #323 — the debts screen shows this customer's total; the payment
          // moved it, so that list is stale too.
          queryClient.invalidateQueries({ queryKey: orpc.reportsDebts.queryKey() }),
        ]);
        // #256 round 4 — the returns panel derives its refund default from the
        // party's whole tab, so a recorded payment must refresh that read too or
        // the preview keeps the pre-payment total. Exact key, like the detail
        // read above; a purchase invoice has no customer tab to refresh.
        if (invoice.kind === "SALE") {
          // #323 — the customer's tab is read under the canonical party key (the
          // id when known, the trimmed typed name otherwise), so this
          // invalidation lands on the SAME key the debts screen reads and the
          // refund preview this screen shows.
          void invalidatePartyBalance(queryClient, {
            kind: "SALE",
            counterpartyId: invoice.counterpartyId,
            counterpartyName: invoice.counterpartyName,
          });
        }
      },
      onError: (err) => {
        setSavedPayment(null);
        // a stale tab can still reach the api: the server re-checks the
        // boundary inside the transaction and returns the exact key
        setError(tError(err.message));
      },
    }),
  );

  const remaining = invoice.remainingAmount;
  // #171 — relink when the remaining changes underneath the form: an untouched
  // pair follows the new remaining, an edited amount stays the source, an edited
  // percentage rescales. A percentage-based draft falls to zero with the
  // reference. (ReturnsPanel already does this for the return value.)
  useEffect(() => {
    setPaid((current) => {
      if (remaining === 0) {
        if (paidSource.current === "percentage") return { amount: "0", percentage: current.percentage };
        if (paidSource.current === null) return { amount: "", percentage: "" };
        return current;
      }
      if (paidSource.current === null) return { amount: String(remaining), percentage: "100" };
      if (paidSource.current === "percentage") {
        const percentage = parseWholePercentage(current.percentage);
        return percentage === null ? current : { amount: String(amountFromPercentage(remaining, percentage)), percentage: current.percentage };
      }
      const amount = parseGroupedAmount(current.amount);
      return { amount: current.amount, percentage: amount === null ? "" : String(percentageFromAmount(remaining, amount)) };
    });
  }, [remaining]);
  const remainingMessage = paymentAmountError(paid.amount, remaining);
  // #171 — the invalid percentage is guarded explicitly, not left to the
  // incidental invariant that an invalid draft also empties the amount
  const percentageInvalid = percentageDraftInvalid(paid.percentage);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSavedPayment(null);
    if (remainingMessage !== null || percentageInvalid) {
      // same boundary as the api: an instalment never exceeds what is owed
      setError(remainingMessage === "EXCEEDS" ? <Trans i18nKey="pmtExceedsRemaining" components={{ money: <Amount value={remaining} /> }} /> : t("pmtInvalidAmount"));
      return;
    }
    const amount = parseGroupedAmount(paid.amount);
    if (amount === null || amount <= 0) {
      setError(t("pmtInvalidAmount"));
      return;
    }
    void pay.mutate({
      invoiceId: invoice.id,
      amount,
      method,
      note: note.trim() === "" ? undefined : note.trim(),
    });
  }

  return (
    <div className="rounded border bg-card p-4" data-testid="pmt-panel">
      <h2 className="font-semibold">{t("pmtTitle")}</h2>
      {invoice.payments.length === 0 ? (
        <EmptyState
          testId="pmt-empty"
          className="mt-2"
          title={t("pmtEmpty")}
          hint={remaining === 0 ? t("pmtEmptySettledHint") : savedPayment !== null ? t("pmtEmptyJustSavedHint") : t("pmtEmptyHint")}
          action={
            remaining === 0 || savedPayment !== null ? undefined : (
              <Button
                size="lg"
                variant="outline"
                data-testid="pmt-empty-action"
                onClick={() => formRef.current?.querySelector<HTMLInputElement>('[data-testid="pmt-amount"]')?.focus()}
              >
                {t("pmtRecord")}
              </Button>
            )
          }
        />
      ) : (
        <table className="mt-2 w-full text-sm" data-testid="pmt-history">
          <thead>
            <tr className="border-b text-right text-muted-foreground">
              <th className="p-2">{t("pmtDate")}</th>
              <th className="p-2">{t("pmtAmount")}</th>
              <th className="p-2">{t("pmtMethod")}</th>
              <th className="p-2">{t("pmtNote")}</th>
            </tr>
          </thead>
          <tbody>
            {invoice.payments.map((payment) => (
              <tr key={payment.id} className="border-b last:border-0" data-testid="pmt-row">
                <td className="p-2">{formatDateTime(payment.paidAt)}</td>
                <td className="p-2 font-medium"><Amount value={payment.amount} /></td>
                <td className="p-2">{t(`pmtMethod_${payment.method}`)}</td>
                <td className="p-2 text-muted-foreground">{payment.note ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {savedPayment !== null ? (
        <SuccessCard
          testId="pmt-done"
          className="mt-4"
          containerRef={cardRef}
          title={t("pmtRecorded")}
          detail={
            <span data-testid="pmt-saved-detail"><Amount value={savedPayment.amount} /> — {t(`pmtMethod_${savedPayment.method}`)}</span>
          }
        >
          <Button asChild>
            <Link to="/invoices/$invoiceId" params={{ invoiceId: invoice.id }} data-testid="pmt-open-invoice">{t("savedViewInvoice")}</Link>
          </Button>
          <SuccessCardSpacer />
          <Button variant="ghost" onClick={() => setSavedPayment(null)} data-testid="pmt-new">{t("pmtNew")}</Button>
        </SuccessCard>
      ) : (
      <form ref={formRef} className="mt-4 grid gap-3" onSubmit={submit} data-testid="pmt-form">
        <AmountPercentageInput
          referenceTotal={remaining}
          value={paid}
          onChange={(next, edited) => {
            paidSource.current = edited;
            setPaid(next);
            setSavedPayment(null);
          }}
          amountLabel={t("pmtAmountLabel")}
          referenceLabel={t("amountReferenceLabel")}
          amountTestId="pmt-amount"
          percentageTestId="pmt-percentage"
          referenceTestId="pmt-reference"
          amountInvalid={remainingMessage !== null}
          percentageInvalid={percentageInvalid}
          disabled={remaining === 0}
        />
        <div className="grid grid-cols-2 gap-3">
          <label className="grid gap-1 text-sm">
            {t("pmtMethod")}
            <Select
              value={method}
              onValueChange={(value) => {
                // SAFETY: the select renders only the CASH / BANK options, so the value is a PaymentMethod
                setMethod((value ?? "CASH") as PaymentMethod);
                setSavedPayment(null);
              }}
              disabled={remaining === 0}
              items={[
                { value: "CASH", label: t("pmtMethod_CASH") },
                { value: "BANK", label: t("pmtMethod_BANK") },
              ]}
            >
              <SelectTrigger className="w-full" data-testid="pmt-method">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="CASH">{t("pmtMethod_CASH")}</SelectItem>
                <SelectItem value="BANK">{t("pmtMethod_BANK")}</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <label className="grid gap-1 text-sm">
            {t("pmtNoteLabel")}
            <input
              className={inputClass}
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
                setSavedPayment(null);
              }}
              disabled={remaining === 0}
              data-testid="pmt-note"
            />
          </label>
        </div>
        {remaining === 0 ? (
          <p ref={paidOffRef} tabIndex={-1} className="text-sm text-success" data-testid="pmt-unavailable">{t("pmtUnavailable")}</p>
        ) : (
          <button
            type="submit"
            className="rounded-lg bg-primary py-2 text-primary-foreground disabled:opacity-50"
            disabled={pay.isPending || percentageInvalid}
            data-testid="pmt-submit"
          >
            {t("pmtRecord")}
          </button>
        )}
        {error && <p role="alert" className="rounded border border-destructive/20 bg-destructive/10 p-2 text-sm text-destructive" data-testid="pmt-error">{error}</p>}
      </form>
      )}
    </div>
  );
}

/**
 * Router-free returns panel (invoice detail). Shows this invoice's return
 * history (with voucher print links) and a new-return form: per-line quantity
 * drafts capped at the remaining-returnable (draft-string pattern from the
 * sale cart), an optional Arabic reason, and CASH payout today. The api owns
 * the authoritative cap; this panel mirrors it client-side so an oversized
 * draft fails as a field error, not an opaque server error.
 */
/** returns a line's still-returnable quantity from the current return list */
export function remainingReturnableFor(line: { id: string; quantity: number }, returns: readonly ReturnDetail[]): number {
  const already = returns.reduce(
    (sum, record) => sum + record.lines.filter((entry) => entry.invoiceLineId === line.id).reduce((inner, entry) => inner + entry.quantity, 0),
    0,
  );
  return Math.max(0, line.quantity - already);
}

/** Pure boundary check shared with the unit tests (mirrors the api cap). Reads
 * the quantity through the one shared strict reader (`parseWholeAmount`), so the
 * validator, the `valueTotal` projection and the submit payload always agree on
 * both digit scripts (#225). */
export function returnQuantityError(draft: string, remaining: number): "INVALID" | "EXCEEDS" | null {
  if (draftBlank(draft)) return null; // an untouched line is not part of the return
  const value = parseWholeAmount(draft);
  if (value === null || value <= 0) return "INVALID";
  if (value > remaining) return "EXCEEDS";
  return null;
}

export type ReturnSettlementPreset = "ALL_CASH" | "ALL_DEBT" | "CUSTOM";

/** Validates a custom cash draft for the settlement split. */
export function customCashError(draft: string, valueTotal: number): "INVALID" | "EXCEEDS" | null {
  if (draftBlank(draft)) return null; // untouched = all-debt
  const value = parseGroupedAmount(draft);
  if (value === null) return "INVALID";
  if (value > valueTotal) return "EXCEEDS";
  return null;
}

export function ReturnsPanel({ invoice, refreshMs = LEDGER_REFETCH_MS }: { invoice: InvoiceDetail; refreshMs?: number }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  // complete per-invoice history: the form's remaining quantity and refund
  // preview need EVERY prior return, so this read is unpaginated (the review
  // screen's returnsList stays paged)
  const returnsQuery = useQuery(orpc.returnsForInvoice.queryOptions({ input: { invoiceId: invoice.id } }));
  // #256 — the customer's tab, read through the same store seam the api's
  // default uses (the party id when known, else the typed name), so the method
  // this form pre-selects is the method the server would pick with no
  // cashPaidOut. A sale with no name at all has no tab to consult.
  // #323 — one party, one cache identity: the customer's tab is read under
  // the canonical party key (the id when the shop knows it, the trimmed typed
  // name otherwise), the same key the debts screen reads and every money write
  // invalidates. A sale whose party has no identity at all has no tab to
  // consult.
  const partyBalance = partyBalanceInput({
    kind: "SALE",
    counterpartyId: invoice.counterpartyId,
    counterpartyName: invoice.counterpartyName,
  });
  const hasPartyIdentity = partyBalance !== null;
  const partyDebtQuery = useQuery({
    ...orpc.debtsByParty.queryOptions({
      // the unidentified party's own values keep the key well-formed; the query
      // is disabled, so nothing is ever sent under it
      input: partyBalance ?? { kind: "SALE", counterpartyId: invoice.counterpartyId, counterpartyName: invoice.counterpartyName },
    }),
    enabled: invoice.kind === "SALE" && hasPartyIdentity,
    // #323 review — the refund preview reads the customer's tab, and a payment
    // recorded in ANOTHER window moves it. `invalidatePartyBalance` refreshes
    // this window's cache only, and two windows side by side never exchange a
    // focus event, so without a bounded tick this preview stays as old as the
    // last read made it. Same lever #295 gave the counters for the #294 gap;
    // `refreshMs` is injectable so a test can run this wiring on a fast clock.
    ...hotCounterRefresh(refreshMs),
  });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  /** #256 — the owner's EXPLICIT method, or null while they have not picked.
   * The DISPLAYED method is derived (`displayedSettlement`) instead of mirrored
   * into state: a mirror needs an effect to re-seed it, and saving a return
   * clears both the mirror and the form while `derivedPreset` stays the same
   * (all-debt at value 0), so the effect's dependencies never changed and the
   * method went blank (#256 round 3). */
  const [settlement, setSettlement] = useState<ReturnSettlementPreset | null>(null);
  /** once the owner picks, the derived default stops re-seeding the select */
  const [settlementChosen, setSettlementChosen] = useState(false);
  const [cashDraft, setCashDraft] = useState("");
  // #162 — the custom cash split is a share of the computed return value, so
  // the amount and the percentage follow each other; the full value is 100%.
  const [cashPercentage, setCashPercentage] = useState("");
  // the edited field stays the source when the return value changes
  const cashSource = useRef<"amount" | "percentage" | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** the just-recorded return whose completion card is shown */
  const [savedReturn, setSavedReturn] = useState<ReturnDetail | null>(null);
  const formRef = useRef<HTMLFormElement>(null);
  // The card is focusable so the form->card transition can move focus there
  // instead of losing it with the submitting control (issue #169 round 2).
  const cardRef = useRef<HTMLDivElement>(null);
  // Set while the completion card is shown; on the card->form transition the
  // button that held focus unmounts, so focus moves to the restored form's
  // first enabled field (issue #169).
  const restoreFocusPending = useRef(false);

  useEffect(() => {
    if (savedReturn !== null) {
      restoreFocusPending.current = true;
      cardRef.current?.focus();
      return;
    }
    if (!restoreFocusPending.current) return;
    const first = firstEnabledField(formRef.current);
    if (first === null) return;
    first.focus();
    // consume the flag only once focus actually moved
    if (document.activeElement === first) restoreFocusPending.current = false;
  }, [savedReturn]);

  // The saved return is PENDING_REVIEW: its debt deduction only lands on
  // acceptance, so the card must not claim the promise as applied (#169).
  const savedReturnDebt = savedReturn === null ? null : debtOffsetDisplay(savedReturn.status, savedReturn.debtOffset, savedReturn.debtApplied);

  const returns = returnsQuery.data?.items ?? [];
  // issue #118 — a pending return does not move the balance until accepted;
  // grouping it above the reviewed rows keeps the missing money explainable
  const pendingReturns = returns.filter((record) => record.status === "PENDING_REVIEW");
  const reviewedReturns = returns.filter((record) => record.status !== "PENDING_REVIEW");
  const returnableLines = useMemo(() => invoice.lines.filter((line) => line.itemId !== null), [invoice.lines]);
  // A structurally returnable line can still have nothing left (sold quantity
  // zero, or every unit already returned). The empty state must not offer a
  // focus action into that dead form (issue #96).
  const hasReturnableLine = returnableLines.some((line) => remainingReturnableFor(line, returns) > 0);
  // #96 round 2 — the api refuses a customer return on a purchase invoice
  // outright (`RETURN_NOT_SALE`), so the panel must not render that form here:
  // a purchase return is recorded from the supplier account instead.
  const isSale = invoice.kind === "SALE";
  const supplierAccountId = invoice.counterpartyId;
  // #96 round 2 — the form's per-line cap is read from this history. When the
  // read failed and there is no cached list, the remaining quantity is unknown,
  // so the action is withheld rather than opening a form that can only be
  // refused (the round-1 lesson: branch on the dependency, not just the total).
  const returnsUnavailable = returnsQuery.isError && returnsQuery.data === undefined;

  // What earlier returns already refunded per line, in the shape
  // `computeReturnRefund` expects. The api derives the identical map from
  // `StorePort.returnedByLine` (every status, which is what this list holds),
  // so the preview and the persisted refund cannot disagree on a completing
  // return.
  const priorByLine = useMemo(() => {
    const map = new Map<string, { quantity: number; refundAmount: number }>();
    for (const record of returns) {
      for (const entry of record.lines) {
        const current = map.get(entry.invoiceLineId) ?? { quantity: 0, refundAmount: 0 };
        map.set(entry.invoiceLineId, {
          quantity: current.quantity + entry.quantity,
          refundAmount: current.refundAmount + entry.refundAmount,
        });
      }
    }
    return map;
  }, [returns]);

  // Client projection of the return value from the entered drafts. It calls the
  // SAME `computeReturnRefund` the api prices with (packages/contracts), so the
  // settlement shown is the settlement persisted; the api still recomputes.
  const valueTotal = useMemo(() => {
    const entered = returnableLines.flatMap((line) => {
      const quantity = parseWholeAmount(drafts[line.id] ?? "");
      if (quantity === null || quantity <= 0) return [];
      return [{ invoiceLineId: line.id, quantity, netTotal: line.netTotal, lineQuantity: line.quantity }];
    });
    if (entered.length === 0) return 0;
    return computeReturnRefund(entered, priorByLine).refundTotal;
  }, [returnableLines, drafts, priorByLine]);
  // #256 — what the app picks when the owner does not: the refund comes off the
  // party's whole tab (the owner's "in this invoice or in another invoice"),
  // cash only when he owes nothing; a return larger than the tab is a SPLIT
  // (tab to zero, the remainder as cash), and acceptance allocates the offset
  // across the party's open invoices oldest-first. Derived BEFORE the cash-pair
  // effect below, which seeds an untouched field from it.
  const partyDebt = hasPartyIdentity
    ? partyDebtQuery.data === undefined
      ? null
      : Math.max(invoice.remainingAmount, partyDebtQuery.data.items.reduce((sum, row) => sum + row.remainingAmount, 0))
    : // a party with no id and no usable name (a walk-in sale) has no tab to
      // consult, so the invoice's own remaining is the whole debt.
      // #337 — a padded typed name used to land here too, because the server
      // grouped by the raw name while its WHERE matched a trimmed one. The
      // server now trims both sides with one rule and returns the trimmed
      // label, so every readable name HAS an identity and this branch is only
      // the walk-in.
      invoice.remainingAmount;
  const settlementDefault = returnSettlementDefault({ returnValue: valueTotal, invoiceDebt: invoice.remainingAmount, partyDebt });
  // the numbers the SERVER derives while the owner has not touched the control
  // (an untouched form sends no cashPaidOut, so the server applies this same
  // rule to fresh debt) — null while the party read is still in flight
  const derivedSplit = derivedRefundSplit(settlementDefault, valueTotal);
  // the pre-selected preset: the derived method, with a SPLIT opening on the
  // custom split, its cash field already carrying the remainder the app would
  // hand back
  const derivedPreset: ReturnSettlementPreset | null =
    settlementDefault.method === "CASH" ? "ALL_CASH" : settlementDefault.method === "DEBT" ? "ALL_DEBT" : derivedSplit === null ? null : "CUSTOM";
  // What the select shows and what the projection prices: the owner's explicit
  // pick once they made one, otherwise the derived default — recomputed on every
  // render, so clearing the form re-seeds it with no effect to go stale.
  const displayedSettlement = settlementChosen ? settlement : derivedPreset;
  // The untouched form cannot price a split the app could not derive: when the
  // return exceeds this invoice's debt and the party's tab is still loading (or
  // failed), `derivedSplit` is null and saving would hand the api the choice of
  // which OTHER invoices to relieve — a choice the owner never saw. Block the
  // untouched save; an explicit pick is the owner answering it (#256 round 3).
  const splitUnknown = !settlementChosen && derivedSplit === null;
  // how much of the tab sits on OTHER invoices — the part the default spreads
  // over the party's open invoices (oldest first)
  const crossInvoiceDebt = partyDebt === null ? 0 : Math.max(0, partyDebt - invoice.remainingAmount);
  // #162/#256 — relink the custom cash split when the return value changes: the
  // edited field is the source, so 50% of a 900 return becomes 50% of the new
  // value instead of a stale amount. A percentage-based split falls to zero
  // when the return value does. An UNTOUCHED pair opens at the DERIVED cash
  // (0 when the whole return goes to debt, value − debt for a split), so what
  // the owner reads is what the server derives.
  useEffect(() => {
    if (valueTotal === 0) {
      if (cashSource.current === "percentage") {
        setCashDraft("0");
        return;
      }
      if (cashSource.current === null) {
        setCashDraft("");
        setCashPercentage("");
      }
      return;
    }
    if (cashSource.current === null) {
      // once the owner has picked a method, a fresh custom pair opens at the
      // full return value (100%): they lower either side to push the rest onto
      // the debt
      const seed = derivedSplit === null || settlementChosen ? valueTotal : derivedSplit.cashPaidOut;
      setCashDraft(String(seed));
      setCashPercentage(String(percentageFromAmount(valueTotal, seed)));
      return;
    }
    if (cashSource.current === "percentage") {
      const percentage = parseWholePercentage(cashPercentage);
      if (percentage !== null) setCashDraft(String(amountFromPercentage(valueTotal, percentage)));
      return;
    }
    const amount = parseGroupedAmount(cashDraft);
    setCashPercentage(amount === null ? "" : String(percentageFromAmount(valueTotal, amount)));
  }, [valueTotal, cashDraft, cashPercentage, derivedSplit, settlementChosen]);
  const requestedCash =
    displayedSettlement === null ? 0 : displayedSettlement === "ALL_CASH" ? valueTotal : displayedSettlement === "ALL_DEBT" ? 0 : (parseGroupedAmount(cashDraft) ?? 0);
  // an invalid percentage draft clears the derived amount, and an empty amount
  // is the legitimate "all debt" choice — so it must be rejected explicitly or
  // "12.5%" would silently be recorded as zero cash
  const cashPercentageInvalid = displayedSettlement === "CUSTOM" && percentageDraftInvalid(cashPercentage);
  const cashIsValid = displayedSettlement !== "CUSTOM" || (customCashError(cashDraft, valueTotal) === null && !cashPercentageInvalid);
  // The projection mirrors the api EXACTLY, and the api does two different
  // things: an untouched default is derived from the party's tab (and can
  // relieve other invoices), while an explicit choice keeps #162's cap at THIS
  // invoice's remaining debt. Both numbers come from @dokan/contracts, so the
  // preview cannot drift from what the server stores.
  const explicitPlan = settlementChosen
    ? explicitRefundSplit({ returnValue: valueTotal, cashPaidOut: requestedCash, invoiceDebt: invoice.remainingAmount })
    : null;
  const plan = explicitPlan ?? derivedSplit;
  const projectionIsValid = displayedSettlement !== null && cashIsValid && plan !== null;
  const projectedDebt = projectionIsValid ? plan.debtOffset : 0;
  const settledCash = projectionIsValid ? plan.cashPaidOut : Number.NaN;
  // the offset asked for is bigger than the debt that is left, so that much
  // CANNOT go to debt and is handed back as cash instead — surfaced explicitly
  // (mirrors the api) so an "all debt" choice never silently becomes cash
  const debtIsCapped = explicitPlan !== null && cashIsValid && Math.max(0, valueTotal - requestedCash) > explicitPlan.debtOffset;
  // collected-so-far on this invoice vs the settled cash portion: soft warning, never a block
  const cashExceedsCollected = Number.isFinite(settledCash) && settledCash > invoice.paidAmount;

  const create = useMutation(
    orpc.returnsCreate.mutationOptions({
      onSuccess: (record) => {
        setDrafts({});
        setReason("");
        setCashDraft("");
        setCashPercentage("");
        cashSource.current = null;
        // a fresh form re-derives the default from the new debt (#256)
        setSettlementChosen(false);
        setSettlement(null);
        setError(null);
        setSavedReturn(record);
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.returnsForInvoice.queryKey({ input: { invoiceId: invoice.id } }) }),
          // the shell badge and dashboard notice read this aggregate (issue #118)
          queryClient.invalidateQueries({ queryKey: orpc.returnsPendingCount.queryKey() }),
          queryClient.invalidateQueries({ queryKey: orpc.invoicesGet.queryKey({ input: { id: invoice.id } }) }),
          queryClient.invalidateQueries({ queryKey: ["activitiesList"] }),
        ]);
      },
      onError: (err) => {
        setSavedReturn(null);
        setError(tError(err.message));
      },
    }),
  );

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSavedReturn(null);
    const entered = returnableLines.filter((line) => !draftBlank(drafts[line.id] ?? ""));
    if (entered.length === 0) {
      setError(t("returnsNoLines"));
      return;
    }
    for (const line of entered) {
      const remaining = remainingReturnableFor(line, returns);
      const invalid = returnQuantityError(drafts[line.id] ?? "", remaining);
      if (invalid === "INVALID") {
        setError(t("returnsInvalidQuantity"));
        return;
      }
      if (invalid === "EXCEEDS") {
        setError(t("returnsExceedsRemaining", { remaining }));
        return;
      }
    }
    if (!cashIsValid) {
      setError(t("returnsInvalidCash"));
      return;
    }
    // the untouched form needs the derived split to exist before it may save:
    // read live in the handler, not only through the disabled button, because a
    // raw form submit bypasses a disabled control
    if (splitUnknown) {
      setError(t("returnsSplitUnknown"));
      return;
    }
    const lines = entered.flatMap((line) => {
      const quantity = parseWholeAmount(drafts[line.id] ?? "");
      return quantity === null ? [] : [{ invoiceLineId: line.id, quantity }];
    });
    void create.mutate({
      invoiceId: invoice.id,
      lines,
      reason: reason.trim() === "" ? undefined : reason.trim(),
      // an untouched default is sent absent so the SERVER derives it from fresh
      // debt (and refuses instead of capping when the debt moved); once the
      // owner picks, their explicit number is what settles
      cashPaidOut: settlementChosen ? requestedCash : undefined,
    });
  }

  return (
    <div className="rounded border bg-card p-4" data-testid="returns-panel">
      <h2 className="font-semibold">{t("returnsTitle")}</h2>
      {pendingReturns.length > 0 && (
        <p role="status" className="mt-2 rounded border border-warning/30 bg-warning/10 p-2 text-sm text-warning" data-testid="returns-pending-notice">
          {t("returnsPendingNotice", { count: pendingReturns.length })}
        </p>
      )}
      {returns.length > 0 && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="returns-counts">
          {t("returnsPendingCountLabel", { count: pendingReturns.length })} · {t("returnsReviewedCountLabel", { count: reviewedReturns.length })}
        </p>
      )}
      {!isSale ? (
        <EmptyState
          testId="returns-empty"
          className="mt-2"
          title={t("returnsEmpty")}
          hint={supplierAccountId === null ? t("invoiceReturnsPurchaseNoPartyHint") : t("invoiceReturnsPurchaseHint")}
          action={
            supplierAccountId === null ? (
              <Button size="lg" variant="outline" asChild>
                <Link to="/suppliers" data-testid="returns-supplier-action">{t("suppliersTitle")}</Link>
              </Button>
            ) : (
              <Button size="lg" variant="outline" asChild>
                <Link to="/suppliers/$partyId" params={{ partyId: supplierAccountId }} data-testid="returns-supplier-action">{t("invoiceReturnsSupplierAction")}</Link>
              </Button>
            )
          }
        />
      ) : returnsUnavailable ? (
        <EmptyState
          testId="returns-empty"
          className="mt-2"
          title={t("returnsEmpty")}
          hint={t("invoiceReturnsUnavailableHint")}
        />
      ) : returns.length === 0 ? (
        <EmptyState
          testId="returns-empty"
          className="mt-2"
          title={t("returnsEmpty")}
          hint={savedReturn !== null ? t("invoiceReturnsJustSavedHint") : t("invoiceReturnsEmptyHint")}
          action={
            savedReturn === null && hasReturnableLine ? (
              <Button
                size="lg"
                variant="outline"
                data-testid="returns-empty-action"
                onClick={() => firstEnabledField(formRef.current)?.focus()}
              >
                {t("returnsRecordTitle")}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <table className="mt-2 w-full text-sm" data-testid="returns-history">
          <thead>
            <tr className="border-b text-right text-muted-foreground">
              <th className="p-2">{t("returnNumber")}</th>
              <th className="p-2">{t("returnsRefundTotal")}</th>
              <th className="p-2">{t("returnsStatus")}</th>
              <th className="p-2">{t("returnVoucher")}</th>
            </tr>
          </thead>
          <tbody>
            {[...pendingReturns, ...reviewedReturns].map((record) => (
              <tr key={record.id} className="border-b last:border-0" data-testid="returns-row">
                <td className="p-2 cell-ltr">{record.returnNumber}</td>
                <td className="p-2 font-medium"><Amount value={record.refundAmount} /></td>
                <td className="p-2" data-testid={`returns-status-${record.status}`}>{t(`returnsStatus_${record.status}`)}</td>
                <td className="p-2">
                  <Link
                    to="/invoices/$invoiceId/returns/$returnId/print"
                    params={{ invoiceId: invoice.id, returnId: record.id }}
                    className="text-sm text-foreground underline"
                    data-testid={`return-print-${record.returnNumber}`}
                  >
                    {t("returnVoucher")}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {!isSale || returnsUnavailable ? null : savedReturn !== null ? (
        <SuccessCard
          testId="returns-done"
          className="mt-4"
          containerRef={cardRef}
          title={<span data-testid="returns-done-number">{t("returnsSavedNumber", { number: savedReturn.returnNumber })}</span>}
          detail={
            <span data-testid="returns-done-detail">
              {t("returnsSavedValue")} <Amount value={savedReturn.refundAmount} /> — {t("returnsSavedCash")} <Amount value={savedReturn.cashPaidOut} />
              {savedReturnDebt !== null && (<> · {t(savedReturnDebt.labelKey)} <Amount value={savedReturnDebt.value} /></>)}
            </span>
          }
        >
          <Button asChild>
            <Link to="/invoices/$invoiceId/returns/$returnId/print" params={{ invoiceId: invoice.id, returnId: savedReturn.id }} data-testid="returns-open-voucher">{t("returnVoucher")}</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/invoices/$invoiceId" params={{ invoiceId: invoice.id }} data-testid="returns-open-invoice">{t("savedViewInvoice")}</Link>
          </Button>
          <SuccessCardSpacer />
          <Button variant="ghost" onClick={() => setSavedReturn(null)} data-testid="returns-new">{t("returnsNew")}</Button>
        </SuccessCard>
      ) : (
      <form ref={formRef} className="mt-4 grid gap-3" onSubmit={submit} data-testid="returns-form">
        <h3 className="text-sm font-semibold">{t("returnsRecordTitle")}</h3>
        {returnableLines.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="returns-no-lines">{t("returnsNoLines")}</p>
        ) : (
          <div className="grid gap-2">
            {returnableLines.map((line) => {
              const remaining = remainingReturnableFor(line, returns);
              const soldOut = remaining === 0;
              return (
                <div
                  key={line.id}
                  className="grid gap-3 rounded-lg border border-border bg-background p-3 sm:grid-cols-[1fr_auto] sm:items-center"
                >
                  <div className="grid gap-0.5">
                    <span className="font-semibold">{line.description}</span>
                    <span className="text-xs text-muted-foreground">
                      {soldOut ? t("returnsNothingLeft") : t("returnsRemaining", { remaining })}
                    </span>
                  </div>
                  <label className="grid gap-1">
                    <span className="text-xs font-medium text-muted-foreground">{t("returnQuantity")}</span>
                    <span className="flex items-center gap-2">
                      <input
                        className="h-10 w-20 rounded-md border border-input bg-card text-center text-lg font-bold tabular-nums outline-none transition-[color,box-shadow] placeholder:text-muted-foreground/50 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50"
                        inputMode="numeric"
                        placeholder="0"
                        value={drafts[line.id] ?? ""}
                        onChange={(event) => {
                          setDrafts((current) => ({ ...current, [line.id]: event.target.value }));
                          setSavedReturn(null);
                        }}
                        disabled={soldOut || create.isPending}
                        aria-label={`${t("returnQuantity")} ${line.description}`}
                        data-testid={`returns-qty-${line.description}`}
                      />
                      <span className="text-sm text-muted-foreground">{t("returnsUnitPiece")}</span>
                    </span>
                  </label>
                </div>
              );
            })}
          </div>
        )}
        <div className="grid gap-3 rounded-lg border border-border bg-background p-3">
          <p className="text-xs font-semibold text-muted-foreground">{t("returnsSettlementSummary")}</p>
          <div className="grid gap-1.5 text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-muted-foreground">{t("returnsValue")}</span>
              <span data-testid="returns-value" className="text-lg font-bold"><Amount value={valueTotal} /></span>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-muted-foreground">{t("returnsRemainingDebt")}</span>
              <span data-testid="returns-remaining-debt" className="font-medium"><Amount value={invoice.remainingAmount} /></span>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <span className="text-muted-foreground">{t("returnsCollected")}</span>
              <span data-testid="returns-collected"><Amount value={invoice.paidAmount} /></span>
            </div>
            {hasPartyIdentity && partyDebt !== null && partyDebt > invoice.remainingAmount && (
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-muted-foreground">{t("returnsPartyDebt")}</span>
                <span data-testid="returns-party-debt" className="font-medium"><Amount value={partyDebt} /></span>
              </div>
            )}
          </div>
          <label className="grid gap-1 text-sm">
            <span className="font-medium">{t("returnsSplit")}</span>
            <Select
              value={displayedSettlement}
              onValueChange={(value) => {
                // SAFETY: the select renders only the three preset options, and
                // one is reachable only once a value exists
                const next = (value ?? "ALL_CASH") as ReturnSettlementPreset;
                setSettlementChosen(true);
                setSettlement(next);
                // the custom split opens at the full return value (100%): the
                // owner lowers either side to push the rest onto the debt
                if (next === "CUSTOM") {
                  cashSource.current = null;
                  setCashDraft(String(valueTotal));
                  setCashPercentage("100");
                }
                setSavedReturn(null);
              }}
              items={[
                { value: "ALL_CASH", label: t("returnsSplitAllCash") },
                { value: "ALL_DEBT", label: t("returnsSplitAllDebt") },
                { value: "CUSTOM", label: t("returnsSplitCustom") },
              ]}
            >
              <SelectTrigger className="w-full" data-testid="returns-settlement">
                <SelectValue placeholder={t("returnsSplitChoose")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL_CASH">{t("returnsSplitAllCash")}</SelectItem>
                <SelectItem value="ALL_DEBT">{t("returnsSplitAllDebt")}</SelectItem>
                <SelectItem value="CUSTOM">{t("returnsSplitCustom")}</SelectItem>
              </SelectContent>
            </Select>
          </label>
          {!settlementChosen && (settlementDefault.method === "SPLIT" || crossInvoiceDebt > 0) && (
            <div className="grid gap-2 rounded border border-border bg-muted/30 p-2" data-testid="returns-debt-default-note">
              <p className="text-xs text-muted-foreground">
                {settlementDefault.method === "SPLIT"
                  ? (
                    <Trans
                      i18nKey="returnsDebtSplitDefault"
                      components={{
                        debt: <Amount value={partyDebt ?? invoice.remainingAmount} />,
                        cash: <Amount value={derivedSplit?.cashPaidOut ?? 0} />,
                      }}
                    />
                  )
                  : <Trans i18nKey="returnsDebtAcrossInvoices" components={{ debt: <Amount value={partyDebt ?? invoice.remainingAmount} /> }} />}
              </p>
              {settlementDefault.method === "SPLIT" && crossInvoiceDebt > 0 && (
                <p className="text-xs text-muted-foreground">
                  <Trans i18nKey="returnsDebtAcrossInvoices" components={{ debt: <Amount value={partyDebt ?? invoice.remainingAmount} /> }} />
                </p>
              )}
            </div>
          )}
          {settlementChosen && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="justify-self-start"
              data-testid="returns-debt-confirm"
              onClick={() => {
                // back to the derived default: the payload goes back to ABSENT,
                // so the tab-aware split (which the explicit cap cannot
                // express) is what the server derives from fresh debt
                cashSource.current = null;
                setSettlementChosen(false);
              }}
            >
              {t("returnsDebtDefaultConfirm")}
            </Button>
          )}
          {splitUnknown && (
            <p className="rounded border border-warning/40 bg-warning/10 p-2 text-xs text-warning" data-testid="returns-split-unknown">
              {t("returnsSplitUnknown")}
            </p>
          )}
          {displayedSettlement === "CUSTOM" && (
            <div className="grid gap-1 text-sm">
              <AmountPercentageInput
                referenceTotal={valueTotal}
                value={{ amount: cashDraft, percentage: cashPercentage }}
                onChange={(next, edited) => {
                  cashSource.current = edited;
                  // an EDIT is the owner's own split: from here the api applies
                  // #162's cap at this invoice's debt, not the tab-aware default
                  setSettlementChosen(true);
                  // …and the method they are editing is this one, so record it
                  // explicitly (the displayed value is derived while untouched)
                  setSettlement("CUSTOM");
                  setCashDraft(next.amount);
                  setCashPercentage(next.percentage);
                  setSavedReturn(null);
                }}
                amountLabel={t("returnsCashNow")}
                referenceLabel={t("amountReferenceLabel")}
                amountTestId="returns-cash"
                percentageTestId="returns-percentage"
                referenceTestId="returns-reference"
                percentageInvalid={cashPercentageInvalid}
                amountPlaceholder={`${Math.max(0, valueTotal - invoice.remainingAmount)} – ${valueTotal}`}
              />
            </div>
          )}
          {projectionIsValid && (
            <div className="grid gap-1.5 border-t border-border pt-3 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-muted-foreground">{t("returnsDebtOffset")}</span>
                <span data-testid="returns-debt-offset" className="text-lg font-bold text-primary"><Amount value={projectedDebt} /></span>
              </div>
              <div className="flex items-baseline justify-between gap-3">
                <span className="text-muted-foreground">{t("returnsCashToCustomer")}</span>
                <span data-testid="returns-cash-now" className="text-lg font-bold"><Amount value={settledCash} /></span>
              </div>
            </div>
          )}
          {debtIsCapped && (
            <p className="rounded border border-warning/40 bg-warning/10 p-2 text-xs text-warning" data-testid="returns-debt-cap-note">
              <Trans i18nKey="returnsDebtCapNote" components={{ remaining: <Amount value={invoice.remainingAmount} />, cash: <Amount value={settledCash} /> }} />
            </p>
          )}
          {projectedDebt > 0 && (
            <p className="text-xs text-muted-foreground" data-testid="returns-debt-note">
              {t("returnsDebtAppliesOnAccept")}
            </p>
          )}
          {cashExceedsCollected && (
            <p className="rounded border border-warning/40 bg-warning/10 p-2 text-xs text-warning" data-testid="returns-cash-warning">
              <Trans i18nKey="returnsCashWarning" components={{ paid: <Amount value={invoice.paidAmount} /> }} />
            </p>
          )}
        </div>
        <label className="grid gap-1 text-sm">
          {t("returnsReason")}
          <input
            className={inputClass}
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              setSavedReturn(null);
            }}
            data-testid="returns-reason"
          />
        </label>
        <button
          type="submit"
          className="rounded-lg bg-primary py-2 text-primary-foreground disabled:opacity-50"
          disabled={create.isPending || splitUnknown}
          data-testid="returns-submit"
        >
          {t("returnsSave")}
        </button>
        {error && <p role="alert" className="rounded border border-destructive/20 bg-destructive/10 p-2 text-sm text-destructive" data-testid="returns-error">{error}</p>}
      </form>
      )}
    </div>
  );
}

/**
 * Invoice notes (issue #126). The printed receipt deliberately carries no
 * notes; the detail screen is the one place they are shown. Absent or blank
 * notes render nothing at all.
 */
export function InvoiceNotes({ notes }: { notes: string | null }) {
  const { t } = useTranslation();
  if (notes === null || notes.trim() === "") return null;
  return (
    <div className="mt-3 rounded border bg-accent p-3 text-sm" data-testid="invoice-notes">
      <div className="text-muted-foreground">{t("invoiceNotes")}</div>
      <p className="mt-1 whitespace-pre-wrap">{notes}</p>
    </div>
  );
}

export function InvoicePage() {
  const { t } = useTranslation();
  const { invoiceId } = useParams({ from: "/invoices/$invoiceId" });

  const detail = useQuery(orpc.invoicesGet.queryOptions({ input: { id: invoiceId } }));

  if (detail.isPending) {
    return <p className="text-sm text-muted-foreground">{t("activityError")}</p>;
  }
  if (detail.isError || detail.data === undefined) {
    const detailError = detail.error instanceof Error ? detail.error.message : undefined;
    return (
      <section className="grid gap-4" data-testid="invoice-error">
        <h1 className="text-xl font-bold">{t("invoiceTitle")}</h1>
        <p role="alert" className="rounded border border-destructive/20 bg-destructive/10 p-2 text-sm text-destructive" data-testid="invoice-error-text">{tError(detailError)}</p>
        <Link to="/invoices" className="text-sm underline">{t("invoiceBack")}</Link>
      </section>
    );
  }

  const invoice = detail.data;
  const remaining = invoice.remainingAmount;

  return (
    <section className="grid gap-4" data-testid="invoice-page">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">{t("invoiceTitle")} {invoice.invoiceNumber}</h1>
        <div className="flex items-center gap-2">
          <Link
            to="/invoices/$invoiceId/print"
            params={{ invoiceId }}
            className="rounded-lg bg-primary px-3 py-1 text-sm text-primary-foreground hover:bg-primary/80"
            data-testid="invoice-print"
          >
            {t("invoicePrint")}
          </Link>
          <Link to="/invoices" className="rounded-lg border px-3 py-1 text-sm hover:bg-muted" data-testid="invoice-back">{t("invoiceBack")}</Link>
        </div>
      </div>

      <div className="rounded border bg-card p-4">
        <InvoiceHeader />
        <dl className="mt-3 grid grid-cols-2 gap-2 text-sm">
          <div className="flex justify-between border-b py-1"><dt className="text-muted-foreground">{t("invoiceNumber")}</dt><dd data-testid="invoice-number">{invoice.invoiceNumber}</dd></div>
          <div className="flex justify-between border-b py-1"><dt className="text-muted-foreground">{t("invoiceKind")}</dt><dd data-testid="invoice-kind">{t(`invoiceKind_${invoice.kind}`)}</dd></div>
          <div className="flex justify-between border-b py-1"><dt className="text-muted-foreground">{t("invoiceParty")}</dt><dd data-testid="invoice-party">{invoice.counterpartyName ?? "—"}</dd></div>
          <div className="flex justify-between border-b py-1"><dt className="text-muted-foreground">{t("invoiceDateTime")}</dt><dd data-testid="invoice-date">{formatDateTime(combineBusinessDateTime(invoice.invoiceDate, invoice.createdAt))}</dd></div>
          <div className="flex justify-between py-1 font-semibold"><dt>{t("invoiceTotal")}</dt><dd data-testid="invoice-total"><Amount value={invoice.totalAmount} /></dd></div>
          <div className="flex justify-between py-1 font-semibold"><dt>{t("invoicePaid")}</dt><dd data-testid="invoice-paid"><Amount value={invoice.paidAmount} /></dd></div>
          {invoice.returnCreditAmount > 0 && (
            <div className="flex justify-between py-1 font-semibold"><dt>{t("invoiceReturnsCredit")}</dt><dd data-testid="invoice-returns-credit"><Amount value={invoice.returnCreditAmount} /></dd></div>
          )}
          <div className="flex justify-between py-1 text-lg font-bold"><dt>{t("invoiceRemaining")}</dt><dd data-testid="invoice-remaining"><Amount value={remaining} /></dd></div>
        </dl>

        <InvoiceNotes notes={invoice.notes} />

        {invoice.lines.length > 0 && (
          <>
            <h2 className="mt-4 font-semibold">{t("invoiceLinesTitle")}</h2>
            <table className="mt-2 w-full text-sm">
              <thead>
                <tr className="border-b text-right text-muted-foreground">
                  <th className="p-2">{t("itemsName")}</th>
                  <th className="p-2">{t("saleQuantity")}</th>
                  <th className="p-2">{t("saleActualPrice")}</th>
                  <th className="p-2">{t("saleLineTotal")}</th>
                </tr>
              </thead>
              <tbody>
                {invoice.lines.map((line) => (
                  <tr key={line.id} className="border-b last:border-0">
                    <td className="p-2">{line.description}</td>
                    <td className="p-2">{line.quantity}</td>
                    <td className="p-2"><Amount value={line.unitPrice} /></td>
                    <td className="p-2"><Amount value={line.netTotal} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>

      {/* the key reseeds the pair when the route moves to a different invoice;
          a same-invoice refetch keeps the instance and relinks instead */}
      <PaymentPanel key={invoice.id} invoice={invoice} />

      <ReturnsPanel invoice={invoice} />
    </section>
  );
}
