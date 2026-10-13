import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import type { Invoice, PaymentMethod } from "@dokan/contracts";

import { Amount } from "@/components/ui/amount";
import { AmountPercentageInput, amountFromPercentage, parseWholePercentage, percentageDraftInvalid, percentageFromAmount, type AmountPercentageValue } from "@/components/ui/amount-percentage-input";
import { parseGroupedAmount } from "@/lib/amount-parse";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

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
 *
 * The per-invoice payments are individually atomic but the batch is not, so a
 * mid-loop failure HALTS the panel: it refetches everything and refuses a
 * second confirm until the owner reopens it, which replans from the settled
 * rows instead of re-sending money already taken.
 */
export function CustomerSettlePanel({
  partyId,
  invoices,
  unpaid,
  onDone,
  onPartialWrite,
  onCancel,
}: {
  partyId: string;
  invoices: readonly Invoice[];
  unpaid: number;
  onDone: () => void;
  /** #174 round 1 — some per-invoice writes landed but the batch failed. The
   * caller must still refresh views derived from those rows (the detail read
   * refetches itself, but the paged tab queries carry their own keys). */
  onPartialWrite?: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [value, setValue] = useState<AmountPercentageValue>(() => (unpaid > 0 ? { amount: String(unpaid), percentage: "100" } : { amount: "", percentage: "" }));
  // #171 — the edited field stays the source when the unpaid total changes
  // underneath the panel (the customer detail refetches while it is open)
  const valueSource = useRef<"amount" | "percentage" | null>(null);
  const [method, setMethod] = useState<PaymentMethod>("CASH");
  const [error, setError] = useState<string | null>(null);
  const [halted, setHalted] = useState(false);
  // held across the WHOLE loop AND the refresh: `pay.isPending` ends when the
  // last per-invoice payment resolves, which is before `refresh()` settles, so
  // without this a second confirm during a slow refresh would re-plan from the
  // stale balances and record the same money again
  const [submitting, setSubmitting] = useState(false);
  const pay = useMutation(orpc.invoicesPay.mutationOptions());

  // #171 — relink when the unpaid total changes: an untouched pair follows the
  // new total, an edited amount stays the source, an edited percentage rescales;
  // a percentage-based draft falls to zero with the reference.
  useEffect(() => {
    setValue((current) => {
      if (unpaid === 0) {
        if (valueSource.current === "percentage") return { amount: "0", percentage: current.percentage };
        if (valueSource.current === null) return { amount: "", percentage: "" };
        return current;
      }
      if (valueSource.current === null) return { amount: String(unpaid), percentage: "100" };
      if (valueSource.current === "percentage") {
        const percentage = parseWholePercentage(current.percentage);
        return percentage === null ? current : { amount: String(amountFromPercentage(unpaid, percentage)), percentage: current.percentage };
      }
      const amount = parseGroupedAmount(current.amount);
      return { amount: current.amount, percentage: amount === null ? "" : String(percentageFromAmount(unpaid, amount)) };
    });
  }, [unpaid]);

  const amountError = settleAmountError(value.amount, unpaid);
  const percentageInvalid = percentageDraftInvalid(value.percentage);
  // validation is LIVE, not submit-time: an over-owed or garbage amount disables
  // confirm and says why, so the preview can never promise a payment the api
  // will refuse
  const amountErrorText =
    amountError === "EXCEEDS"
      ? t("pmtExceedsRemaining", { remaining: unpaid })
      : ((amountError === "INVALID" && value.amount.trim() !== "") || percentageInvalid)
        ? t("partySettleAmountRequired")
        : null;
  const amount = parseGroupedAmount(value.amount);
  const plan = amount !== null && amount > 0 ? distributePayment(invoices, Math.min(amount, unpaid)) : [];
  const distributed = plan.reduce((sum, line) => sum + line.applied, 0);
  const blocked = submitting || pay.isPending || halted || amountError !== null || percentageInvalid;

  function refresh() {
    return Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.customersGet.queryKey({ input: { id: partyId } }) }),
      queryClient.invalidateQueries({ queryKey: ["invoicesList"] }),
      queryClient.invalidateQueries({ queryKey: ["activitiesList"] }),
    ]);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    // the guard is checked INSIDE submit (not only on the disabled button) so a
    // form submit during the refresh window is a no-op; `halted` also blocks the
    // raw-submit bypass after a partial failure
    if (submitting || halted || pay.isPending) return;
    setError(null);
    if (amountError !== null || percentageInvalid) return;
    const targets = plan.filter((line) => line.applied > 0);
    if (targets.length === 0) {
      setError(t("partySettleNoDistribution"));
      return;
    }
    setSubmitting(true);
    // how many per-invoice payments actually landed; a mid-loop failure must
    // still signal the caller when any did, or the paged tabs stay stale
    let written = 0;
    try {
      // one atomic payment per invoice: the api re-checks the boundary inside
      // each write unit, so a stale remaining can never be overpaid
      for (const line of targets) {
        await pay.mutateAsync({ invoiceId: line.invoice.id, amount: line.applied, method });
        written += 1;
      }
      await refresh();
      onDone();
    } catch (err) {
      // a failure mid-loop may have settled the earlier invoices already:
      // refetch everything and refuse a second confirm, or the next submit
      // would replan from stale rows and re-send money already taken
      setError(tError(err instanceof Error ? err.message : undefined));
      setHalted(true);
      if (written > 0) onPartialWrite?.();
      void refresh();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="grid gap-3 rounded border border-border bg-card p-4" onSubmit={submit} data-testid="party-settle-panel">
      <h3 className="font-semibold">{t("partySettleTitle")}</h3>
      <AmountPercentageInput
        referenceTotal={unpaid}
        value={value}
        onChange={(next, edited) => {
          valueSource.current = edited;
          setValue(next);
        }}
        amountLabel={t("pmtAmountLabel")}
        referenceLabel={t("partySettleReference")}
        amountTestId="party-settle-amount"
        percentageTestId="party-settle-percentage"
        referenceTestId="party-settle-reference"
        amountInvalid={amountError !== null}
        percentageInvalid={percentageInvalid}
        disabled={pay.isPending || submitting}
      />
      <label className="grid gap-1 text-sm">
        {t("pmtMethod")}
        <Select
          value={method}
          onValueChange={(next) => {
            // SAFETY: the select renders only the CASH / BANK options, so the value is a PaymentMethod
            setMethod((next ?? "CASH") as PaymentMethod);
          }}
          disabled={pay.isPending || submitting}
          items={[
            { value: "CASH", label: t("pmtMethod_CASH") },
            { value: "BANK", label: t("pmtMethod_BANK") },
          ]}
        >
          <SelectTrigger className="w-full" data-testid="party-settle-method">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="CASH">{t("pmtMethod_CASH")}</SelectItem>
            <SelectItem value="BANK">{t("pmtMethod_BANK")}</SelectItem>
          </SelectContent>
        </Select>
      </label>

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
          <span aria-live="polite" className="text-lg font-bold" data-testid="party-settle-remaining"><Amount value={Math.max(0, unpaid - distributed)} /></span>
        </div>
      </div>

      {(amountErrorText ?? error) !== null && (
        <p role="alert" className="rounded border border-destructive/20 bg-destructive/10 p-2 text-sm text-destructive" data-testid="party-settle-error">
          {amountErrorText ?? error}
        </p>
      )}
      {halted && <p className="text-xs text-warning" data-testid="party-settle-halted">{t("partySettleHalted")}</p>}

      <div className="flex gap-2">
        <Button type="submit" disabled={blocked} data-testid="party-settle-confirm">
          {t("pmtRecord")}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={pay.isPending || submitting} data-testid="party-settle-cancel">
          {t("partyCancel")}
        </Button>
      </div>
    </form>
  );
}
