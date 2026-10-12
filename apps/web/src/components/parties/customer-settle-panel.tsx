import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import type { Invoice } from "@dokan/contracts";

import { Amount } from "@/components/ui/amount";
import { AmountPercentageInput, parseWholeAmount, type AmountPercentageValue } from "@/components/ui/amount-percentage-input";
import { Button } from "@/components/ui/button";

import { formatDate } from "@/lib/dates";
import { tError } from "@/lib/i18n";
import { orpc } from "@/lib/rpc";
import { distributePayment, settleAmountError } from "./party-settle";

/**
 * #164 (customer half) — settle a customer's debt without leaving the detail
 * page. The amount is a share of the unpaid total (#162 fields) and a preview
 * shows how it spreads over the unpaid invoices, oldest first, before the
 * owner confirms. Every line goes through the existing per-invoice
 * `invoicesPay`, so the money boundary (never above a remaining) is the api's,
 * not a second implementation here.
 */
export function CustomerSettlePanel({
  partyId,
  invoices,
  unpaid,
  onDone,
  onCancel,
}: {
  partyId: string;
  invoices: readonly Invoice[];
  unpaid: number;
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [value, setValue] = useState<AmountPercentageValue>(() => (unpaid > 0 ? { amount: String(unpaid), percentage: "100" } : { amount: "", percentage: "" }));
  const [error, setError] = useState<string | null>(null);
  const pay = useMutation(orpc.invoicesPay.mutationOptions());

  const amountError = settleAmountError(value.amount, unpaid);
  const amount = parseWholeAmount(value.amount);
  const plan = amount !== null && amount > 0 ? distributePayment(invoices, Math.min(amount, unpaid)) : [];
  const distributed = plan.reduce((sum, line) => sum + line.applied, 0);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    if (amountError === "INVALID") {
      setError(t("partySettleAmountRequired"));
      return;
    }
    if (amountError === "EXCEEDS") {
      setError(t("pmtExceedsRemaining", { remaining: unpaid }));
      return;
    }
    const targets = plan.filter((line) => line.applied > 0);
    if (targets.length === 0) {
      setError(t("partySettleNoDistribution"));
      return;
    }
    try {
      // one atomic payment per invoice: the api re-checks the boundary inside
      // each write unit, so a stale remaining can never be overpaid
      for (const line of targets) {
        await pay.mutateAsync({ invoiceId: line.invoice.id, amount: line.applied, method: "CASH" });
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: orpc.customersGet.queryKey({ input: { id: partyId } }) }),
        queryClient.invalidateQueries({ queryKey: ["invoicesList"] }),
        queryClient.invalidateQueries({ queryKey: ["activitiesList"] }),
      ]);
      setValue({ amount: "", percentage: "" });
      onDone();
    } catch (err) {
      // a failure mid-loop may have settled the earlier invoices already;
      // refresh so the preview reflects what is actually left
      setError(tError(err instanceof Error ? err.message : undefined));
      void queryClient.invalidateQueries({ queryKey: orpc.customersGet.queryKey({ input: { id: partyId } }) });
    }
  }

  return (
    <form className="grid gap-3 rounded border border-border bg-card p-4" onSubmit={submit} data-testid="party-settle-panel">
      <h3 className="font-semibold">{t("partySettleTitle")}</h3>
      <AmountPercentageInput
        referenceTotal={unpaid}
        value={value}
        onChange={setValue}
        amountLabel={t("pmtAmountLabel")}
        referenceLabel={t("partySettleReference")}
        amountTestId="party-settle-amount"
        percentageTestId="party-settle-percentage"
        referenceTestId="party-settle-reference"
        amountInvalid={amountError !== null}
        disabled={pay.isPending}
      />

      <div className="grid gap-1 border-t border-border pt-3">
        <p className="text-sm font-medium">{t("partySettleDistribution")}</p>
        {plan.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="party-settle-empty">{t("partySettleNoDistribution")}</p>
        ) : (
          <table className="w-full text-sm" data-testid="party-settle-preview">
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
                <tr key={invoice.id} className="border-b last:border-0" data-testid="party-settle-line">
                  <td className="p-2 cell-ltr">{invoice.invoiceNumber}</td>
                  <td className="p-2">{formatDate(invoice.invoiceDate)}</td>
                  <td className="p-2"><Amount value={invoice.remainingAmount} /></td>
                  <td className="p-2 font-semibold"><Amount value={applied} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="flex items-baseline justify-between gap-3 text-sm">
          <span className="text-muted-foreground">{t("partySettleRemainingAfter")}</span>
          <span className="text-lg font-bold" data-testid="party-settle-remaining"><Amount value={Math.max(0, unpaid - distributed)} /></span>
        </div>
      </div>

      {error !== null && (
        <p role="alert" className="rounded border border-destructive/20 bg-destructive/10 p-2 text-sm text-destructive" data-testid="party-settle-error">{error}</p>
      )}

      <div className="flex gap-2">
        <Button type="submit" disabled={pay.isPending || amountError === "INVALID"} data-testid="party-settle-confirm">
          {t("pmtRecord")}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={pay.isPending} data-testid="party-settle-cancel">
          {t("partyCancel")}
        </Button>
      </div>
    </form>
  );
}
