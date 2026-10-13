import { useEffect, useRef, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { AmountPercentageInput, amountFromPercentage, parseWholePercentage, percentageDraftInvalid, percentageFromAmount, type AmountPercentageValue } from "@/components/ui/amount-percentage-input";
import { parseGroupedAmount } from "@/lib/amount-parse";
import { Button } from "@/components/ui/button";

import { tError } from "@/lib/i18n";
import { orpc } from "@/lib/rpc";

/**
 * #161 — «استرداد رصيد من المورّد»: the supplier hands back cash to close the
 * credit the shop holds. The amount is a share of the available credit (#162
 * fields) and may never exceed it; the api re-checks the boundary.
 */
export function SupplierRefundPanel({
  supplierId,
  availableCredit,
  onDone,
  onWriteFailed,
  onCancel,
}: {
  supplierId: string;
  availableCredit: number;
  onDone: () => void;
  /** #174 round 1 — a failed (possibly lost-response) call may still have
   * written a row, so the caller must refresh the derived tab reads. */
  onWriteFailed?: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [value, setValue] = useState<AmountPercentageValue>(() => (availableCredit > 0 ? { amount: String(availableCredit), percentage: "100" } : { amount: "", percentage: "" }));
  const valueSource = useRef<"amount" | "percentage" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const refund = useMutation(orpc.suppliersRefund.mutationOptions());

  useEffect(() => {
    setValue((current) => {
      if (availableCredit === 0) {
        if (valueSource.current === "percentage") return { amount: "0", percentage: current.percentage };
        if (valueSource.current === null) return { amount: "", percentage: "" };
        return current;
      }
      if (valueSource.current === null) return { amount: String(availableCredit), percentage: "100" };
      if (valueSource.current === "percentage") {
        const percentage = parseWholePercentage(current.percentage);
        return percentage === null ? current : { amount: String(amountFromPercentage(availableCredit, percentage)), percentage: current.percentage };
      }
      const amount = parseGroupedAmount(current.amount);
      return { amount: current.amount, percentage: amount === null ? "" : String(percentageFromAmount(availableCredit, amount)) };
    });
  }, [availableCredit]);

  const percentageInvalid = percentageDraftInvalid(value.percentage);
  const amount = parseGroupedAmount(value.amount);
  const amountError = amount === null || amount <= 0 ? t("partySettleAmountRequired") : amount > availableCredit ? t("REFUND_EXCEEDS_CREDIT") : null;

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting || refund.isPending || amountError !== null || percentageInvalid || amount === null) return;
    setError(null);
    setSubmitting(true);
    try {
      await refund.mutateAsync({ supplierId, amount });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: orpc.suppliersGet.queryKey({ input: { id: supplierId } }) }),
        queryClient.invalidateQueries({ queryKey: ["activitiesList"] }),
      ]);
      onDone();
    } catch (err) {
      setError(tError(err instanceof Error ? err.message : undefined));
      onWriteFailed?.();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="grid gap-3 rounded border border-border bg-card p-4" onSubmit={submit} data-testid="supplier-refund-panel">
      <h3 className="font-semibold">{t("supplierRefundTitle")}</h3>
      <AmountPercentageInput
        referenceTotal={availableCredit > 0 ? availableCredit : null}
        value={value}
        onChange={(next, edited) => {
          valueSource.current = edited;
          setValue(next);
        }}
        amountLabel={t("pmtAmountLabel")}
        referenceLabel={t("supplierRefundReference")}
        amountTestId="supplier-refund-amount"
        percentageTestId="supplier-refund-percentage"
        referenceTestId="supplier-refund-reference"
        amountInvalid={amountError !== null}
        percentageInvalid={percentageInvalid}
        disabled={refund.isPending || submitting}
      />
      {(amountError ?? error) !== null && (
        <p role="alert" className="rounded border border-destructive/20 bg-destructive/10 p-2 text-sm text-destructive" data-testid="supplier-refund-error">{amountError ?? error}</p>
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={submitting || refund.isPending || amountError !== null || percentageInvalid} data-testid="supplier-refund-confirm">{t("supplierRefundSave")}</Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={submitting || refund.isPending} data-testid="supplier-refund-cancel">{t("partyCancel")}</Button>
      </div>
    </form>
  );
}
