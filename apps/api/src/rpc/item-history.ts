import { ORPCError } from "@orpc/server";
import type { ItemHistoryInput, ItemHistoryMovement } from "@dokan/contracts";
import { resolvePagination } from "@dokan/contracts";
import type { StorePort } from "../store/port";
import { historyWithRemaining, supersededByCorrectionSeq } from "../lib/stock-ledger";

/** All history facts share a read transaction and one cost-bearing DTO. */
export async function readItemHistory(store: StorePort, input: ItemHistoryInput) {
  return store.withTransaction(async (tx) => {
    const item = (await tx.getItemsByIds([input.itemId])).get(input.itemId);
    if (item === undefined) throw new ORPCError("NOT_FOUND", { message: "ITEM_NOT_FOUND" });
    const movements = await tx.listStockMovements(item.id);
    const lines = await tx.listItemHistoryLines(item.id);
    const links = await tx.listStockLinksByItem(item.id);
    const projected = historyWithRemaining(movements);
    const { limit, offset } = resolvePagination(input);
    const page = projected.slice(offset, offset + limit);
    const superseded = supersededByCorrectionSeq(projected, offset, offset + page.length);
    const returnInvoices = new Map<string, string | null>();
    for (const row of page) {
      if (row.ref === null || returnInvoices.has(row.ref)) continue;
      if (row.reason === "RETURN_RECORDED" || row.reason?.startsWith("RETURN_REJECTED_DAMAGED")) {
        returnInvoices.set(row.ref, (await tx.getReturnHeader(row.ref))?.invoiceId ?? null);
      } else if (row.reason === "SUPPLIER_RETURN") {
        returnInvoices.set(row.ref, (await tx.getSupplierReturn(row.ref))?.invoiceId ?? null);
      }
    }
    const rows = page.map((row, index): ItemHistoryMovement => {
      const invoiceLines = lines.filter((line) => line.invoiceId === row.ref);
      // No persisted movement-to-line key exists. Ambiguous matches stay unknown.
      const candidate = invoiceLines.length === 1 ? invoiceLines[0] : undefined;
      const sale = row.kind === "SALE" && row.delta < 0 && row.reason === null
        && candidate?.invoiceKind === "SALE" && candidate.quantity === -row.delta
        ? candidate : undefined;
      const documentIds = new Set(links.filter((link) => link.movementId === row.id).map((link) => link.invoiceId));
      if (row.ref !== null) {
        documentIds.add(row.ref);
        const returnedInvoiceId = returnInvoices.get(row.ref);
        if (returnedInvoiceId != null) documentIds.add(returnedInvoiceId);
      }
      const documents = [...new Map(lines.filter((line) => documentIds.has(line.invoiceId))
        .map((line) => [line.invoiceId, { id: line.invoiceId, number: line.invoiceNumber }])).values()];
      const recordedCost = sale?.costAtSale ?? row.unitCost;
      return { ...row, supersededBySeq: superseded[index] ?? null, details: {
        sellingPrice: sale?.unitPrice ?? null,
        saleTotal: sale?.total ?? null,
        netSaleTotal: sale?.netTotal ?? null,
        cost: { unitCost: recordedCost, total: sale?.cogsExact ?? (row.delta > 0 && row.unitCost !== null ? row.delta * row.unitCost : null) },
        documents,
      } };
    });
    return { item: { id: item.id, name: item.name }, movements: rows, total: movements.length, stockOnHand: projected.at(-1)?.stockAfter ?? 0 };
  });
}
