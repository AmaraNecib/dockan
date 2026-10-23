import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import type { Invoice, PaymentMethod } from "@dokan/contracts";

import { Amount } from "@/components/ui/amount";
import { AmountPercentageInput, amountFromPercentage, parseWholePercentage, percentageDraftInvalid, percentageFromAmount, type AmountPercentageValue } from "@/components/ui/amount-percentage-input";
import { draftBlank, parseGroupedAmount } from "@/lib/amount-parse";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { formatDate } from "@/lib/dates";
import { tError } from "@/lib/i18n";
import { invalidatePartyMoney } from "@/lib/party-cache-key";
import { orpc } from "@/lib/rpc";
import { distributePayment, unpaidInvoices } from "./party-settle";

type PayTarget = "OLDEST" | "INVOICE" | "CREDIT";

/**
 * #161 — pay a supplier without leaving the detail page. The amount is a share
 * of what the shop owes (the #162 fields). Default is oldest-first over the
 * unpaid purchase invoices, with a switch to a specific invoice or to leave the
 * whole amount as a credit. Every line goes through the api's `suppliersPay`,
 * which owns the boundary and the excess-to-credit split.
 */
export function SupplierPayPanel({
  supplierId,
  balance,
  invoices,
  onDone,
  onWriteFailed,
  onCancel,
}: {
  supplierId: string;
  /** signed account balance (#260: negative = we owe the supplier); the
   * percentage reference is the amount still owed, max(0, -balance) */
  balance: number;
  invoices: readonly Invoice[];
  onDone: () => void;
  /** #174 round 1 — a failed (possibly lost-response) call may still have
   * written a row, so the caller must refresh the derived tab reads. */
  onWriteFailed?: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const owed = Math.max(0, -balance);
  const outstanding = unpaidInvoices(invoices);
  const [target, setTarget] = useState<PayTarget>("OLDEST");
  const [invoiceId, setInvoiceId] = useState<string>(outstanding[0]?.id ?? "");
  const [value, setValue] = useState<AmountPercentageValue>(() => (owed > 0 ? { amount: String(owed), percentage: "100" } : { amount: "", percentage: "" }));
  const valueSource = useRef<"amount" | "percentage" | null>(null);
  const [method, setMethod] = useState<PaymentMethod>("CASH");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const pay = useMutation(orpc.suppliersPay.mutationOptions());

  // SAFETY: the target Select renders only OLDEST / INVOICE / CREDIT, so any
  // value it hands back is a PayTarget (and null falls back to the default).
  const onTargetChange = (next: string | null) => setTarget((next ?? "OLDEST") as PayTarget);
  // SAFETY: the method Select renders only CASH / BANK, a PaymentMethod.
  const onMethodChange = (next: string | null) => setMethod((next ?? "CASH") as PaymentMethod);

  useEffect(() => {
    setValue((current) => {
      if (owed === 0) {
        if (valueSource.current === "percentage") return { amount: "0", percentage: current.percentage };
        if (valueSource.current === null) return { amount: "", percentage: "" };
        return current;
      }
      if (valueSource.current === null) return { amount: String(owed), percentage: "100" };
      if (valueSource.current === "percentage") {
        const percentage = parseWholePercentage(current.percentage);
        return percentage === null ? current : { amount: String(amountFromPercentage(owed, percentage)), percentage: current.percentage };
      }
      const amount = parseGroupedAmount(current.amount);
      return { amount: current.amount, percentage: amount === null ? "" : String(percentageFromAmount(owed, amount)) };
    });
  }, [owed]);

  const percentageInvalid = percentageDraftInvalid(value.percentage);
  const amount = parseGroupedAmount(value.amount);
  const amountInvalid = amount === null || amount <= 0;
  // #161 — a payment may exceed what is owed: the excess becomes supplier
  // credit (the api splits it), so over-owed is NOT an error here. Only a
  // malformed/zero amount or an invalid percentage draft blocks confirm.
  const errorText = (amountInvalid && !draftBlank(value.amount)) || percentageInvalid ? t("partySettleAmountRequired") : null;

  const selected = outstanding.find((invoice) => invoice.id === invoiceId);
  const plan = amount === null || amount <= 0
    ? []
    : target === "CREDIT"
      ? []
      : target === "INVOICE"
        ? [{ invoice: selected, applied: Math.min(amount, selected?.remainingAmount ?? 0) }].filter((line): line is { invoice: Invoice; applied: number } => line.invoice !== undefined)
        : distributePayment(invoices, amount);
  const distributed = plan.reduce((sum, line) => sum + line.applied, 0);
  const credit = amount === null ? 0 : Math.max(0, amount - distributed);
  const blocked = submitting || pay.isPending || errorText !== null || amountInvalid || outstanding.length === 0 && target === "INVOICE";

  function refresh() {
    return Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.suppliersGet.queryKey({ input: { id: supplierId } }) }),
      // #323 — the payment settled the supplier's invoices, so the tab the
      // debts screen reads under the party's canonical key is stale.
      invalidatePartyMoney(queryClient, { kind: "PURCHASE", counterpartyId: supplierId, counterpartyName: null }),
      // #323 — the debts screen shows this supplier's total; the payment moved
      // it, so that list is stale too.
      queryClient.invalidateQueries({ queryKey: ["invoicesList"] }),
    ]);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting || pay.isPending) return;
    setError(null);
    if (amount === null || amount <= 0 || percentageInvalid || errorText !== null) return;
    setSubmitting(true);
    try {
      await pay.mutateAsync({
        supplierId,
        amount,
        method,
        note: note.trim() === "" ? undefined : note.trim(),
        target: target === "INVOICE" ? { kind: "INVOICE", invoiceId } : { kind: target },
      });
      await refresh();
      onDone();
    } catch (err) {
      setError(tError(err instanceof Error ? err.message : undefined));
      void refresh();
      onWriteFailed?.();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="grid gap-3 rounded border border-border bg-card p-4" onSubmit={submit} data-testid="supplier-pay-panel">
      <h3 className="font-semibold">{t("supplierPayTitle")}</h3>
      {owed === 0 && <p className="text-sm text-muted-foreground" data-testid="supplier-pay-no-owed">{t("supplierPayNoOwed")}</p>}
      <AmountPercentageInput
        referenceTotal={owed > 0 ? owed : null}
        value={value}
        onChange={(next, edited) => {
          valueSource.current = edited;
          setValue(next);
        }}
        amountLabel={t("pmtAmountLabel")}
        referenceLabel={t("supplierPayReference")}
        amountTestId="supplier-pay-amount"
        percentageTestId="supplier-pay-percentage"
        referenceTestId="supplier-pay-reference"
        amountInvalid={errorText !== null}
        percentageInvalid={percentageInvalid}
        disabled={pay.isPending || submitting}
      />
      <label className="grid gap-1 text-sm">
        {t("supplierPayTarget")}
        <Select
          value={target}
          onValueChange={onTargetChange}
          disabled={pay.isPending || submitting}
          items={[
            { value: "OLDEST", label: t("supplierPayTarget_OLDEST") },
            { value: "INVOICE", label: t("supplierPayTarget_INVOICE") },
            { value: "CREDIT", label: t("supplierPayTarget_CREDIT") },
          ]}
        >
          <SelectTrigger className="w-full" data-testid="supplier-pay-target">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="OLDEST">{t("supplierPayTarget_OLDEST")}</SelectItem>
            <SelectItem value="INVOICE">{t("supplierPayTarget_INVOICE")}</SelectItem>
            <SelectItem value="CREDIT">{t("supplierPayTarget_CREDIT")}</SelectItem>
          </SelectContent>
        </Select>
      </label>
      {target === "INVOICE" && (
        <label className="grid gap-1 text-sm">
          {t("supplierPayInvoiceLabel")}
          <Select value={invoiceId} onValueChange={(next) => setInvoiceId(next ?? "")} disabled={pay.isPending || submitting} items={outstanding.map((invoice) => ({ value: invoice.id, label: invoice.invoiceNumber }))}>
            <SelectTrigger className="w-full" data-testid="supplier-pay-invoice">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {outstanding.map((invoice) => (
                <SelectItem key={invoice.id} value={invoice.id}>{invoice.invoiceNumber}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      )}
      <label className="grid gap-1 text-sm">
        {t("pmtMethod")}
        <Select
          value={method}
          onValueChange={onMethodChange}
          disabled={pay.isPending || submitting}
          items={[
            { value: "CASH", label: t("pmtMethod_CASH") },
            { value: "BANK", label: t("pmtMethod_BANK") },
          ]}
        >
          <SelectTrigger className="w-full" data-testid="supplier-pay-method">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="CASH">{t("pmtMethod_CASH")}</SelectItem>
            <SelectItem value="BANK">{t("pmtMethod_BANK")}</SelectItem>
          </SelectContent>
        </Select>
      </label>
      <label className="grid gap-1 text-sm">
        {t("partyPaymentNote")}
        <input className="rounded border bg-background px-2 py-1 text-sm" value={note} onChange={(event) => setNote(event.target.value)} data-testid="supplier-pay-note" />
      </label>

      <div className="grid gap-1 border-t border-border pt-3">
        <p className="text-sm font-medium">{t("supplierPayPreview")}</p>
        {plan.length > 0 && (
          <table className="w-full text-sm" data-testid="supplier-pay-preview">
            <thead>
              <tr className="border-b text-right text-muted-foreground">
                <th scope="col" className="p-2 font-medium">{t("debtsInvNumber")}</th>
                <th scope="col" className="p-2 font-medium">{t("debtsInvDate")}</th>
                <th scope="col" className="p-2 font-medium">{t("partySettleInvoiceRemaining")}</th>
                <th scope="col" className="p-2 font-medium">{t("partySettleApplied")}</th>
              </tr>
            </thead>
            <tbody>
              {plan.map(({ invoice, applied }) => (
                <tr key={invoice.id} className="border-b last:border-0" data-testid="supplier-pay-line">
                  <td className="p-2 cell-ltr">{invoice.invoiceNumber}</td>
                  <td className="p-2">{formatDate(invoice.invoiceDate)}</td>
                  <td className="p-2"><Amount value={invoice.remainingAmount} /></td>
                  <td className="p-2 font-semibold"><Amount value={applied} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {credit > 0 && (
          <p className="text-sm text-muted-foreground" data-testid="supplier-pay-credit">
            {t("supplierPayCredit")}: <Amount value={credit} />
          </p>
        )}
      </div>

      {(errorText ?? error) !== null && (
        <p role="alert" className="rounded border border-destructive/20 bg-destructive/10 p-2 text-sm text-destructive" data-testid="supplier-pay-error">
          {errorText ?? error}
        </p>
      )}

      <div className="flex gap-2">
        <Button type="submit" disabled={blocked} data-testid="supplier-pay-confirm">{t("pmtRecord")}</Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={pay.isPending || submitting} data-testid="supplier-pay-cancel">{t("partyCancel")}</Button>
      </div>
    </form>
  );
}
