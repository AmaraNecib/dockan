import { Link, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { computeReturnRefund } from "@dokan/contracts";
import type { InvoiceDetail, PaymentMethod, ReturnDetail } from "@dokan/contracts";

import { Amount } from "@/components/ui/amount";
import { AmountPercentageInput, amountFromPercentage, parseWholeAmount, parseWholePercentage, percentageDraftInvalid, percentageFromAmount, type AmountPercentageValue } from "@/components/ui/amount-percentage-input";
import { Button } from "@/components/ui/button";
import { InvoiceHeader } from "@/components/invoice-header";
import { inputClass } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SuccessCard, SuccessCardSpacer } from "@/components/ui/success-card";

import { tError } from "../lib/i18n";
import { orpc } from "../lib/rpc";
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
  const trimmed = amount.trim();
  if (!/^\d+$/u.test(trimmed)) return "INVALID";
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value <= 0) return "INVALID";
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
 * Router-free payment panel (same shape as purchase's LinkProposalPanel):
 * full history + record-payment form, unit-testable without a router.
 */
export function PaymentPanel({ invoice }: { invoice: InvoiceDetail }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  // #162 — the instalment is a share of this invoice's remaining, so both the
  // amount and the percentage are offered; the default is the full remaining.
  const [paid, setPaid] = useState<AmountPercentageValue>(() => seedPaid(invoice.remainingAmount));
  const [method, setMethod] = useState<PaymentMethod>("CASH");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
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
    const first = Array.from(formRef.current?.querySelectorAll<HTMLInputElement>("input") ?? []).find((field) => !field.disabled);
    const target = first ?? paidOffRef.current;
    if (target === null || target === undefined) return;
    target.focus();
    // consume the flag only once focus actually moved; a failed move leaves it
    // set for the next saved-state transition
    if (document.activeElement === target) restoreFocusPending.current = false;
  }, [savedPayment]);

  const pay = useMutation(
    orpc.invoicesPay.mutationOptions({
      onSuccess: (_updated, variables) => {
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
        ]);
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
  const remainingMessage = paymentAmountError(paid.amount, remaining);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setSavedPayment(null);
    if (remainingMessage !== null) {
      // same boundary as the api: an instalment never exceeds what is owed
      setError(remainingMessage === "EXCEEDS" ? t("pmtExceedsRemaining", { remaining }) : t("pmtInvalidAmount"));
      return;
    }
    void pay.mutate({
      invoiceId: invoice.id,
      amount: Number(paid.amount),
      method,
      note: note.trim() === "" ? undefined : note.trim(),
    });
  }

  return (
    <div className="rounded border bg-card p-4" data-testid="pmt-panel">
      <h2 className="font-semibold">{t("pmtTitle")}</h2>
      {invoice.payments.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground" data-testid="pmt-empty">{t("pmtEmpty")}</p>
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
            <span data-testid="pmt-saved-detail"><Amount value={savedPayment.amount} suffix={t("dzd")} /> — {t(`pmtMethod_${savedPayment.method}`)}</span>
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
          onChange={(next) => {
            setPaid(next);
            setSavedPayment(null);
          }}
          amountLabel={t("pmtAmountLabel")}
          referenceLabel={t("amountReferenceLabel")}
          amountTestId="pmt-amount"
          percentageTestId="pmt-percentage"
          referenceTestId="pmt-reference"
          amountInvalid={remainingMessage !== null}
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
            disabled={pay.isPending}
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

/** Pure boundary check shared with the unit tests (mirrors the api cap). */
export function returnQuantityError(draft: string, remaining: number): "INVALID" | "EXCEEDS" | null {
  const trimmed = draft.trim();
  if (trimmed === "") return null; // an untouched line is not part of the return
  if (!/^\d+$/u.test(trimmed)) return "INVALID";
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value <= 0) return "INVALID";
  if (value > remaining) return "EXCEEDS";
  return null;
}

export type ReturnSettlementPreset = "ALL_CASH" | "ALL_DEBT" | "CUSTOM";

/** Validates a custom cash draft for the settlement split. */
export function customCashError(draft: string, valueTotal: number): "INVALID" | "EXCEEDS" | null {
  const trimmed = draft.trim();
  if (trimmed === "") return null; // untouched = all-debt
  if (!/^\d+$/u.test(trimmed)) return "INVALID";
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value < 0) return "INVALID";
  if (value > valueTotal) return "EXCEEDS";
  return null;
}

export function ReturnsPanel({ invoice }: { invoice: InvoiceDetail }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const returnsQuery = useQuery(orpc.returnsList.queryOptions({ input: { invoiceId: invoice.id } }));
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [reason, setReason] = useState("");
  const [settlement, setSettlement] = useState<ReturnSettlementPreset>("ALL_CASH");
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
    const first = Array.from(formRef.current?.querySelectorAll<HTMLInputElement>("input") ?? []).find((field) => !field.disabled);
    if (first === undefined) return;
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
      const quantity = Number(drafts[line.id] ?? "");
      if (!Number.isInteger(quantity) || quantity <= 0) return [];
      return [{ invoiceLineId: line.id, quantity, netTotal: line.netTotal, lineQuantity: line.quantity }];
    });
    if (entered.length === 0) return 0;
    return computeReturnRefund(entered, priorByLine).refundTotal;
  }, [returnableLines, drafts, priorByLine]);
  // #162 — relink the custom cash split when the return value changes: the
  // edited field is the source, so 50% of a 900 return becomes 50% of the new
  // value instead of a stale amount. A percentage-based split falls to zero
  // when the return value does.
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
      setCashDraft(String(valueTotal));
      setCashPercentage("100");
      return;
    }
    if (cashSource.current === "percentage") {
      const percentage = parseWholePercentage(cashPercentage);
      if (percentage !== null) setCashDraft(String(amountFromPercentage(valueTotal, percentage)));
      return;
    }
    const amount = parseWholeAmount(cashDraft);
    setCashPercentage(amount === null ? "" : String(percentageFromAmount(valueTotal, amount)));
  }, [valueTotal, cashDraft, cashPercentage]);
  const requestedCash =
    settlement === "ALL_CASH" ? valueTotal : settlement === "ALL_DEBT" ? 0 : Number(cashDraft.trim() === "" ? "" : cashDraft);
  // an invalid percentage draft clears the derived amount, and an empty amount
  // is the legitimate "all debt" choice — so it must be rejected explicitly or
  // "12.5%" would silently be recorded as zero cash
  const cashPercentageInvalid = settlement === "CUSTOM" && percentageDraftInvalid(cashPercentage);
  const cashIsValid = settlement !== "CUSTOM" || (customCashError(cashDraft, valueTotal) === null && !cashPercentageInvalid);
  // mirror the api's settlement so the warning tracks the ACTUAL cash the
  // server will settle: requested debt is capped at the invoice's remaining
  // debt and any excess flows back to cash (all-debt beyond the debt swings
  // into cash, which must warn too)
  // The projection mirrors the api's settlement exactly (`debtOffset =
  // min(requestedDebt, remaining)`, `cash = refund − debtOffset`). It is shown
  // only while the custom-cash draft is a VALID whole-DZD amount: an empty or
  // bad draft would otherwise render a NaN (or an inflated) split, and
  // `customCashError` already blocks submitting exactly that input.
  const requestedDebt = Math.max(0, valueTotal - requestedCash);
  const projectionIsValid = cashIsValid && Number.isFinite(requestedDebt);
  const projectedDebt = projectionIsValid ? Math.min(requestedDebt, invoice.remainingAmount) : 0;
  const settledCash = projectionIsValid ? valueTotal - projectedDebt : Number.NaN;
  // the offset asked for is bigger than the debt that is left, so that much
  // CANNOT go to debt and is handed back as cash instead — surfaced explicitly
  // (mirrors the api) so an "all debt" choice never silently becomes cash
  const debtIsCapped = projectionIsValid && requestedDebt > projectedDebt;
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
        setSettlement("ALL_CASH");
        setError(null);
        setSavedReturn(record);
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.returnsList.queryKey({ input: { invoiceId: invoice.id } }) }),
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
    const entered = returnableLines.filter((line) => (drafts[line.id] ?? "").trim() !== "");
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
    const lines = entered.map((line) => ({ invoiceLineId: line.id, quantity: Number(drafts[line.id]) }));
    void create.mutate({
      invoiceId: invoice.id,
      lines,
      reason: reason.trim() === "" ? undefined : reason.trim(),
      cashPaidOut: settlement === "ALL_CASH" ? undefined : requestedCash,
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
      {returns.length === 0 ? (
        <p className="mt-2 text-sm text-muted-foreground" data-testid="returns-empty">{t("returnsEmpty")}</p>
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
                <td className="p-2 font-medium">{record.refundAmount} {t("dzd")}</td>
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

      {savedReturn !== null ? (
        <SuccessCard
          testId="returns-done"
          className="mt-4"
          containerRef={cardRef}
          title={<span data-testid="returns-done-number">{t("returnsSavedNumber", { number: savedReturn.returnNumber })}</span>}
          detail={
            <span data-testid="returns-done-detail">
              {t("returnsSavedValue")} <Amount value={savedReturn.refundAmount} suffix={t("dzd")} /> — {t("returnsSavedCash")} <Amount value={savedReturn.cashPaidOut} suffix={t("dzd")} />
              {savedReturnDebt !== null && (<> · {t(savedReturnDebt.labelKey)} <Amount value={savedReturnDebt.value} suffix={t("dzd")} /></>)}
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
          </div>
          <label className="grid gap-1 text-sm">
            <span className="font-medium">{t("returnsSplit")}</span>
            <Select
              value={settlement}
              onValueChange={(value) => {
                // SAFETY: the select renders only the three preset options
                const next = (value ?? "ALL_CASH") as ReturnSettlementPreset;
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
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="ALL_CASH">{t("returnsSplitAllCash")}</SelectItem>
                <SelectItem value="ALL_DEBT">{t("returnsSplitAllDebt")}</SelectItem>
                <SelectItem value="CUSTOM">{t("returnsSplitCustom")}</SelectItem>
              </SelectContent>
            </Select>
          </label>
          {settlement === "CUSTOM" && (
            <div className="grid gap-1 text-sm">
              <AmountPercentageInput
                referenceTotal={valueTotal}
                value={{ amount: cashDraft, percentage: cashPercentage }}
                onChange={(next, edited) => {
                  cashSource.current = edited;
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
              {t("returnsDebtCapNote", { remaining: invoice.remainingAmount, cash: settledCash })}
            </p>
          )}
          {projectedDebt > 0 && (
            <p className="text-xs text-muted-foreground" data-testid="returns-debt-note">
              {t("returnsDebtAppliesOnAccept")}
            </p>
          )}
          {cashExceedsCollected && (
            <p className="rounded border border-warning/40 bg-warning/10 p-2 text-xs text-warning" data-testid="returns-cash-warning">
              {t("returnsCashWarning", { paid: invoice.paidAmount })}
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
          disabled={create.isPending}
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

      <PaymentPanel invoice={invoice} />

      <ReturnsPanel invoice={invoice} />
    </section>
  );
}
