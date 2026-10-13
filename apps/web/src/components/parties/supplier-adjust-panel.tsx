import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import type { Invoice, SupplierAdjustmentDirection } from "@dokan/contracts";

import { Amount } from "@/components/ui/amount";
import { parseWholeAmount } from "@/components/ui/amount-percentage-input";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { nowDateTimeText, parseDateTimeText } from "@/lib/dates";
import { tError } from "@/lib/i18n";
import { DEBTS_BY_PARTY_QUERY_KEY, orpc } from "@/lib/rpc";

const REASON_PRESETS = ["supplierAdjustPresetOpening", "supplierAdjustPresetCorrection", "supplierAdjustPresetOldDebt", "supplierAdjustPresetDiscount"] as const;

/**
 * #176 — «تسوية»: a signed manual adjustment written straight on the supplier
 * account, with no invoice. Account-only it moves the balance and never touches
 * an invoice. Linking an open purchase invoice turns it into a discount that
 * reduces THAT invoice's remaining with the same conditional UPDATE returns
 * use; the amount may not exceed the remaining (the api refuses the excess).
 */
export function SupplierAdjustPanel({
  supplierId,
  supplierName,
  balance,
  invoices,
  onDone,
  onCancel,
}: {
  supplierId: string;
  supplierName: string;
  /** signed account balance before this adjustment */
  balance: number;
  invoices: readonly Invoice[];
  onDone: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const openInvoices = invoices.filter((invoice) => invoice.kind === "PURCHASE" && invoice.remainingAmount > 0);
  const [direction, setDirection] = useState<SupplierAdjustmentDirection>("WE_OWE");
  const [amountDraft, setAmountDraft] = useState("");
  const [reasonDraft, setReasonDraft] = useState("");
  // device-local day-first text, exactly what parseDateTimeText + the shared
  // formatter round-trip
  const [dateDraft, setDateDraft] = useState(() => nowDateTimeText().slice(0, 10));
  const [linked, setLinked] = useState(false);
  const [invoiceId, setInvoiceId] = useState(openInvoices[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const adjust = useMutation(orpc.suppliersAdjust.mutationOptions());

  const amount = parseWholeAmount(amountDraft);
  const occurredAt = parseDateTimeText(dateDraft);
  const dateInvalid = dateDraft.trim() === "" || occurredAt === null;
  // NEVER auto-switch the linked invoice. The owner picked a specific invoice;
  // if a background refresh settles and removes it, keep the selection and ask
  // the owner to choose again (Greptile round 1 finding 2: the old fallback
  // silently selected another invoice and discounted it).
  const selected = openInvoices.find((invoice) => invoice.id === invoiceId);
  const selectionLost = linked && invoiceId !== "" && selected === undefined;
  const noInvoiceChosen = linked && openInvoices.length > 0 && invoiceId === "";
  // linking only reduces an invoice, so the direction is forced to يسالنا
  const effectiveDirection: SupplierAdjustmentDirection = linked ? "THEY_OWE" : direction;
  const exceeds = linked && selected !== undefined && amount !== null && amount > selected.remainingAmount;
  const amountError =
    amount === null || amount <= 0
      ? amountDraft.trim() === ""
        ? null
        : t("supplierAdjustAmountRequired")
      : exceeds
        ? t("supplierAdjustExceedsRemaining")
        : null;
  const linkError =
    !linked || openInvoices.length === 0
      ? null
      : selectionLost
        ? t("supplierAdjustInvoiceGone")
        : noInvoiceChosen
          ? t("supplierAdjustInvoiceRequired")
          : null;
  const previewBalance = amount === null || amount <= 0 ? balance : balance + (effectiveDirection === "WE_OWE" ? amount : -amount);
  const previewRemaining = linked && selected !== undefined && amount !== null && amount > 0 ? Math.max(0, selected.remainingAmount - amount) : null;
  const blocked = submitting || adjust.isPending || amountError !== null || amount === null || amount <= 0 || dateInvalid || linkError !== null || (linked && openInvoices.length === 0);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (blocked) return;
    setError(null);
    setSubmitting(true);
    try {
      await adjust.mutateAsync({
        supplierId,
        direction: effectiveDirection,
        amount,
        reason: reasonDraft.trim() === "" ? undefined : reasonDraft.trim(),
        occurredAt: occurredAt ?? undefined,
        invoiceId: linked ? invoiceId : undefined,
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: orpc.suppliersGet.queryKey({ input: { id: supplierId } }) }),
        queryClient.invalidateQueries({ queryKey: ["invoicesList"] }),
        queryClient.invalidateQueries({ queryKey: ["activitiesList"] }),
        // the real debt/dashboard keys (Greptile round 1 finding 5: ["debtsData"]
        // matched nothing, so saving never marked the debts views stale)
        queryClient.invalidateQueries({ queryKey: orpc.reportsDebts.queryKey() }),
        queryClient.invalidateQueries({ queryKey: DEBTS_BY_PARTY_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: orpc.dashboardSummary.queryKey() }),
      ]);
      onDone();
    } catch (err) {
      setError(tError(err instanceof Error ? err.message : undefined));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="grid gap-3 rounded border border-border bg-card p-4" onSubmit={submit} data-testid="supplier-adjust-panel">
      <h3 className="font-semibold">{t("supplierAdjustTitle", { name: supplierName })}</h3>

      <div className="grid gap-1">
        <span className="text-sm text-muted-foreground">{t("supplierAdjustDirection")}</span>
        <div className="flex gap-2" role="group" aria-label={t("supplierAdjustDirection")}>
          <Button
            type="button"
            variant={effectiveDirection === "WE_OWE" ? "default" : "outline"}
            aria-pressed={effectiveDirection === "WE_OWE"}
            disabled={linked || adjust.isPending || submitting}
            onClick={() => setDirection("WE_OWE")}
            data-testid="supplier-adjust-direction-we-owe"
            title={t("supplierAdjustDirectionWeOweHint")}
          >
            {t("supplierAdjustDirectionWeOwe")}
          </Button>
          <Button
            type="button"
            variant={effectiveDirection === "THEY_OWE" ? "default" : "outline"}
            aria-pressed={effectiveDirection === "THEY_OWE"}
            disabled={adjust.isPending || submitting}
            onClick={() => setDirection("THEY_OWE")}
            data-testid="supplier-adjust-direction-they-owe"
            title={t("supplierAdjustDirectionTheyOweHint")}
          >
            {t("supplierAdjustDirectionTheyOwe")}
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <label className="grid gap-1 text-sm">
          {t("supplierAdjustAmount")}
          <input
            className="h-9 w-40 rounded-lg border border-input bg-background px-3 text-sm"
            inputMode="numeric"
            autoComplete="off"
            value={amountDraft}
            onChange={(event) => setAmountDraft(event.target.value)}
            aria-invalid={amountError !== null}
            data-testid="supplier-adjust-amount"
          />
        </label>
        <label className="grid gap-1 text-sm">
          {t("supplierAdjustDate")}
          <input
            className="h-9 w-32 rounded-lg border border-input bg-background px-3 text-sm"
            inputMode="numeric"
            autoComplete="off"
            value={dateDraft}
            onChange={(event) => setDateDraft(event.target.value)}
            aria-invalid={dateInvalid}
            data-testid="supplier-adjust-date"
          />
        </label>
      </div>

      <div className="grid gap-1">
        <label className="grid gap-1 text-sm">
          {t("supplierAdjustReason")}
          <input
            className="h-9 w-full rounded-lg border border-input bg-background px-3 text-sm"
            value={reasonDraft}
            onChange={(event) => setReasonDraft(event.target.value)}
            placeholder={t("supplierAdjustReasonPlaceholder")}
            data-testid="supplier-adjust-reason"
          />
        </label>
        <div className="flex flex-wrap gap-1">
          {REASON_PRESETS.map((preset) => (
            <Button key={preset} type="button" variant="outline" size="sm" onClick={() => setReasonDraft(t(preset))} data-testid={preset}>
              {t(preset)}
            </Button>
          ))}
        </div>
      </div>

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={linked}
          onChange={(event) => setLinked(event.target.checked)}
          data-testid="supplier-adjust-link"
        />
        {t("supplierAdjustLinkInvoice")}
      </label>
      {linked && (
        openInvoices.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="supplier-adjust-no-invoices">{t("supplierPayNoOwed")}</p>
        ) : (
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1 text-sm">
              {t("supplierPayInvoiceLabel")}
              <Select value={selected !== undefined ? invoiceId : ""} onValueChange={(next) => setInvoiceId(next ?? "")}>
                <SelectTrigger className="w-56" data-testid="supplier-adjust-invoice">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {openInvoices.map((invoice) => (
                    <SelectItem key={invoice.id} value={invoice.id}>
                      {invoice.invoiceNumber}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {selected !== undefined && (
              <p className="text-sm text-muted-foreground" data-testid="supplier-adjust-invoice-remaining">
                {t("supplierAdjustInvoiceRemaining")}: <Amount value={selected.remainingAmount} />
              </p>
            )}
            {linkError !== null && (
              <p role="alert" className="w-full text-sm text-destructive" data-testid="supplier-adjust-link-error">{linkError}</p>
            )}
          </div>
        )
      )}

      <div className="rounded border border-border bg-background p-2 text-sm" data-testid="supplier-adjust-preview">
        <p>
          {t("supplierAdjustPreview")}: <span className="font-semibold"><Amount value={Math.abs(previewBalance)} /></span>
          {previewBalance !== 0 && <span> {previewBalance > 0 ? t("supplierAdjustDirectionWeOwe") : t("supplierAdjustDirectionTheyOwe")}</span>}
        </p>
        {previewRemaining !== null ? (
          <p className="mt-1" data-testid="supplier-adjust-preview-remaining">
            {t("supplierAdjustPreviewLinked")}: <span className="font-semibold"><Amount value={previewRemaining} /></span>
          </p>
        ) : (
          <p className="mt-1 text-muted-foreground">{t("supplierAdjustPreviewNote")}</p>
        )}
      </div>

      {(amountError ?? error) !== null && (
        <p role="alert" className="rounded border border-destructive/20 bg-destructive/10 p-2 text-sm text-destructive" data-testid="supplier-adjust-error">
          {amountError ?? error}
        </p>
      )}

      <div className="flex gap-2">
        <Button type="submit" disabled={blocked} data-testid="supplier-adjust-confirm">{t("supplierAdjustSave")}</Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={submitting || adjust.isPending} data-testid="supplier-adjust-cancel">{t("partyCancel")}</Button>
      </div>
    </form>
  );
}
