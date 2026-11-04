import { describe, expect, it } from "bun:test";
import type { StorePort, StoreReadPort } from "../store/port";
import { readItemHistory } from "./item-history";

class IterationCountedArray<T> extends Array<T> {
  iterations = 0;

  override [Symbol.iterator](): ArrayIterator<T> {
    this.iterations += 1;
    return super[Symbol.iterator]();
  }
}

describe("item history projection scaling", () => {
  it("indexes each loaded invoice-line and movement-link collection once for a large history", async () => {
    const count = 1_000;
    const movements = Array.from({ length: count }, (_, index) => ({
      id: `movement-${index}`,
      itemId: "item-1",
      kind: "PURCHASE" as const,
      delta: 1,
      unitCost: 10,
      reason: null,
      ref: `invoice-${index}`,
      returnMark: null,
      occurredAt: `2025-01-${String(Math.floor(index / 24) + 1).padStart(2, "0")}T${String(index % 24).padStart(2, "0")}:00:00`,
      createdAt: "2025-01-01T00:00:00",
      seq: index + 1,
    }));
    const lines = Array.from({ length: count }, (_, index) => ({
      id: `line-${index}`,
      invoiceId: `invoice-${index}`,
      itemId: "item-1",
      description: `Item ${index}`,
      quantity: 1,
      defaultUnitPrice: 20,
      unitPrice: 20,
      costAtSale: 10,
      cogsExact: 10,
      total: 20,
      discountAllocated: 0,
      netTotal: 20,
      invoiceNumber: `INV-${index}`,
      invoiceKind: "PURCHASE" as const,
    }));
    const links: Array<{ id: string; invoiceId: string; movementId: string; quantity: number; createdAt: string }> = [];
    const trackedLines = new IterationCountedArray(...lines);
    const trackedLinks = new IterationCountedArray(...links);
    const tx = {
      getItemsByIds: async () => new Map([["item-1", {
        id: "item-1",
        name: "Indexed item",
        barcode: null,
        categoryId: "category-1",
        costPrice: 10,
        sellingPrice: 20,
        lowStockThreshold: 0,
        stockOnHand: count,
        createdAt: "2025-01-01T00:00:00",
        updatedAt: "2025-01-01T00:00:00",
      }]]),
      listStockMovements: async () => movements,
      listItemHistoryLines: async () => trackedLines,
      listStockLinksByItem: async () => trackedLinks,
      getReturnHeader: async () => undefined,
      getSupplierReturn: async () => undefined,
    } satisfies StoreReadPort;
    const store: Pick<StorePort, "withReadTransaction"> = {
      withReadTransaction: async <T>(callback: (readTx: StoreReadPort) => Promise<T>) => callback(tx),
    };

    const history = await readItemHistory(store, { itemId: "item-1", limit: count });

    // At 1,000 rows the previous per-movement line/doc filters inspect ~2,000,000 line slots; these counts pin one index pass each without machine-dependent timing limits.
    expect(history.movements).toHaveLength(count);
    expect(history.movements[0]?.details?.documents).toEqual([{ id: "invoice-0", number: "INV-0" }]);
    expect(history.movements.at(-1)?.details?.documents).toEqual([{ id: `invoice-${count - 1}`, number: `INV-${count - 1}` }]);
    expect(trackedLines.iterations).toBe(1);
    expect(trackedLinks.iterations).toBe(1);
  });
});
