import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trans, useTranslation } from "react-i18next";

import type { Invoice } from "@dokan/contracts";

import { Amount } from "@/components/ui/amount";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

import { draftBlank, parseLooseNumber, parseWholeAmount } from "@/lib/amount-parse";

import { tError } from "@/lib/i18n";
import { invalidatePartyBalance } from "@/lib/party-cache-key";
import { orpc } from "@/lib/rpc";
import { parseCashBackDraft, parseReturnQuantities } from "./supplier-return-draft";

type ReturnMode = "INVOICE_LINKED" | "FREE_STANDING";

/**
 * #161 — record a purchase return: invoice-linked (same process as a sale
 * return, capped at bought-minus-already-returned) or free-standing (item +
 * quantity + amount, costed at the item's current average). Auto-accepted: the
 * api has no review state. The signed account entry and the invoice debt move
 * in one unit server-side.
 */
export function SupplierReturnPanel({
  supplierId,
  balance,
  invoices,
  onDone,
  onWriteFailed,
  onCancel,
}: {
  supplierId: string;
  /** the signed account balance under the #260 convention: negative while the
   * shop owes the supplier, positive when the supplier owes us. The default
   * cash back is derived from it (#256). */
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
  const [mode, setMode] = useState<ReturnMode>("INVOICE_LINKED");
  const [invoiceId, setInvoiceId] = useState<string>(invoices[0]?.id ?? "");
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [itemId, setItemId] = useState<string>("");
  const [quantity, setQuantity] = useState("");
  const [amount, setAmount] = useState("");
  const [cashBack, setCashBack] = useState("");
  /** #256 — once the owner types a cash back, that number is what they mean */
  const cashBackTouched = useRef(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const create = useMutation(orpc.suppliersReturn.mutationOptions());

  // SAFETY: the mode Select renders only INVOICE_LINKED / FREE_STANDING.
  const onModeChange = (next: string | null) => setMode((next ?? "INVOICE_LINKED") as ReturnMode);

  const detail = useQuery({ ...orpc.invoicesGet.queryOptions({ input: { id: invoiceId } }), enabled: mode === "INVOICE_LINKED" && invoiceId !== "" });
  const items = useQuery({ ...orpc.itemsAll.queryOptions(), enabled: mode === "FREE_STANDING" });

  const invoiceValue = useMemo(() => {
    if (detail.data === undefined) return 0;
    return detail.data.lines.reduce((sum, line) => {
      // The same reader as `parseReturnQuantities`, so the preview can never sum
      // a line the submit path refuses (`1e3`, `5.5`) or, before #210, read an
      // Arabic-Indic digit as zero while the submit path read it as five.
      const qty = parseWholeAmount(quantities[line.id] ?? "0") ?? 0;
      return qty > 0 ? sum + qty * line.unitPrice : sum;
    }, 0);
  }, [detail.data, quantities]);
  // the free-standing amount keeps the loose `Number` read it always had, now
  // digit-normalised: an Arabic-Indic draft reads like its ASCII twin (#225)
  const value = mode === "INVOICE_LINKED" ? invoiceValue : parseLooseNumber(amount) || 0;
  const parsedQuantities = parseReturnQuantities(quantities);
  const invoiceReady = "lines" in parsedQuantities;
  const parsedCash = parseCashBackDraft(cashBack);
  const cashInvalid = parsedCash === null;
  // #256 — the owner's rule, visible before saving: while the shop owes the
  // supplier the return applies against that debt (no cash back); with nothing
  // owed either way the default is to get the money back as cash. An untouched
  // field submits no cashBack at all, so the SERVER derives it from the ledger
  // it reads inside the write transaction. #260: the debt we owe is a NEGATIVE
  // balance, so the same polarity the server derives applies here.
  const defaultCashBack = balance < 0 ? 0 : value;
  // a nonempty draft that is not a positive whole number must be rejected, not
  // silently dropped: otherwise the saved return differs from the preview
  const quantityDraftInvalid = !invoiceReady && Object.values(quantities).some((draft) => !draftBlank(draft));

  function refresh() {
    return Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.suppliersGet.queryKey({ input: { id: supplierId } }) }),
      // #323 — the return moved the supplier's money, so the tab the debts
      // screen reads under the party's canonical key is stale.
      invalidatePartyBalance(queryClient, { kind: "PURCHASE", counterpartyId: supplierId, counterpartyName: null }),
      // #323 — the debts screen shows this supplier's total; the return moved
      // it, so that list is stale too.
      queryClient.invalidateQueries({ queryKey: orpc.reportsDebts.queryKey() }),
      queryClient.invalidateQueries({ queryKey: ["invoicesList"] }),
      queryClient.invalidateQueries({ queryKey: orpc.itemsAll.queryKey() }),
      queryClient.invalidateQueries({ queryKey: ["activitiesList"] }),
      queryClient.invalidateQueries({ queryKey: ["suppliersReturnsList"] }),
    ]);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (submitting || create.isPending) return;
    setError(null);
    setSubmitting(true);
    try {
      if (mode === "INVOICE_LINKED") {
        if (!("lines" in parsedQuantities) || parsedCash === null) throw new Error("supplierReturnInvalidDraft");
        await create.mutateAsync({
          supplierId,
          invoiceId,
          lines: parsedQuantities.lines,
          reason: reason.trim() === "" ? undefined : reason.trim(),
          cashBack: cashBackTouched.current ? parsedCash : undefined,
        });
      } else {
        const freeQuantity = parseWholeAmount(quantity);
        if (itemId === "" || freeQuantity === null || freeQuantity <= 0 || value <= 0 || parsedCash === null) {
          throw new Error("supplierReturnInvalidDraft");
        }
        await create.mutateAsync({
          supplierId,
          itemId,
          quantity: freeQuantity,
          amount: value,
          reason: reason.trim() === "" ? undefined : reason.trim(),
          cashBack: cashBackTouched.current ? parsedCash : undefined,
        });
      }
      await refresh();
      onDone();
    } catch (err) {
      setError(tError(err instanceof Error ? err.message : undefined));
      onWriteFailed?.();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="grid gap-3 rounded border border-border bg-card p-4" onSubmit={submit} data-testid="supplier-return-panel">
      <h3 className="font-semibold">{t("supplierReturnTitle")}</h3>
      <label className="grid gap-1 text-sm">
        {t("supplierReturnMode")}
        <Select
          value={mode}
          onValueChange={onModeChange}
          disabled={create.isPending || submitting}
          items={[
            { value: "INVOICE_LINKED", label: t("supplierReturnMode_INVOICE") },
            { value: "FREE_STANDING", label: t("supplierReturnMode_FREE") },
          ]}
        >
          <SelectTrigger className="w-full" data-testid="supplier-return-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="INVOICE_LINKED">{t("supplierReturnMode_INVOICE")}</SelectItem>
            <SelectItem value="FREE_STANDING">{t("supplierReturnMode_FREE")}</SelectItem>
          </SelectContent>
        </Select>
      </label>

      {mode === "INVOICE_LINKED" ? (
        <>
          <label className="grid gap-1 text-sm">
            {t("supplierReturnInvoice")}
            <Select value={invoiceId} onValueChange={(next) => { setInvoiceId(next ?? ""); setQuantities({}); }} disabled={create.isPending || submitting} items={invoices.map((invoice) => ({ value: invoice.id, label: invoice.invoiceNumber }))}>
              <SelectTrigger className="w-full" data-testid="supplier-return-invoice">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {invoices.map((invoice) => (
                  <SelectItem key={invoice.id} value={invoice.id}>{invoice.invoiceNumber}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          {detail.isSuccess && (
            <table className="w-full text-sm" data-testid="supplier-return-lines">
              <thead>
                <tr className="border-b text-right text-muted-foreground">
                  <th scope="col" className="p-2 font-medium">{t("itemsName")}</th>
                  <th scope="col" className="p-2 font-medium">{t("saleQuantity")}</th>
                  <th scope="col" className="p-2 font-medium">{t("supplierReturnQty")}</th>
                </tr>
              </thead>
              <tbody>
                {detail.data.lines.map((line) => (
                  <tr key={line.id} className="border-b last:border-0">
                    <td className="p-2">{line.description}</td>
                    <td className="p-2">{line.quantity}</td>
                    <td className="p-2">
                      <input
                        className="w-20 rounded border bg-background px-2 py-1"
                        inputMode="numeric"
                        value={quantities[line.id] ?? ""}
                        onChange={(event) => setQuantities((current) => ({ ...current, [line.id]: event.target.value }))}
                        disabled={create.isPending || submitting}
                        data-testid={`supplier-return-qty-${line.id}`}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      ) : (
        <>
          <label className="grid gap-1 text-sm">
            {t("supplierReturnItem")}
            <Select value={itemId} onValueChange={(next) => setItemId(next ?? "")} disabled={create.isPending || submitting} items={(items.data?.items ?? []).map((item) => ({ value: item.id, label: item.name }))}>
              <SelectTrigger className="w-full" data-testid="supplier-return-item">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(items.data?.items ?? []).map((item) => (
                  <SelectItem key={item.id} value={item.id}>{item.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <div className="grid grid-cols-2 gap-3">
            <label className="grid gap-1 text-sm">
              {t("supplierReturnQty")}
              <input className="rounded border bg-background px-2 py-1" inputMode="numeric" value={quantity} onChange={(event) => setQuantity(event.target.value)} disabled={create.isPending || submitting} data-testid="supplier-return-quantity" />
            </label>
            <label className="grid gap-1 text-sm">
              {t("supplierReturnAmount")}
              <input className="rounded border bg-background px-2 py-1" inputMode="numeric" value={amount} onChange={(event) => setAmount(event.target.value)} disabled={create.isPending || submitting} data-testid="supplier-return-amount" />
            </label>
          </div>
        </>
      )}

      <div className="grid grid-cols-2 gap-3">
        <label className="grid gap-1 text-sm">
          {t("supplierReturnCashBack")}
          <input
            className="rounded border bg-background px-2 py-1"
            inputMode="numeric"
            value={cashBack}
            onChange={(event) => {
              cashBackTouched.current = true;
              setCashBack(event.target.value);
            }}
            disabled={create.isPending || submitting}
            data-testid="supplier-return-cash"
          />
        </label>
        <label className="grid gap-1 text-sm">
          {t("supplierReturnReason")}
          <input className="rounded border bg-background px-2 py-1" value={reason} onChange={(event) => setReason(event.target.value)} disabled={create.isPending || submitting} data-testid="supplier-return-reason" />
        </label>
      </div>

      <p className="text-sm text-muted-foreground" data-testid="supplier-return-value">
        {t("returnsValue")}: <Amount value={value} />
      </p>

      {!cashBackTouched.current && (balance < 0 || value > 0) && (
        <p className="text-xs text-muted-foreground" data-testid="supplier-return-cash-default">
          {defaultCashBack === 0
            ? t("supplierReturnDefaultDebt")
            : <Trans i18nKey="supplierReturnDefaultCash" components={{ money: <Amount value={defaultCashBack} /> }} />}
        </p>
      )}

      {error !== null && (
        <p role="alert" className="rounded border border-destructive/20 bg-destructive/10 p-2 text-sm text-destructive" data-testid="supplier-return-error">{error}</p>
      )}
      {((mode === "INVOICE_LINKED" && quantityDraftInvalid) || cashInvalid) && (
        <p role="alert" className="rounded border border-destructive/20 bg-destructive/10 p-2 text-sm text-destructive" data-testid="supplier-return-draft-error">
          {t("supplierReturnInvalidDraft")}
        </p>
      )}

      <div className="flex gap-2">
        <Button
          type="submit"
          disabled={
            submitting ||
            create.isPending ||
            cashInvalid ||
            (mode === "INVOICE_LINKED" ? !invoiceReady : value <= 0 || itemId === "")
          }
          data-testid="supplier-return-confirm"
        >
          {t("supplierReturnSave")}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={submitting || create.isPending} data-testid="supplier-return-cancel">{t("partyCancel")}</Button>
      </div>
    </form>
  );
}
