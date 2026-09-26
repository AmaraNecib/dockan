import { Link, useParams } from "@tanstack/react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

import type { InvoiceDetail, PaymentMethod, ReturnDetail } from "@dokan/contracts";

import { Amount } from "@/components/ui/amount";
import { InvoiceHeader } from "@/components/invoice-header";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { tError } from "../lib/i18n";
import { orpc } from "../lib/rpc";

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
 * Router-free payment panel (same shape as purchase's LinkProposalPanel):
 * full history + record-payment form, unit-testable without a router.
 */
export function PaymentPanel({ invoice }: { invoice: InvoiceDetail }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState<PaymentMethod>("CASH");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [recorded, setRecorded] = useState(false);

  const pay = useMutation(
    orpc.invoicesPay.mutationOptions({
      onSuccess: () => {
        setAmount("");
        setNote("");
        setError(null);
        setRecorded(true);
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
        setRecorded(false);
        // a stale tab can still reach the api: the server re-checks the
        // boundary inside the transaction and returns the exact key
        setError(tError(err.message));
      },
    }),
  );

  const remaining = invoice.remainingAmount;
  const remainingMessage = paymentAmountError(amount, remaining);

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setRecorded(false);
    if (remainingMessage !== null) {
      // same boundary as the api: an instalment never exceeds what is owed
      setError(remainingMessage === "EXCEEDS" ? t("pmtExceedsRemaining", { remaining }) : t("pmtInvalidAmount"));
      return;
    }
    void pay.mutate({
      invoiceId: invoice.id,
      amount: Number(amount),
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
                <td className="p-2" dir="ltr">{payment.paidAt}</td>
                <td className="p-2 font-medium"><Amount value={payment.amount} /></td>
                <td className="p-2">{t(`pmtMethod_${payment.method}`)}</td>
                <td className="p-2 text-muted-foreground">{payment.note ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <form className="mt-4 grid gap-3" onSubmit={submit} data-testid="pmt-form">
        <div className="grid grid-cols-3 gap-3">
          <label className="grid gap-1 text-sm">
            {t("pmtAmountLabel")}
            <input
              className="rounded border px-3 py-2"
              inputMode="numeric"
              value={amount}
              onChange={(event) => {
                setAmount(event.target.value);
                setRecorded(false);
              }}
              disabled={remaining === 0}
              data-testid="pmt-amount"
            />
          </label>
          <label className="grid gap-1 text-sm">
            {t("pmtMethod")}
            <Select
              value={method}
              onValueChange={(value) => {
                // SAFETY: the select renders only the CASH / BANK options, so the value is a PaymentMethod
                setMethod((value ?? "CASH") as PaymentMethod);
                setRecorded(false);
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
              className="rounded border px-3 py-2"
              value={note}
              onChange={(event) => {
                setNote(event.target.value);
                setRecorded(false);
              }}
              disabled={remaining === 0}
              data-testid="pmt-note"
            />
          </label>
        </div>
        {remaining === 0 ? (
          <p className="text-sm text-green-700" data-testid="pmt-unavailable">{t("pmtUnavailable")}</p>
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
        {recorded && <p role="status" className="text-sm text-green-700" data-testid="pmt-done">{t("pmtRecorded")}</p>}
      </form>
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

/** Whole-DZD value of `quantity` returned units of a SALE line (mirror of the
 * api's refund math: a full line refunds its netTotal exactly, partials price
 * at the rounded effective unit). Used only to present the settlement split
 * before submit — the api recomputes authoritatively. */
export function lineReturnValue(line: { quantity: number; netTotal: number }, quantity: number): number {
  if (quantity === line.quantity) return line.netTotal;
  return quantity * Math.round(line.netTotal / line.quantity);
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
  const [error, setError] = useState<string | null>(null);
  const [recorded, setRecorded] = useState(false);

  const returns = returnsQuery.data?.items ?? [];
  const returnableLines = useMemo(() => invoice.lines.filter((line) => line.itemId !== null), [invoice.lines]);

  // client projection of the return value from the entered drafts (the api
  // recomputes authoritatively; this only drives the settlement presets)
  const valueTotal = useMemo(
    () =>
      returnableLines.reduce((sum, line) => {
        const quantity = Number(drafts[line.id] ?? "");
        if (!Number.isInteger(quantity) || quantity <= 0) return sum;
        return sum + lineReturnValue(line, quantity);
      }, 0),
    [returnableLines, drafts],
  );
  const requestedCash =
    settlement === "ALL_CASH" ? valueTotal : settlement === "ALL_DEBT" ? 0 : Number(cashDraft.trim() === "" ? "" : cashDraft);
  const cashIsValid = settlement !== "CUSTOM" || customCashError(cashDraft, valueTotal) === null;
  // mirror the api's settlement so the warning tracks the ACTUAL cash the
  // server will settle: requested debt is capped at the invoice's remaining
  // debt and any excess flows back to cash (all-debt beyond the debt swings
  // into cash, which must warn too)
  const projectedDebt = Math.min(Math.max(0, valueTotal - requestedCash), invoice.remainingAmount);
  const settledCash = Number.isFinite(requestedCash) ? valueTotal - projectedDebt : Number.NaN;
  // collected-so-far on this invoice vs the settled cash portion: soft warning, never a block
  const cashExceedsCollected = Number.isFinite(settledCash) && settledCash > invoice.paidAmount;

  const create = useMutation(
    orpc.returnsCreate.mutationOptions({
      onSuccess: () => {
        setDrafts({});
        setReason("");
        setCashDraft("");
        setSettlement("ALL_CASH");
        setError(null);
        setRecorded(true);
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.returnsList.queryKey({ input: { invoiceId: invoice.id } }) }),
          queryClient.invalidateQueries({ queryKey: orpc.invoicesGet.queryKey({ input: { id: invoice.id } }) }),
          queryClient.invalidateQueries({ queryKey: ["activitiesList"] }),
        ]);
      },
      onError: (err) => {
        setRecorded(false);
        setError(tError(err.message));
      },
    }),
  );

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setRecorded(false);
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
            {returns.map((record) => (
              <tr key={record.id} className="border-b last:border-0" data-testid="returns-row">
                <td className="p-2" dir="ltr">{record.returnNumber}</td>
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

      <form className="mt-4 grid gap-3" onSubmit={submit} data-testid="returns-form">
        <h3 className="text-sm font-semibold">{t("returnsRecordTitle")}</h3>
        {returnableLines.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="returns-no-lines">{t("returnsNoLines")}</p>
        ) : (
          <div className="grid gap-2">
            {returnableLines.map((line) => {
              const remaining = remainingReturnableFor(line, returns);
              return (
                <label key={line.id} className="grid grid-cols-[1fr_auto] items-center gap-3 text-sm">
                  <span>
                    {line.description}
                    <span className="ml-2 text-muted-foreground">{t("returnsRemaining", { remaining })}</span>
                  </span>
                  <input
                    className="w-24 rounded border px-2 py-1"
                    inputMode="numeric"
                    value={drafts[line.id] ?? ""}
                    onChange={(event) => {
                      setDrafts((current) => ({ ...current, [line.id]: event.target.value }));
                      setRecorded(false);
                    }}
                    disabled={remaining === 0 || create.isPending}
                    aria-label={`${t("returnQuantity")} ${line.description}`}
                    data-testid={`returns-qty-${line.description}`}
                  />
                </label>
              );
            })}
          </div>
        )}
        <div className="grid gap-2 rounded border bg-accent p-3 text-sm">
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t("returnsValue")}</span>
            <span className="font-medium" data-testid="returns-value">{valueTotal} {t("dzd")}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-muted-foreground">{t("returnsCollected")}</span>
            <span data-testid="returns-collected">{invoice.paidAmount} {t("dzd")}</span>
          </div>
          <label className="grid gap-1">
            {t("returnsSplit")}
            <Select
              value={settlement}
              onValueChange={(value) => {
                // SAFETY: the select renders only the three preset options
                setSettlement((value ?? "ALL_CASH") as ReturnSettlementPreset);
                setRecorded(false);
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
            <label className="grid gap-1">
              {t("returnsCashNow")}
              <input
                className="rounded border px-2 py-1"
                inputMode="numeric"
                value={cashDraft}
                onChange={(event) => {
                  setCashDraft(event.target.value);
                  setRecorded(false);
                }}
                placeholder={`0 – ${valueTotal}`}
                data-testid="returns-cash"
              />
            </label>
          )}
          {Number.isFinite(settledCash) && (
            <div className="flex justify-between">
              <span className="text-muted-foreground">{t("returnsCashNow")}</span>
              <span className="font-medium" data-testid="returns-cash-now">{settledCash} {t("dzd")}</span>
            </div>
          )}
          {projectedDebt > 0 && (
            <p className="text-xs text-muted-foreground" data-testid="returns-debt-note">
              {t("returnsDebtAppliesOnAccept")}
            </p>
          )}
          {cashExceedsCollected && (
            <p className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-600" data-testid="returns-cash-warning">
              {t("returnsCashWarning", { paid: invoice.paidAmount })}
            </p>
          )}
        </div>
        <label className="grid gap-1 text-sm">
          {t("returnsReason")}
          <input
            className="rounded border px-3 py-2"
            value={reason}
            onChange={(event) => {
              setReason(event.target.value);
              setRecorded(false);
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
        {recorded && <p role="status" className="text-sm text-green-700" data-testid="returns-done">{t("returnsSaved")}</p>}
      </form>
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
          <div className="flex justify-between border-b py-1"><dt className="text-muted-foreground">{t("invoiceDate")}</dt><dd dir="ltr" data-testid="invoice-date">{invoice.invoiceDate}</dd></div>
          <div className="flex justify-between py-1 font-semibold"><dt>{t("invoiceTotal")}</dt><dd data-testid="invoice-total"><Amount value={invoice.totalAmount} /></dd></div>
          <div className="flex justify-between py-1 font-semibold"><dt>{t("invoicePaid")}</dt><dd data-testid="invoice-paid"><Amount value={invoice.paidAmount} /></dd></div>
          <div className="flex justify-between py-1 text-lg font-bold"><dt>{t("invoiceRemaining")}</dt><dd data-testid="invoice-remaining"><Amount value={remaining} /></dd></div>
        </dl>

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
