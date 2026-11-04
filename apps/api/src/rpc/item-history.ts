import { ORPCError } from "@orpc/server";
import type { ItemHistoryInput, ItemHistoryMovement } from "@dokan/contracts";
import { resolvePagination } from "@dokan/contracts";
import type { StorePort } from "../store/port";
import { historyWithRemaining, supersededByCorrectionSeq } from "../lib/stock-ledger";

/** History facts share a read transaction. Redact both row.unitCost and details.cost. */
export async function readItemHistory(store: Pick<StorePort, "withReadTransaction">, input: ItemHistoryInput) {
  return store.withReadTransaction(async (tx) => {
    const item = (await tx.getItemsByIds([input.itemId])).get(input.itemId);
    if (item === undefined) throw new ORPCError("NOT_FOUND", { message: "ITEM_NOT_FOUND" });
    const movements = await tx.listStockMovements(item.id);
    const lines = await tx.listItemHistoryLines(item.id);
    const links = await tx.listStockLinksByItem(item.id);
    const linesByInvoiceId = new Map<string, typeof lines>();
    const documentsByInvoiceId = new Map<string, { id: string; number: string }>();
    for (const line of lines) {
      const invoiceLines = linesByInvoiceId.get(line.invoiceId);
      if (invoiceLines === undefined) linesByInvoiceId.set(line.invoiceId, [line]);
      else invoiceLines.push(line);
      if (!documentsByInvoiceId.has(line.invoiceId)) {
        documentsByInvoiceId.set(line.invoiceId, { id: line.invoiceId, number: line.invoiceNumber });
      }
    }
    const linksByMovementId = new Map<string, string[]>();
    for (const link of links) {
      const invoiceIds = linksByMovementId.get(link.movementId);
      if (invoiceIds === undefined) linksByMovementId.set(link.movementId, [link.invoiceId]);
      else invoiceIds.push(link.invoiceId);
    }
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
      const invoiceLines = row.ref === null ? undefined : linesByInvoiceId.get(row.ref);
      // No persisted movement-to-line key exists. Ambiguous matches stay unknown.
      const candidate = invoiceLines?.length === 1 ? invoiceLines[0] : undefined;
      const sale = row.kind === "SALE" && row.delta < 0 && row.reason === null
        && candidate?.invoiceKind === "SALE" && candidate.quantity === -row.delta
        ? candidate : undefined;
      const documentIds = new Set(linksByMovementId.get(row.id) ?? []);
      if (row.ref !== null) {
        documentIds.add(row.ref);
        const returnedInvoiceId = returnInvoices.get(row.ref);
        if (returnedInvoiceId != null) documentIds.add(returnedInvoiceId);
      }
      // Linked documents use invoice-number order, with invoice id as the stable tie-breaker;
      // neither SQL row order nor link insertion order carries display semantics.
      const documents = [...documentIds]
        .sort((left, right) => {
          const leftDocument = documentsByInvoiceId.get(left);
          const rightDocument = documentsByInvoiceId.get(right);
          if (leftDocument === undefined) return rightDocument === undefined ? left < right ? -1 : left > right ? 1 : 0 : 1;
          if (rightDocument === undefined) return -1;
          return leftDocument.number < rightDocument.number ? -1
            : leftDocument.number > rightDocument.number ? 1
              : left < right ? -1 : left > right ? 1 : 0;
        })
        .flatMap((invoiceId) => {
          const document = documentsByInvoiceId.get(invoiceId);
          return document === undefined ? [] : [document];
        });
      const recordedCost = sale?.costAtSale ?? row.unitCost;
      const inflowTotal = row.delta > 0 && row.unitCost !== null ? row.delta * row.unitCost : null;
      // Valid unit facts can have an unrepresentable total. Never return rounded money.
      const safeInflowTotal = inflowTotal !== null && Number.isSafeInteger(inflowTotal) ? inflowTotal : null;
      const recordedSaleCogs = sale?.cogsExact;
      const safeSaleCogs = recordedSaleCogs !== undefined && Number.isSafeInteger(recordedSaleCogs) ? recordedSaleCogs : null;
      return { ...row, supersededBySeq: superseded[index] ?? null, details: {
        sellingPrice: sale?.unitPrice ?? null,
        saleTotal: sale?.total ?? null,
        netSaleTotal: sale?.netTotal ?? null,
        cost: { unitCost: recordedCost, total: sale === undefined ? safeInflowTotal : safeSaleCogs },
        documents,
      } };
    });
    return { item: { id: item.id, name: item.name }, movements: rows, total: movements.length, stockOnHand: projected.at(-1)?.stockAfter ?? 0 };
  });
}
