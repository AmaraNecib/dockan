import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import type { Item } from "@dokan/contracts";

import { ItemPickerDialog } from "@/components/catalog/item-picker-dialog";
import { InvoiceHeader } from "@/components/invoice-header";

import { tError } from "../lib/i18n";
import { orpc } from "../lib/rpc";

/**
 * Ticket 29 — purchase intake (/purchase): multi-line PURCHASE invoices with
 * an inline quick-add, then the deferred-linking proposal panel that attributes
 * earlier uninvoiced stock (stock_links) to the saved invoice.
 */

type DraftLine = { item: Item; quantity: number; unitCost: number };

export function PurchasePage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const categories = useQuery(orpc.categoriesList.queryOptions());

  const [pickerOpen, setPickerOpen] = useState(false);
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [supplier, setSupplier] = useState("");
  const [notes, setNotes] = useState("");
  const [paidNow, setPaidNow] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [savedInvoice, setSavedInvoice] = useState<{ id: string; invoiceNumber: string } | null>(null);

  // quick-add mini-form state: item fields + the line it lands as
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickName, setQuickName] = useState("");
  const [quickBarcode, setQuickBarcode] = useState("");
  const [quickCategoryId, setQuickCategoryId] = useState("");
  const [quickSellPrice, setQuickSellPrice] = useState("");
  const [quickThreshold, setQuickThreshold] = useState("");
  const [quickQty, setQuickQty] = useState("1");
  const [quickUnitCost, setQuickUnitCost] = useState("");

  const addLine = (item: Item) => {
    setLines((current) => {
      const existing = current.find((line) => line.item.id === item.id);
      if (existing) {
        return current.map((line) => (line.item.id === item.id ? { ...line, quantity: line.quantity + 1 } : line));
      }
      return [...current, { item, quantity: 1, unitCost: item.costPrice }];
    });
    setPickerOpen(false);
  };

  const createItem = useMutation(orpc.itemsCreate.mutationOptions());

  const createInvoice = useMutation(
    orpc.invoicesCreate.mutationOptions({
      onSuccess: (invoice) => {
        setSavedInvoice({ id: invoice.id, invoiceNumber: invoice.invoiceNumber });
        setLines([]);
        setSupplier("");
        setNotes("");
        setPaidNow("");
        void queryClient.invalidateQueries({ queryKey: orpc.itemsList.queryKey() });
      },
      onError: (err) => setError(tError(err.message)),
    }),
  );

  const total = lines.reduce((sum, line) => sum + line.quantity * line.unitCost, 0);

  function submit() {
    setError(null);
    if (lines.length === 0) {
      setError(t("purchasesLinesEmpty"));
      return;
    }
    void createInvoice.mutate({
      kind: "PURCHASE",
      counterpartyName: supplier.trim() === "" ? undefined : supplier.trim(),
      notes: notes.trim() === "" ? undefined : notes.trim(),
      initialPaid: paidNow === "" ? undefined : Number(paidNow),
      lines: lines.map((line) => ({ itemId: line.item.id, quantity: line.quantity, unitPrice: line.unitCost })),
    });
  }

  function quickSubmit() {
    setError(null);
    if (quickCategoryId === "") {
      setError(t("itemsChooseCategory"));
      return;
    }
    const qty = Number(quickQty);
    const unitCost = Number(quickUnitCost);
    if (!Number.isInteger(qty) || qty < 1) {
      setError(t("purchasesInvalidQuantity"));
      return;
    }
    if (!Number.isInteger(unitCost) || unitCost <= 0) {
      setError(t("purchasesInvalidCost"));
      return;
    }
    void createItem.mutate(
      {
        name: quickName,
        categoryId: quickCategoryId,
        costPrice: unitCost,
        sellingPrice: quickSellPrice === "" ? unitCost : Number(quickSellPrice),
        lowStockThreshold: quickThreshold === "" ? undefined : Number(quickThreshold),
        barcode: quickBarcode.trim() === "" ? undefined : quickBarcode.trim(),
      },
      {
        // straight back to the line: the purchase line itself is the stock
        // event, so the freshly created item lands as a line immediately
        onSuccess: (item) => {
          setLines((current) => [...current.filter((line) => line.item.id !== item.id), { item, quantity: qty, unitCost }]);
          setQuickOpen(false);
          setQuickName("");
          setQuickBarcode("");
          setQuickSellPrice("");
          setQuickThreshold("");
          setQuickQty("1");
          setQuickUnitCost("");
        },
        onError: (err) => setError(tError(err.message)),
      },
    );
  }

  return (
    <section>
      <h1 className="text-xl font-bold">{t("purchasesTitle")}</h1>

      {savedInvoice && (
        <div className="mt-4 rounded border bg-white p-4" data-testid="purchase-saved">
          <InvoiceHeader />
          <p className="mt-2 font-semibold text-green-700" data-testid="purchase-saved-number">
            {t("purchasesSaved", { number: savedInvoice.invoiceNumber })}
          </p>
          <LinkProposalPanel invoiceId={savedInvoice.id} />
          <button type="button" className="mt-3 rounded border px-3 py-1 text-sm" onClick={() => setSavedInvoice(null)}>
            {t("purchasesNewInvoice")}
          </button>
        </div>
      )}

      {!savedInvoice && (
        <div className="mt-4 grid gap-4" data-testid="purchase-form">
          <div className="grid gap-3 rounded border bg-white p-4">
            <label className="grid gap-1">
              {t("purchasesSupplier")}
              <input className="rounded border px-3 py-2" value={supplier} onChange={(e) => setSupplier(e.target.value)} data-testid="purchase-supplier" />
            </label>
            <div className="grid grid-cols-2 gap-3">
              <label className="grid gap-1">
                {t("purchasesNotes")}
                <input className="rounded border px-3 py-2" value={notes} onChange={(e) => setNotes(e.target.value)} />
              </label>
              <label className="grid gap-1">
                {t("purchasesPaidNow")}
                <input className="rounded border px-3 py-2" value={paidNow} onChange={(e) => setPaidNow(e.target.value)} inputMode="numeric" data-testid="purchase-paid" />
              </label>
            </div>
          </div>

          <div className="grid gap-3 rounded border bg-white p-4">
            <div className="flex items-center justify-between">
              <h2 className="font-semibold">{t("purchasesLinesTitle")}</h2>
              <div className="flex gap-2">
                <button type="button" className="rounded-lg bg-stone-900 px-3 py-1.5 text-sm text-white" onClick={() => setPickerOpen(true)} data-testid="purchase-open-picker">
                  {t("purchasesAddItem")}
                </button>
                <button type="button" className="rounded border px-3 py-1.5 text-sm" onClick={() => setQuickOpen((open) => !open)} data-testid="purchase-toggle-quick">
                  {t("purchasesQuickAddBtn")}
                </button>
              </div>
            </div>

            {quickOpen && (
              <form
                className="grid gap-3 rounded border bg-stone-50 p-3"
                // SAFETY: preventDefault keeps the SPA from native-posting;
                // stopPropagation keeps the event away from any wrapper form
                onSubmit={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  quickSubmit();
                }} data-testid="purchase-quick-form">
                <div className="grid grid-cols-2 gap-3">
                  <label className="grid gap-1">
                    {t("purchasesQuickName")}
                    <input className="rounded border px-3 py-2" required value={quickName} onChange={(e) => setQuickName(e.target.value)} data-testid="quick-name" />
                  </label>
                  <label className="grid gap-1">
                    {t("purchasesQuickBarcode")}
                    <input className="rounded border px-3 py-2" dir="ltr" value={quickBarcode} onChange={(e) => setQuickBarcode(e.target.value)} />
                  </label>
                  <label className="grid gap-1">
                    {t("purchasesQuickCategory")}
                    <select className="rounded border px-3 py-2" value={quickCategoryId} onChange={(e) => setQuickCategoryId(e.target.value)}>
                      <option value="">—</option>
                      {categories.data?.items.map((category) => (
                        <option key={category.id} value={category.id}>
                          {category.name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="grid gap-1">
                    {t("itemsSell")}
                    <input className="rounded border px-3 py-2" inputMode="numeric" value={quickSellPrice} onChange={(e) => setQuickSellPrice(e.target.value)} />
                  </label>
                  <label className="grid gap-1">
                    {t("itemsThreshold")}
                    <input className="rounded border px-3 py-2" inputMode="numeric" value={quickThreshold} onChange={(e) => setQuickThreshold(e.target.value)} />
                  </label>
                  <label className="grid gap-1">
                    {t("purchasesLineQty")}
                    <input className="rounded border px-3 py-2" required inputMode="numeric" value={quickQty} onChange={(e) => setQuickQty(e.target.value)} data-testid="quick-qty" />
                  </label>
                  <label className="grid gap-1">
                    {t("purchasesLineCost")}
                    <input className="rounded border px-3 py-2" required inputMode="numeric" value={quickUnitCost} onChange={(e) => setQuickUnitCost(e.target.value)} data-testid="quick-cost" />
                  </label>
                </div>
                <button className="rounded-lg bg-stone-900 py-2 text-white" type="submit" disabled={createItem.isPending}>
                  {t("purchasesQuickAddBtn")}
                </button>
              </form>
            )}

            {lines.length === 0 ? (
              <p className="text-sm text-stone-500">{t("purchasesLinesEmpty")}</p>
            ) : (
              <table className="w-full" data-testid="purchase-lines">
                <thead>
                  <tr className="border-b text-right text-sm text-stone-500">
                    <th className="p-2">{t("itemsName")}</th>
                    <th className="p-2">{t("purchasesLineQty")}</th>
                    <th className="p-2">{t("purchasesLineCost")}</th>
                    <th className="p-2">{t("purchasesTotal")}</th>
                    <th className="p-2"></th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line, index) => (
                    <tr key={line.item.id} className="border-b last:border-0">
                      <td className="p-2">{line.item.name}</td>
                      <td className="p-2">
                        <input
                          className="w-16 rounded border px-2 py-1"
                          inputMode="numeric"
                          value={String(line.quantity)}
                          onChange={(e) => {
                            const parsed = Number(e.target.value);
                            if (Number.isInteger(parsed) && parsed >= 1) {
                              setLines((current) => current.map((l, i) => (i === index ? { ...l, quantity: parsed } : l)));
                            }
                          }}
                          aria-label={`${line.item.name}: ${t("purchasesLineQty")}`}
                        />
                      </td>
                      <td className="p-2">
                        <input
                          className="w-20 rounded border px-2 py-1"
                          inputMode="numeric"
                          value={String(line.unitCost)}
                          onChange={(e) => {
                            const parsed = Number(e.target.value);
                            if (Number.isInteger(parsed) && parsed >= 0) {
                              setLines((current) => current.map((l, i) => (i === index ? { ...l, unitCost: parsed } : l)));
                            }
                          }}
                          aria-label={`${line.item.name}: ${t("purchasesLineCost")}`}
                        />
                      </td>
                      <td className="p-2">{line.quantity * line.unitCost}</td>
                      <td className="p-2">
                        <button type="button" className="text-red-600" onClick={() => setLines((current) => current.filter((_, i) => i !== index))}>
                          ✕
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="text-left font-semibold" data-testid="purchase-total">
              {t("purchasesTotal")}: {total} دج
            </p>
          </div>

          {error && (
            <p className="text-sm text-red-600" data-testid="purchase-error">
              {error}
            </p>
          )}
          <button className="rounded-lg bg-stone-900 py-2 text-white" type="button" onClick={submit} disabled={createInvoice.isPending} data-testid="purchase-save">
            {t("purchasesSave")}
          </button>
        </div>
      )}

      <ItemPickerDialog open={pickerOpen} onClose={() => setPickerOpen(false)} onSelect={addLine} />
    </section>
  );
}

/** Post-save proposal: one-click attribution of earlier uninvoiced stock */
export function LinkProposalPanel({ invoiceId }: { invoiceId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const proposal = useQuery(orpc.purchasesProposal.queryOptions({ input: { invoiceId } }));
  const [linkedMsg, setLinkedMsg] = useState<string | null>(null);

  const link = useMutation(
    orpc.purchasesLinkStock.mutationOptions({
      onSuccess: (result) => {
        setLinkedMsg(t("purchasesLinked", { linked: result.linked, remainder: result.remainderMoved }));
        // SAFETY: without this refetch the stale proposal keeps showing the old
        // proposedLinkQty with an enabled button, and a second submit reports
        // zero units linked (greptile round-2)
        void queryClient.invalidateQueries({
          queryKey: orpc.purchasesProposal.queryKey({ input: { invoiceId } }),
        });
      },
      onError: (err) => setLinkedMsg(tError(err.message)),
    }),
  );

  const linkable = (proposal.data?.items ?? []).filter((row) => row.proposedLinkQty > 0);

  return (
    <div className="mt-3 rounded border bg-stone-50 p-3" data-testid="link-proposal">
      <h3 className="font-semibold">{t("purchasesProposalTitle")}</h3>
      {proposal.isPending ? null : linkable.length === 0 ? (
        <p className="mt-1 text-sm text-stone-500">{t("purchasesProposalEmpty")}</p>
      ) : (
        <ul className="mt-2 grid gap-2">
          {linkable.map((row) => (
            <li key={row.itemId} className="flex items-center justify-between gap-2">
              <span>
                {row.itemName} — {t("purchasesProposalUninvoiced")} {row.uninvoicedQty}
              </span>
              <button
                type="button"
                className="rounded-lg bg-stone-900 px-3 py-1 text-sm text-white disabled:opacity-50"
                disabled={link.isPending}
                onClick={() => link.mutate({ invoiceId, allocations: [{ itemId: row.itemId, quantity: row.proposedLinkQty }] })}
              >
                {t("purchasesLinkBtn")} ({row.proposedLinkQty})
              </button>
            </li>
          ))}
        </ul>
      )}
      {linkedMsg && (
        <p className="mt-2 text-sm text-green-700" data-testid="link-result">
          {linkedMsg}
        </p>
      )}
    </div>
  );
}
