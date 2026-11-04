import { describe, expect, it } from "bun:test";
import { itemHistoryOutputSchema } from "../../../../packages/contracts/src/core";
import type { StorePort, StoreReadPort } from "../store/port";
import { readItemHistory } from "./item-history";

class IterationCountedArray<T> extends Array<T> {
  iterations = 0;
  filters = 0;

  override [Symbol.iterator](): ArrayIterator<T> {
    this.iterations += 1;
    return super[Symbol.iterator]();
  }

  override filter(predicate: (value: T, index: number, array: T[]) => boolean): T[] {
    this.filters += 1;
    return super.filter(predicate);
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
    const links = Array.from({ length: count }, (_, index) => ({
      id: `link-${index}`,
      invoiceId: `invoice-${(index + 1) % count}`,
      movementId: `movement-${index}`,
      quantity: 1,
      createdAt: "2025-01-01T00:00:00",
    }));
    // One movement genuinely links three documents; reverse both source collections
    // to prove the display order does not inherit adapter/query iteration order.
    links.push({ id: "link-extra", invoiceId: "invoice-2", movementId: "movement-0", quantity: 1, createdAt: "2025-01-01T00:00:00" });
    const trackedLines = new IterationCountedArray(...[...lines].reverse());
    const trackedLinks = new IterationCountedArray(...[...links].reverse());
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
    expect(history).toMatchObject({ item: { id: "item-1", name: "Indexed item" }, total: count, stockOnHand: count });

    // At 1,000 rows the previous per-movement line/doc filters inspect ~2,000,000 line slots; these counts pin one index pass each without machine-dependent timing limits.
    expect(history.movements).toHaveLength(count);
    expect(history.movements[0]?.details?.documents).toEqual([
      { id: "invoice-0", number: "INV-0" },
      { id: "invoice-1", number: "INV-1" },
      { id: "invoice-2", number: "INV-2" },
    ]);
    expect(history.movements.at(-1)?.details?.documents).toEqual([
      { id: "invoice-0", number: "INV-0" },
      { id: `invoice-${count - 1}`, number: `INV-${count - 1}` },
    ]);
    expect(trackedLines.iterations).toBe(1);
    expect(trackedLines.filters).toBe(0);
    expect(trackedLinks.iterations).toBe(1);
    expect(trackedLinks.filters).toBe(0);
  });

  it("returns null for unsafe recorded sale COGS and keeps the history contract valid", async () => {
    const movements = [{
      id: "00000000-0000-4000-8000-000000000002",
      itemId: "00000000-0000-4000-8000-000000000001",
      kind: "PURCHASE" as const,
      delta: 2,
      unitCost: Number.MAX_SAFE_INTEGER,
      reason: null,
      ref: "00000000-0000-4000-8000-000000000004",
      returnMark: null,
      occurredAt: "2025-01-01T00:00:00",
      createdAt: "2025-01-01T00:00:00",
      seq: 1,
    }, {
      id: "00000000-0000-4000-8000-000000000008",
      itemId: "00000000-0000-4000-8000-000000000001",
      kind: "PURCHASE" as const,
      delta: 1,
      unitCost: null,
      reason: null,
      ref: null,
      returnMark: null,
      occurredAt: "2025-01-01T12:00:00",
      createdAt: "2025-01-01T12:00:00",
      seq: 2,
    }, {
      id: "00000000-0000-4000-8000-000000000003",
      itemId: "00000000-0000-4000-8000-000000000001",
      kind: "SALE" as const,
      delta: -2,
      unitCost: Number.MAX_SAFE_INTEGER,
      reason: null,
      ref: "00000000-0000-4000-8000-000000000005",
      returnMark: null,
      occurredAt: "2025-01-02T00:00:00",
      createdAt: "2025-01-02T00:00:00",
      seq: 3,
    }];
    const lines = [{
      id: "00000000-0000-4000-8000-000000000006",
      invoiceId: "00000000-0000-4000-8000-000000000005",
      itemId: "00000000-0000-4000-8000-000000000001",
      description: "Sale item",
      quantity: 2,
      defaultUnitPrice: 20,
      unitPrice: 20,
      costAtSale: Number.MAX_SAFE_INTEGER,
      cogsExact: Number.MAX_SAFE_INTEGER + 1,
      total: 40,
      discountAllocated: 0,
      netTotal: 40,
      invoiceNumber: "INV-SALE",
      invoiceKind: "SALE" as const,
    }];
    const tx = {
      getItemsByIds: async () => new Map([["00000000-0000-4000-8000-000000000001", {
        id: "00000000-0000-4000-8000-000000000001",
        name: "Indexed item",
        barcode: null,
        categoryId: "00000000-0000-4000-8000-000000000007",
        costPrice: 10,
        sellingPrice: 20,
        lowStockThreshold: 0,
        stockOnHand: 0,
        createdAt: "2025-01-01T00:00:00",
        updatedAt: "2025-01-01T00:00:00",
      }]]),
      listStockMovements: async () => movements,
      listItemHistoryLines: async () => lines,
      listStockLinksByItem: async () => [],
      getReturnHeader: async () => undefined,
      getSupplierReturn: async () => undefined,
    } satisfies StoreReadPort;
    const store: Pick<StorePort, "withReadTransaction"> = {
      withReadTransaction: async <T>(callback: (readTx: StoreReadPort) => Promise<T>) => callback(tx),
    };

    const history = await readItemHistory(store, { itemId: "00000000-0000-4000-8000-000000000001", limit: 10 });
    expect(history).toMatchObject({
      item: { id: "00000000-0000-4000-8000-000000000001", name: "Indexed item" },
      total: 3,
      stockOnHand: 1,
    });

    const sale = history.movements.find((movement) => movement.id === "00000000-0000-4000-8000-000000000003");
    expect(sale?.details?.cost?.total).toBeNull();
    const unknownInflow = history.movements.find((movement) => movement.id === "00000000-0000-4000-8000-000000000008");
    expect(unknownInflow?.details?.cost).toEqual({ unitCost: null, total: null });
    const parsed = itemHistoryOutputSchema.safeParse(history);
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
    expect(parsed.success).toBe(true);
  });
});
