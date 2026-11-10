import { ORPCError } from "@orpc/server";
import type { ReturnSources } from "@dokan/contracts";
import type { StoreReadPort } from "../store/port";

/** Source choices describe posted consumption, not today's FIFO replay. */
export async function readReturnSources(
  store: StoreReadPort,
  input: { invoiceId: string; invoiceLineId: string },
): Promise<ReturnSources> {
  const invoice = await store.getInvoiceDetail(input.invoiceId);
  if (invoice === undefined) throw new ORPCError("NOT_FOUND", { message: "INVOICE_NOT_FOUND" });
  if (invoice.kind !== "SALE") throw new ORPCError("BAD_REQUEST", { message: "RETURN_NOT_SALE" });
  const line = invoice.lines.find((entry) => entry.id === input.invoiceLineId);
  if (line === undefined) throw new ORPCError("BAD_REQUEST", { message: "LINE_NOT_ON_INVOICE" });
  if (line.itemId === null) throw new ORPCError("BAD_REQUEST", { message: "RETURN_LINE_NOT_RETURNABLE" });
  const unavailable: ReturnSources = { provenanceComplete: false, selectionRequired: false, sources: [] };
  const returned = (await store.returnedByLine(invoice.id)).get(line.id)?.quantity ?? 0;
  const allocations = await store.returnSourceAllocationsByLine?.(line.id) ?? [];
  const attributedQuantity = allocations.reduce((sum, allocation) => sum + allocation.quantity, 0);
  if (attributedQuantity > returned) return unavailable;
  const returnedByLink = new Map<string, number>();
  for (const allocation of allocations) returnedByLink.set(allocation.stockLinkId, (returnedByLink.get(allocation.stockLinkId) ?? 0) + allocation.quantity);
  const links = (await store.listStockLinksByItem(line.itemId)).filter((link) => link.invoiceLineId === line.id);
  const eligibleLinkIds = new Set(links.map((link) => link.id));
  if (allocations.some((allocation) => !eligibleLinkIds.has(allocation.stockLinkId) || !Number.isSafeInteger(allocation.quantity) || allocation.quantity <= 0)) return unavailable;
  if (links.length === 0 || links.some((link) => link.invoiceId !== invoice.id || !Number.isSafeInteger(link.quantity) || link.quantity <= 0) ||
      links.reduce((sum, link) => sum + link.quantity, 0) !== line.quantity) return unavailable;
  const movements = new Map((await store.listStockMovements(line.itemId)).map((movement) => [movement.id, movement]));
  const legacyQuantity = returned - attributedQuantity;
  if (legacyQuantity > 0) {
    const effectiveSources = links.map((link) => movements.get(link.movementId));
    const first = effectiveSources[0];
    // An old return can be assigned oldest-first only when every eligible
    // source has the same known cost. Pending or mixed sources may resolve to
    // different costs later, so their missing ancestry remains a hard refusal.
    if (first === undefined || first.costPending === true || first.unitCost === null ||
        effectiveSources.some((source) => source === undefined || source.costPending === true || source.unitCost !== first.unitCost)) return unavailable;
    let remaining = legacyQuantity;
    for (const link of links) {
      const available = link.quantity - (returnedByLink.get(link.id) ?? 0);
      const take = Math.min(remaining, available);
      if (take > 0) returnedByLink.set(link.id, (returnedByLink.get(link.id) ?? 0) + take);
      remaining -= take;
      if (remaining === 0) break;
    }
    if (remaining !== 0) return unavailable;
  }
  const sources: ReturnSources["sources"] = [];
  for (const link of links) {
    const movement = movements.get(link.movementId);
    if (movement === undefined || movement.delta <= 0 || link.quantity > movement.delta) return unavailable;
    const pending = movement.costPending === true;
    if (!pending && movement.unitCost === null) return unavailable;
    const quantityAvailable = link.quantity - (returnedByLink.get(link.id) ?? 0);
    if (quantityAvailable < 0) return unavailable;
    if (quantityAvailable > 0) sources.push({ stockLinkId: link.id, movementId: movement.id, occurredAt: movement.occurredAt,
      unitCost: pending ? null : movement.unitCost, costPending: pending, quantityAvailable });
  }
  const first = sources[0];
  return { provenanceComplete: true,
    selectionRequired: first !== undefined && sources.some((source) => source.unitCost !== first.unitCost || source.costPending !== first.costPending),
    sources };
}
