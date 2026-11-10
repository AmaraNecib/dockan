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
  // Legacy returns have no source attribution. Never offer guessed per-source
  // caps: the later persistence phase must subtract proven return allocations.
  if (returned > 0) return unavailable;
  const links = (await store.listStockLinksByItem(line.itemId)).filter((link) => link.invoiceLineId === line.id);
  if (links.length === 0 || links.some((link) => link.invoiceId !== invoice.id || !Number.isSafeInteger(link.quantity) || link.quantity <= 0) ||
      links.reduce((sum, link) => sum + link.quantity, 0) !== line.quantity) return unavailable;
  const movements = new Map((await store.listStockMovements(line.itemId)).map((movement) => [movement.id, movement]));
  const sources: ReturnSources["sources"] = [];
  for (const link of links) {
    const movement = movements.get(link.movementId);
    if (movement === undefined || movement.delta <= 0 || link.quantity > movement.delta) return unavailable;
    const pending = movement.costPending === true;
    if (!pending && movement.unitCost === null) return unavailable;
    sources.push({ stockLinkId: link.id, movementId: movement.id, occurredAt: movement.occurredAt,
      unitCost: pending ? null : movement.unitCost, costPending: pending, quantityAvailable: link.quantity });
  }
  const first = sources[0];
  return { provenanceComplete: true,
    selectionRequired: first !== undefined && sources.some((source) => source.unitCost !== first.unitCost || source.costPending !== first.costPending),
    sources };
}
