import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMutation } from "../lib/scoped-mutation";
import { Link, useParams } from "@tanstack/react-router";
import { Fragment, useEffect, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useTranslation } from "react-i18next";

import type { MovementKind } from "@dokan/contracts";

import { EntityPicker } from "@/components/entity-picker";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Amount } from "@/components/ui/amount";
import { EmptyState } from "@/components/ui/empty-state";

import { tError, type MessageKey, type Translate } from "../lib/i18n";
import { LEDGER_REFETCH_MS, hotCounterRefresh } from "../lib/freshness";
import { useRpc } from "../lib/rpc-context";
import { inputClass } from "@/components/ui/input";
import { usePagination } from "../hooks/use-pagination";
import { Pager } from "@/components/ui/pager";
import { draftBlank } from "@/lib/amount-parse";
import { parseSignedWholeNumber, parseWholeNumber } from "../lib/numeric-input";
import { formatDateTime } from "../lib/dates";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/**
 * Ticket 27 — manual add-stock form + item history (append-only ledger,
 * FIFO-derived remaining stock). Raw facts come from the api; stockAfter is
 * derived, never stored.
 */

export function StockForm() {
  const { orpc } = useRpc();
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const items = useQuery(orpc.itemsAll.queryOptions());
  const [itemId, setItemId] = useState("");
  const [delta, setDelta] = useState("");
  const [unitCost, setUnitCost] = useState("");
  const [sellingPrice, setSellingPrice] = useState("");
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
  const sellingPrefilledRef = useRef<{ itemId: string; price: string } | null>(null);
  const movementIdRef = useRef(crypto.randomUUID());
  const quantityRef = useRef<HTMLInputElement>(null);
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

  useEffect(() => {
    if (selectedItem === null) return;
    if (items.dataUpdatedAt < freshAfterRef.current) return;
    const nextPrice = String(selectedItem.sellingPrice);
    const previous = sellingPrefilledRef.current;
    const selectionChanged = previous === null || previous.itemId !== selectedItemId;
    const untouched = previous !== null && sellingPrice === previous.price;
    if (!selectionChanged && !(untouched && previous.price !== nextPrice)) return;
    sellingPrefilledRef.current = { itemId: selectedItemId, price: nextPrice };
    setSellingPrice(nextPrice);
  }, [selectedItemId, selectedItem, sellingPrice, items.dataUpdatedAt]);

  const adjust = useMutation(
    orpc.stockAddManual.mutationOptions({
      onSuccess: () => {
        setDelta("");
        setUnitCost("");
        setSellingPrice("");
        setReason("");
        setDone(true);
        // Blank is the new prefill, so edits made before the refresh survive it.
        prefilledRef.current = { itemId: selectedItemId, cost: "" };
        sellingPrefilledRef.current = { itemId: selectedItemId, price: "" };
        movementIdRef.current = crypto.randomUUID();
        freshAfterRef.current = Date.now();
        // the items table (paginated, so its key carries the page), the
        // low-stock badge, the item pickers (itemsAll) and the dashboard all
        // derive from the ledger; invalidate app-wide like the items page
        void queryClient.invalidateQueries();
      },
      onError: (err) => setError(tError(err.message)),
    }),
  );

  function startNewEntry() {
    movementIdRef.current = crypto.randomUUID();
    setDelta("");
    setUnitCost("");
    setSellingPrice("");
    setReason("");
    setError(null);
    setDone(false);
    prefilledRef.current = { itemId: selectedItemId, cost: "" };
    sellingPrefilledRef.current = { itemId: selectedItemId, price: "" };
    freshAfterRef.current = Date.now();
    adjust.reset();
    void queryClient.invalidateQueries();
    quantityRef.current?.focus();
  }

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
    // a removal cannot carry receipt prices; the api records only an outflow.
    const parsedUnitCost = parsedDelta > 0 ? parseWholeNumber(unitCost) : null;
    if (parsedDelta > 0 && !draftBlank(unitCost) && parsedUnitCost === null) {
      setError(t("stockUnitCostInvalid"));
      return;
    }
    const parsedSellingPrice = parsedDelta > 0 ? parseWholeNumber(sellingPrice) : null;
    if (parsedDelta > 0 && parsedSellingPrice === null) {
      setError(t("stockSellingPriceInvalid"));
      return;
    }
    void adjust.mutate({
      movementId: movementIdRef.current,
      itemId: selectedItemId,
      delta: parsedDelta,
      unitCost: parsedUnitCost === null ? undefined : parsedUnitCost,
      sellingPrice: parsedSellingPrice === null ? undefined : parsedSellingPrice,
      reason: reason === "" ? undefined : reason,
    });
  }

  return (
    <form className="mt-4 grid gap-3 rounded border bg-card p-4" onSubmit={submit} data-testid="stock-form">
      <h2 className="font-semibold">{t("stockAddTitle")}</h2>
      <EntityPicker
        label={t("stockItem")}
        options={items.data?.items ?? []}
        value={selectedItemId}
        onChange={setItemId}
        testId="stock-item"
        noMatchesLabel={t("itemsSearchEmpty")}
      />
      <label className="grid gap-1">
        {t("stockCurrentSellingPrice")}
        <input
          className={inputClass}
          name="stockSellingPrice"
          autoComplete="off"
          value={sellingPrice}
          onChange={(e) => setSellingPrice(e.target.value)}
          inputMode="numeric"
          disabled={isRemoval}
          data-testid="stock-selling-price"
        />
      </label>
      <div className="grid grid-cols-2 gap-3">
        <label className="grid gap-1">
          {t("stockQuantity")}
          <input
            className={inputClass}
            name="stockDelta"
            ref={quantityRef}
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
      {adjust.error?.message === "STOCK_ADJUSTMENT_DUPLICATE" && (
        <Button type="button" variant="outline" onClick={startNewEntry} disabled={adjust.isPending} data-testid="stock-new-entry">
          {t("stockNewEntry")}
        </Button>
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

/**
 * The copy for one movement kind, exhaustive over the contract's kinds
 * (issue #331).
 *
 * `movementKinds` is the source of truth, so a kind added to the contract
 * leaves this table missing a property and `bun run typecheck` fails HERE —
 * at the table — instead of the screen quietly labelling the new kind as an
 * adjustment. The if-chain this replaces had no such edge: it fell through to
 * the adjustment copy for every kind it did not name, so a fourth kind
 * rendered the adjustment copy with no error and no test.
 */
export const HISTORY_KIND_KEYS = {
  PURCHASE: "historyKind_PURCHASE",
  SALE: "historyKind_SALE",
  MANUAL_ADJUSTMENT: "historyKind_MANUAL_ADJUSTMENT",
} satisfies Record<MovementKind, MessageKey>;

/**
 * The label for a movement kind.
 *
 * The table covers every kind the contract declares, and the api validates the
 * history output against that contract, so a kind outside the table cannot
 * reach this view.
 */
export function kindLabel(t: Translate, kind: MovementKind): string {
  return t(HISTORY_KIND_KEYS[kind]);
}

/** Translate the locale-neutral reasons the returns feature stores on stock
 * movements (`RETURN_RECORDED`, `RETURN_REJECTED_DAMAGED <RTN>[ — <note>]`) and
 * the correction token (`INVOICE_CORRECTION <invoiceNumber> #<lineId>`).
 * Unknown/legacy reasons (opening, pre-token Arabic corrections) render raw.
 * The api stores keys; this view owns the copy. */
export function movementReasonText(t: Translate, reason: string): string {
  if (reason === "COST_CORRECTION") return t("historyReasonCostCorrection");
  if (reason === "RETURN_RECORDED") return t("historyReasonReturnRecorded");
  if (reason.startsWith("RETURN_REJECTED_DAMAGED")) {
    const rest = reason.slice("RETURN_REJECTED_DAMAGED".length).trim();
    // `note`, not `context`: `context` is one of i18next's own options, so the call
    // was looking up a `historyReasonReturnRejected_<note>` variant that does not
    // exist and only rendered correctly because the copy's placeholder happened to
    // be named `{{context}}` too. The compiler does NOT catch this — the narrow
    // translator takes any variable name, so `{ context: rest }` typechecks here
    // exactly as it did before #322, and i18next's `TOptionsBase` declares
    // `context?: unknown`, so the library's own option list accepted it too. It
    // was found by reading the option list, not by the type system;
    // stock.test.tsx pins the option/copy pairing at run time instead.
    return t("historyReasonReturnRejected", { note: rest });
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

function HistoryAmount({ value }: { value: number | null | undefined }) {
  const { t } = useTranslation();
  return value == null ? <>{t("historyUnavailable")}</> : <Amount value={value} />;
}

export function ItemHistoryPage({ refreshMs = LEDGER_REFETCH_MS }: { refreshMs?: number } = {}) {
  const { orpc } = useRpc();
  const { t } = useTranslation();
  // SAFETY: the route only mounts this component with itemId set
  const { itemId } = useParams({ strict: false }) as { itemId: string };
  const pager = usePagination();
  const [expandedMovementIds, setExpandedMovementIds] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    pager.reset();
    setExpandedMovementIds(new Set());
  }, [itemId]);
  const history = useQuery({
    ...orpc.itemsHistory.queryOptions({ input: { itemId, ...pager.pagination } }),
    // #295 — the running stock column on this screen is a hot counter too: a
    // sale or an adjustment posted in another window has to show up here
    // without the owner reloading the page. The ledger read is slower than
    // the counters' (see LEDGER_REFETCH_MS). `refreshMs` is injectable so a
    // test can run the same wiring on a fast clock
    ...hotCounterRefresh(refreshMs),
  });
  // rows the date-ordered list draws below a correction that was recorded after
  // them (issue 151): a future-dated purchase the owner would otherwise read as
  // one that never moved the average
  const superseded = history.data === undefined ? new Set<number>() : supersededByCorrection(history.data.movements);

  function toggleMovementDetails(movementId: string) {
    setExpandedMovementIds((current) => {
      const next = new Set(current);
      if (next.has(movementId)) next.delete(movementId);
      else next.add(movementId);
      return next;
    });
  }

  return (
    <section>
      <nav
        aria-label={t("historyBreadcrumb")}
        className="mb-3 flex min-w-0 items-center gap-2 rounded-md border bg-muted/30 px-3 py-2 text-sm"
      >
        <Link
          to="/items"
          className="inline-flex min-h-8 shrink-0 items-center rounded px-2 text-primary hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {t("navItems")}
        </Link>
        <span aria-hidden="true" className="text-muted-foreground">/</span>
        <span aria-current="page" className="min-w-0 truncate font-medium text-foreground">
          <bdi>{history.data?.item?.name ?? t("historyTitle")}</bdi>
        </span>
      </nav>
      <h1 className="break-words text-xl font-bold">
        <bdi>{history.data?.item?.name ?? t("historyTitle")}</bdi>
      </h1>
      {history.data?.item && <p className="mt-1 text-sm text-muted-foreground">{t("historyTitle")}</p>}
      {history.isPending && (
        <p role="status" aria-live="polite" className="sr-only">{t("historyLoading")}</p>
      )}
      {history.isError && (
        <div role="alert" className="mt-4 rounded border border-destructive p-3">
          <p>{t("historyLoadError")}</p>
          <Button variant="outline" className="mt-2" onClick={() => void history.refetch()}>{t("itemsSearchRetry")}</Button>
        </div>
      )}

      {history.isPending ? (
        <div
          className="mt-4 space-y-3"
          data-testid="history-loading"
          aria-hidden="true"
        >
          <div className="flex min-h-12 items-center rounded border bg-card px-3">
            <Skeleton className="h-5 w-48 max-w-full motion-reduce:animate-none" />
          </div>
          <div className="overflow-hidden rounded border bg-card">
            <table className="w-full min-w-[40rem] text-sm" aria-hidden="true">
              <thead>
                <tr className="border-b">
                  <th className="h-10 px-3 text-start"><Skeleton className="h-3 w-20 motion-reduce:animate-none" /></th>
                  <th className="h-10 px-3 text-start"><Skeleton className="h-3 w-24 motion-reduce:animate-none" /></th>
                  <th className="h-10 px-3 text-start"><Skeleton className="h-3 w-14 motion-reduce:animate-none" /></th>
                  <th className="h-10 px-3 text-start"><Skeleton className="h-3 w-20 motion-reduce:animate-none" /></th>
                  <th className="h-10 px-3 text-start"><Skeleton className="h-3 w-20 motion-reduce:animate-none" /></th>
                </tr>
              </thead>
              <tbody>
                {[0, 1, 2].map((row) => (
                  <tr key={row} className="h-12 border-b last:border-0">
                    <td className="px-3"><Skeleton className="h-4 w-24 motion-reduce:animate-none" /></td>
                    <td className="px-3"><Skeleton className="h-4 w-20 motion-reduce:animate-none" /></td>
                    <td className="px-3"><Skeleton className="h-4 w-12 motion-reduce:animate-none" /></td>
                    <td className="px-3"><Skeleton className="h-4 w-24 motion-reduce:animate-none" /></td>
                    <td className="px-3"><Skeleton className="h-4 w-10 motion-reduce:animate-none" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : !history.data ? null : history.data.total === 0 ? (
        <EmptyState
          testId="history-empty"
          card
          className="mt-4"
          title={t("historyEmpty")}
          hint={t("historyEmptyHint")}
        />
      ) : (
        <>
        <Table className="mt-4 min-w-[40rem] rounded border bg-card text-sm" data-testid="history-table">
          <TableHeader>
            <TableRow className="text-right text-muted-foreground">
              <TableHead scope="col" className="p-3">{t("historyDate")}</TableHead>
              <TableHead scope="col" className="p-3">{t("historyKind")}</TableHead>
              <TableHead scope="col" className="p-3">{t("historyDelta")}</TableHead>
              <TableHead scope="col" className="p-3">{t("historyDetails")}</TableHead>
              <TableHead scope="col" className="p-3">{t("historyStockAfter")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {history.data.movements.map((movement, index) => {
              const expanded = expandedMovementIds.has(movement.id);
              const detailId = `history-detail-${movement.id}`;
              return (
                <Fragment key={movement.id}>
                  <TableRow aria-expanded={expanded} data-testid={`history-movement-row-${movement.id}`}>
                    <TableCell className="p-3">{formatDateTime(movement.occurredAt)}</TableCell>
                    <TableCell className="p-3 whitespace-normal">
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
                    </TableCell>
                    <TableCell
                      className="p-3 data-[delta-state=inflow]:text-success data-[delta-state=outflow]:text-destructive data-[delta-state=neutral]:text-muted-foreground"
                      data-delta-state={movement.delta > 0 ? "inflow" : movement.delta < 0 ? "outflow" : "neutral"}
                    >
                      <bdi dir="ltr">{movement.delta > 0 ? `+${movement.delta}` : movement.delta}</bdi>
                    </TableCell>
                    <TableCell className="p-3">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-expanded={expanded}
                        aria-controls={detailId}
                        data-testid={`history-toggle-${movement.id}`}
                        onClick={() => toggleMovementDetails(movement.id)}
                      >
                        {t(expanded ? "historyHideDetails" : "historyShowDetails")}
                        <ChevronDown aria-hidden="true" className={`transition-transform ${expanded ? "rotate-180" : ""}`} />
                      </Button>
                    </TableCell>
                    <TableCell className="p-3 font-semibold" data-testid="stock-after" data-movement-id={movement.id}>
                      {movement.stockAfter}
                    </TableCell>
                  </TableRow>
                  <TableRow hidden={!expanded} data-testid={`history-detail-row-${movement.id}`}>
                    <TableCell colSpan={5} className="whitespace-normal bg-muted/30 p-4 align-top">
                      <div id={detailId} data-testid={`history-detail-${movement.id}`} className="w-full max-w-[min(56rem,calc(100vw-10rem))] space-y-3">
                        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                          <section className="min-w-0">
                            <div className="mb-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                              <h3 className="text-xs font-semibold text-muted-foreground">{t("historyAmounts")}</h3>
                              <details data-testid="history-facts-help" className="min-w-0 text-xs text-muted-foreground">
                                <summary className="min-h-8 cursor-pointer rounded px-1 py-1 text-primary underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
                                  {t("historyFactsHelpLabel")}
                                </summary>
                                <p className="mt-1 max-w-prose leading-relaxed">{t("historyFactsHint")}</p>
                              </details>
                            </div>
                            <dl className="space-y-2 text-sm">
                              <div data-testid={`history-fact-selling-price-${movement.id}`} className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-1">
                                <dt className="min-w-0 break-words text-right text-xs text-muted-foreground">{t("stockSellingPrice")}</dt>
                                <dd data-testid={`history-selling-price-${movement.id}`} className="shrink-0 text-left">
                                  {movement.details?.sellingPrice == null ? t("historyUnavailable") : <Amount value={movement.details.sellingPrice} />}
                                </dd>
                              </div>
                              <div data-testid={`history-fact-unit-cost-${movement.id}`} className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-1">
                                <dt className="min-w-0 break-words text-right text-xs text-muted-foreground">{t("stockUnitCost")}</dt>
                                <dd className="shrink-0 text-left">
                                  {movement.details?.cost?.costPending ? t("historyCostPending") : <HistoryAmount value={movement.details === undefined ? movement.unitCost : movement.details.cost?.unitCost} />}
                                </dd>
                              </div>
                              <div data-testid={`history-fact-sale-total-${movement.id}`} className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-1">
                                <dt className="min-w-0 break-words text-right text-xs text-muted-foreground">{t("historySaleTotal")}</dt>
                                <dd data-testid={`history-sale-total-${movement.id}`} className="shrink-0 text-left">
                                  {movement.details?.saleTotal == null ? t("historyUnavailable") : <Amount value={movement.details.saleTotal} />}
                                </dd>
                              </div>
                              <div data-testid={`history-fact-net-sale-total-${movement.id}`} className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-1">
                                <dt className="min-w-0 break-words text-right text-xs text-muted-foreground">{t("historyNetSaleTotal")}</dt>
                                <dd className="shrink-0 text-left">
                                  {movement.details?.netSaleTotal == null ? t("historyUnavailable") : <Amount value={movement.details.netSaleTotal} />}
                                </dd>
                              </div>
                              <div data-testid={`history-fact-cost-total-${movement.id}`} className="flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-1">
                                <dt className="min-w-0 break-words text-right text-xs text-muted-foreground">{t("historyCostTotal")}</dt>
                                <dd data-testid={`history-cost-total-${movement.id}`} className="shrink-0 text-left">
                                  {movement.details?.cost?.total == null ? t("historyUnavailable") : <Amount value={movement.details.cost.total} />}
                                </dd>
                              </div>
                            </dl>
                          </section>
                          <div className="space-y-3">
                            <dl className="text-sm">
                              <dt className="text-xs text-muted-foreground">{t("historyRecordedAt")}</dt>
                              <dd className="break-words">{formatDateTime(movement.createdAt)}</dd>
                            </dl>
                            {movement.details?.documents.length ? (
                              <div>
                                <p className="mb-1 text-xs text-muted-foreground">{t("historyDocuments")}</p>
                                <div className="flex flex-wrap gap-x-4 gap-y-1">
                                  {movement.details.documents.map((document) => (
                                    <Link
                                      key={document.id}
                                      to="/invoices/$invoiceId"
                                      params={{ invoiceId: document.id }}
                                      className="inline-flex min-h-7 max-w-full items-center break-all text-sm text-primary underline underline-offset-4 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                                      data-testid={`history-document-${movement.id}`}
                                    >
                                      <bdi dir="ltr">{document.number}</bdi>
                                    </Link>
                                  ))}
                                </div>
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </TableCell>
                  </TableRow>
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
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
