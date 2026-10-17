import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useParams } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Amount } from "@/components/ui/amount";
import { EmptyState } from "@/components/ui/empty-state";

import { tError } from "../lib/i18n";
import { orpc } from "../lib/rpc";
import { inputClass } from "@/components/ui/input";
import { usePagination } from "../hooks/use-pagination";
import { Pager } from "@/components/ui/pager";
import { parseSignedWholeNumber, parseWholeNumber } from "../lib/numeric-input";
import { formatDateTime } from "../lib/dates";

/**
 * Ticket 27 — manual add-stock form + item history (append-only ledger,
 * FIFO-derived remaining stock). Raw facts come from the api; stockAfter is
 * derived, never stored.
 */

export function StockForm() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const items = useQuery(orpc.itemsAll.queryOptions());
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
  // a negative movement takes stock out; the api records a unit cost only for
  // stock in, so the field must not look editable on a removal
  const deltaValue = parseSignedWholeNumber(delta);
  const isRemoval = deltaValue !== null && deltaValue < 0;

  // Mirror the item's last known unit cost into the cost field. The guard
  // tracks the value we last prefilled: a background refetch (after a movement
  // or a cost correction elsewhere) refreshes the field only while it still
  // holds that prefilled value, so a value the operator typed is never
  // overwritten.
  const prefilledRef = useRef<{ itemId: string; cost: string } | null>(null);
  /** a movement invalidates the list; the cached cost is stale until the
   * refetch that follows it lands */
  const freshAfterRef = useRef(0);
  useEffect(() => {
    if (selectedItem === null) return;
    // React Query keeps serving the pre-movement list during the refetch, so
    // prefilling from it would record the old average cost on a second
    // movement submitted in that window
    if (items.dataUpdatedAt < freshAfterRef.current) return;
    const nextCost = String(selectedItem.costPrice);
    const previous = prefilledRef.current;
    const selectionChanged = previous === null || previous.itemId !== selectedItemId;
    const untouched = previous !== null && unitCost === previous.cost;
    if (!selectionChanged && !(untouched && previous.cost !== nextCost)) return;
    prefilledRef.current = { itemId: selectedItemId, cost: nextCost };
    setUnitCost(nextCost);
  }, [selectedItemId, selectedItem, unitCost, items.dataUpdatedAt]);

  const adjust = useMutation(
    orpc.stockAddManual.mutationOptions({
      onSuccess: () => {
        setDelta("");
        setUnitCost("");
        setReason("");
        setDone(true);
        // let the next refetch re-prefill the (possibly changed) average cost
        prefilledRef.current = null;
        freshAfterRef.current = Date.now();
        // the items table (paginated, so its key carries the page), the
        // low-stock badge, the item pickers (itemsAll) and the dashboard all
        // derive from the ledger; invalidate app-wide like the items page
        void queryClient.invalidateQueries();
      },
      onError: (err) => setError(tError(err.message)),
    }),
  );

  function submit(event: React.FormEvent) {
    event.preventDefault();
    setError(null);
    setDone(false);
    // trim before parsing: a whitespace-only numeric field is blank, never 0
    const parsedDelta = parseSignedWholeNumber(delta);
    if (!selectedItemId) {
      setError(t("itemsEmpty"));
      return;
    }
    if (parsedDelta === null || parsedDelta === 0) {
      setError(t("stockQuantityInvalid"));
      return;
    }
    // a removal cannot carry a unit cost: the api takes one only for stock in
    const parsedUnitCost = parsedDelta > 0 ? parseWholeNumber(unitCost) : null;
    if (parsedDelta > 0 && unitCost.trim() !== "" && parsedUnitCost === null) {
      setError(t("stockUnitCostInvalid"));
      return;
    }
    void adjust.mutate({
      itemId: selectedItemId,
      delta: parsedDelta,
      unitCost: parsedUnitCost === null ? undefined : parsedUnitCost,
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
            className={inputClass}
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
            className={inputClass}
            name="stockUnitCost"
            autoComplete="off"
            value={unitCost}
            onChange={(e) => setUnitCost(e.target.value)}
            inputMode="numeric"
            disabled={isRemoval}
            aria-describedby={isRemoval ? "stock-removal-hint" : undefined}
            data-testid="stock-unit-cost"
          />
          {isRemoval && (
            <span id="stock-removal-hint" className="text-xs text-muted-foreground">
              {t("stockRemovalNoCost")}
            </span>
          )}
        </label>
      </div>
      <label className="grid gap-1">
        {t("stockReason")}
        <input className={inputClass} name="stockReason" autoComplete="off" value={reason} onChange={(e) => setReason(e.target.value)} />
      </label>
      {error && (
        <p className="text-sm text-destructive" role="alert" data-testid="stock-error">
          {error}
        </p>
      )}
      {done && adjust.isSuccess && (
        <p className="text-sm text-success" data-testid="stock-done">
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
export function movementReasonText(t: (key: string, vars?: Record<string, string>) => string, reason: string): string {
  if (reason === "COST_CORRECTION") return t("historyReasonCostCorrection");
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

/** Delta-cell styling: inflows are gains, outflows losses, and a zero-delta
 * event (a cost correction) is neutral — never styled as stock removed. */
export function movementDeltaClass(delta: number): string {
  if (delta > 0) return "text-success";
  if (delta < 0) return "text-destructive";
  return "text-muted-foreground";
}

/** The fields the precedence check reads off a history row. */
export interface PrecedenceRow {
  delta: number;
  unitCost: number | null;
  reason: string | null;
  createdAt: string;
  /** store rowid: the ledger's recording order. Absent on a response cached
   * before issue 215. */
  seq?: number;
  /** recording order of the correction the api resolved over the WHOLE ledger
   * as superseding this row (issue 215). `null` = not superseded; `undefined`
   * = the api did not annotate the response. */
  supersededBySeq?: number | null;
}

function isCostCorrection(row: PrecedenceRow): boolean {
  return row.delta === 0 && row.unitCost !== null && row.reason === "COST_CORRECTION";
}

/** Whether `above` was recorded after `row`: the store rowid when both carry
 * it, else the fixed-width wall-clock insert time. */
function recordedAfter(above: PrecedenceRow, row: PrecedenceRow): boolean {
  if (above.seq !== undefined && row.seq !== undefined) return above.seq > row.seq;
  return above.createdAt > row.createdAt;
}

/**
 * Indices of inflow rows the date-ordered history draws *below* a cost
 * correction that was recorded after them.
 *
 * Replay walks the ledger in recording order and splits it at each correction,
 * so such a row's contribution to the weighted average was replaced by the
 * correction even though the row is drawn after it. The view badges those rows
 * so a future-dated purchase is not misread as one that never moved the
 * average. Only inflows (`delta > 0`) can move the average, so outflows and the
 * correction rows themselves are never flagged.
 *
 * Issue 215: the api resolves this over the WHOLE ledger and annotates each row
 * with `supersededBySeq`, so a correction on a prior page still badges its
 * superseded row on a later one and a same-second tie is ordered by `seq`. When
 * the annotation is present it is the answer; only a response cached before
 * issue 215 falls back to the page-local recording-order comparison of issue
 * 151 (which prefers `seq` when the page carries it, else `createdAt`). A page
 * that carries the annotation on only some rows is treated as fully annotated:
 * a partial payload under-annotates rather than mixing the two rules, and so
 * never over-annotates (issue 151's rule).
 */
export function supersededByCorrection(rows: readonly PrecedenceRow[]): Set<number> {
  if (rows.some((row) => row.supersededBySeq !== undefined)) {
    const superseded = new Set<number>();
    rows.forEach((row, index) => {
      // only inflows move the average: even an anomalous annotation never
      // badges an outflow (issue 151 invariant, kept on both sides)
      if (row.delta > 0 && row.supersededBySeq !== null && row.supersededBySeq !== undefined) {
        superseded.add(index);
      }
    });
    return superseded;
  }
  return pageLocalSupersededByCorrection(rows);
}

/** Legacy page-local fallback for a response fetched before issue 215. */
function pageLocalSupersededByCorrection(rows: readonly PrecedenceRow[]): Set<number> {
  const superseded = new Set<number>();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row === undefined || row.delta <= 0) continue;
    // the nearest correction drawn above the row that was recorded after it
    for (let j = i - 1; j >= 0; j--) {
      const above = rows[j];
      if (above !== undefined && isCostCorrection(above) && recordedAfter(above, row)) {
        superseded.add(i);
        break;
      }
    }
  }
  return superseded;
}

export function ItemHistoryPage() {
  const { t } = useTranslation();
  // SAFETY: the route only mounts this component with itemId set
  const { itemId } = useParams({ strict: false }) as { itemId: string };
  const pager = usePagination();
  const history = useQuery(orpc.itemsHistory.queryOptions({ input: { itemId, ...pager.pagination } }));
  // rows the date-ordered list draws below a correction that was recorded after
  // them (issue 151): a future-dated purchase the owner would otherwise read as
  // one that never moved the average
  const superseded = history.data === undefined ? new Set<number>() : supersededByCorrection(history.data.movements);

  return (
    <section>
      <Button asChild variant="outline" size="sm">
        <Link to="/items">
          {/* RTL: back points right, and the arrow leads the label on its right */}
          <ArrowRight size={16} aria-hidden="true" />
          {t("historyBack")}
        </Link>
      </Button>
      <h1 className="mt-2 text-xl font-bold">{t("historyTitle")}</h1>

      {history.isPending || !history.data ? (
        <div className="mt-4 grid gap-3 rounded border bg-card p-3">
          {[0, 1, 2].map((row) => (
            <Skeleton key={row} className="h-6 w-full" />
          ))}
        </div>
      ) : history.data.total === 0 ? (
        <EmptyState
          testId="history-empty"
          card
          className="mt-4"
          title={t("historyEmpty")}
          hint={t("historyEmptyHint")}
        />
      ) : (
        <>
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
            {history.data.movements.map((movement, index) => (
              <tr key={movement.id} className="border-b last:border-0">
                <td className="p-3">{formatDateTime(movement.occurredAt)}</td>
                <td className="p-3">
                  {kindLabel(t, movement.kind)}
                  {movement.reason === "opening" && (
                    <span className="mr-2 text-xs text-muted-foreground">({t("historyOpening")})</span>
                  )}
                  {movement.reason !== null && movement.reason !== "opening" && (
                    <span className="mr-2 text-xs text-muted-foreground">({movementReasonText(t, movement.reason)})</span>
                  )}
                  {superseded.has(index) && (
                    <span
                      className="mr-2 rounded bg-warning px-2 py-0.5 text-xs text-warning-foreground"
                      data-testid="history-superseded"
                    >
                      {t("historySupersededByCorrection")}
                    </span>
                  )}
                </td>
                <td className={`p-3 ${movementDeltaClass(movement.delta)}`}>
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
        <Pager
          total={history.data.total}
          pageSize={pager.pageSize}
          offset={pager.offset}
          onOffsetChange={pager.setOffset}
          onPageSizeChange={pager.setPageSize}
          testId="history-pager"
        />
        </>
      )}
    </section>
  );
}
