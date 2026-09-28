import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Amount } from "@/components/ui/amount";

import { tError } from "../lib/i18n";
import { orpc } from "../lib/rpc";

/**
 * Ticket 27 — manual add-stock form + item history (append-only ledger,
 * FIFO-derived remaining stock). Raw facts come from the api; stockAfter is
 * derived, never stored.
 */

export function StockForm() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const items = useQuery(orpc.itemsList.queryOptions());
  const [itemId, setItemId] = useState("");
  const [delta, setDelta] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Submit falls back to the first item when nothing was picked, so surface
  // that same choice in the trigger: the operator must always see the item the
  // movement will be recorded against (greptile PR #80).
  const selectedItemId = itemId || items.data?.items[0]?.id || "";
  const selectedItem = items.data?.items.find((item) => item.id === selectedItemId) ?? null;

  // Mirror the item's last known unit cost into the cost field when the
  // selection changes. The ref guard means a background refetch (after a stock
  // movement) can never overwrite a value the owner is typing.
  const prefilledItemRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedItem === null) return;
    if (prefilledItemRef.current === selectedItemId) return;
    prefilledItemRef.current = selectedItemId;
    setUnitCost(String(selectedItem.costPrice));
  }, [selectedItemId, selectedItem]);

  const adjust = useMutation(
    orpc.stockAddManual.mutationOptions({
      onSuccess: () => {
        setDelta("");
        setUnitCost("");
        setReason("");
        setDone(true);
        void Promise.all([
          queryClient.invalidateQueries({ queryKey: orpc.itemsList.queryKey() }),
          queryClient.invalidateQueries({ queryKey: orpc.itemsLowStock.queryKey() }),
          queryClient.invalidateQueries({ queryKey: orpc.dashboardSummary.queryKey() }),
        ]);
      },
      onError: (err) => setError(tError(err.message)),
    }),
  );

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setDone(false);
    const parsedDelta = Number(delta);
    if (!selectedItemId) {
      setError(t("itemsEmpty"));
      return;
    }
    if (!Number.isInteger(parsedDelta) || parsedDelta === 0) {
      setError(t("stockQuantity"));
      return;
    }
    void adjust.mutate({
      itemId: selectedItemId,
      delta: parsedDelta,
      unitCost: parsedDelta > 0 && unitCost !== "" ? Number(unitCost) : undefined,
      reason: reason === "" ? undefined : reason,
    });
  }

  return (
    <form className="mt-4 grid gap-3 rounded border bg-card p-4" onSubmit={submit} data-testid="stock-form">
      <h2 className="font-semibold">{t("stockAddTitle")}</h2>
      <label className="grid gap-1">
        {t("stockItem")}
        <Select
          value={selectedItemId}
          onValueChange={(value) => setItemId(value ?? "")}
          items={items.data?.items.map((item) => ({ value: item.id, label: item.name })) ?? []}
        >
          <SelectTrigger className="w-full" data-testid="stock-item">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {items.data?.items.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </label>
      {selectedItem && (
        <p className="text-sm text-muted-foreground" data-testid="stock-selling-price">
          {t("stockSellingPrice")}: <Amount value={selectedItem.sellingPrice} className="text-foreground" />
        </p>
      )}
      <div className="grid grid-cols-2 gap-3">
        <label className="grid gap-1">
          {t("stockQuantity")}
          <input
            className="rounded border px-3 py-2"
            name="stockDelta"
            autoComplete="off"
            value={delta}
            onChange={(e) => setDelta(e.target.value)}
            inputMode="numeric"
            required
            data-testid="stock-delta"
          />
        </label>
        <label className="grid gap-1">
          {t("stockUnitCost")}
          <input
            className="rounded border px-3 py-2"
            name="stockUnitCost"
            autoComplete="off"
            value={unitCost}
            onChange={(e) => setUnitCost(e.target.value)}
            inputMode="numeric"
            data-testid="stock-unit-cost"
          />
        </label>
      </div>
      <label className="grid gap-1">
        {t("stockReason")}
        <input className="rounded border px-3 py-2" name="stockReason" autoComplete="off" value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      {error && (
        <p className="text-sm text-destructive" role="alert" data-testid="stock-error">
          {error}
        </p>
      )}
      {done && adjust.isSuccess && (
        <p className="text-sm text-green-700" data-testid="stock-done">
          {t("stockAdded")}
        </p>
      )}
      <button className="rounded-lg bg-primary py-2 text-primary-foreground" type="submit" disabled={adjust.isPending} data-testid="stock-save">
        {t("stockAddBtn")}
      </button>
    </form>
  );
}

function kindLabel(t: (key: string) => string, kind: string): string {
  if (kind === "PURCHASE") return t("historyKind_PURCHASE");
  if (kind === "SALE") return t("historyKind_SALE");
  return t("historyKind_MANUAL_ADJUSTMENT");
}

/** Translate the locale-neutral reasons the returns feature stores on stock
 * movements (`RETURN_RECORDED`, `RETURN_REJECTED_DAMAGED <RTN>[ — <note>]`) and
 * the correction token (`INVOICE_CORRECTION <invoiceNumber> #<lineId>`).
 * Unknown/legacy reasons (opening, pre-token Arabic corrections) render raw.
 * The api stores keys; this view owns the copy. */
function movementReasonText(t: (key: string, vars?: Record<string, string>) => string, reason: string): string {
  if (reason === "RETURN_RECORDED") return t("historyReasonReturnRecorded");
  if (reason.startsWith("RETURN_REJECTED_DAMAGED")) {
    const rest = reason.slice("RETURN_REJECTED_DAMAGED".length).trim();
    return t("historyReasonReturnRejected", { context: rest });
  }
  if (reason.startsWith("INVOICE_CORRECTION")) {
    // the stored reason is "<token> <invoice> #<lineId>"; the line id is what
    // tells two corrections of the same item on one invoice apart, so it stays
    const [, number, line] = reason.split(" ");
    return t("historyReasonInvoiceCorrection", { number: number ?? "", line: line ?? "" });
  }
  return reason;
}

export function ItemHistoryPage() {
  const { t } = useTranslation();
  // SAFETY: the route only mounts this component with itemId set
  const { itemId } = useParams({ strict: false }) as { itemId: string };
  const history = useQuery(orpc.itemsHistory.queryOptions({ input: { itemId } }));

  return (
    <section>
      <Link to="/items" className="text-sm text-muted-foreground hover:text-foreground">
        ← {t("historyBack")}
      </Link>
      <h1 className="mt-2 text-xl font-bold">{t("historyTitle")}</h1>

      {history.isPending || !history.data ? (
        <div className="mt-4 grid gap-3 rounded border bg-card p-3">
          {[0, 1, 2].map((row) => (
            <Skeleton key={row} className="h-6 w-full" />
          ))}
        </div>
      ) : history.data.movements.length === 0 ? (
        <p className="mt-4 rounded border bg-card p-3 text-muted-foreground">{t("historyEmpty")}</p>
      ) : (
        <table className="mt-4 w-full rounded border bg-card" data-testid="history-table">
          <thead>
            <tr className="border-b text-right text-sm text-muted-foreground">
              <th className="p-3">{t("historyDate")}</th>
              <th className="p-3">{t("historyKind")}</th>
              <th className="p-3">{t("historyDelta")}</th>
              <th className="p-3">{t("stockUnitCost")}</th>
              <th className="p-3">{t("historyStockAfter")}</th>
            </tr>
          </thead>
          <tbody>
            {history.data.movements.map((movement) => (
              <tr key={movement.id} className="border-b last:border-0">
                <td className="p-3">{movement.occurredAt}</td>
                <td className="p-3">
                  {kindLabel(t, movement.kind)}
                  {movement.reason === "opening" && (
                    <span className="mr-2 text-xs text-muted-foreground">({t("historyOpening")})</span>
                  )}
                  {movement.reason !== null && movement.reason !== "opening" && (
                    <span className="mr-2 text-xs text-muted-foreground">({movementReasonText(t, movement.reason)})</span>
                  )}
                </td>
                <td className={`p-3 ${movement.delta > 0 ? "text-green-700" : "text-destructive"}`}>
                  {movement.delta > 0 ? `+${movement.delta}` : movement.delta}
                </td>
                <td className="p-3">{movement.unitCost ?? "—"}</td>
                <td className="p-3 font-semibold" data-testid="stock-after">
                  {movement.stockAfter}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}
