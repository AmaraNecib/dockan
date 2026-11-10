import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";

import { createAppConfig } from "../config";
import { openConnection, type Connection } from "../db/connection";
import { createDrizzleStore } from "./drizzle-store";
import type { StorePort } from "./port";

const invoiceCount = 500;
const linksPerInvoice = 1_400;
const expectedFanout = invoiceCount * linksPerInvoice;

let dir: string;
let conn: Connection;
let store: StorePort;

beforeAll(async () => {
  const scratch = path.resolve(import.meta.dir, "../../../../.scratch");
  fs.mkdirSync(scratch, { recursive: true });
  dir = fs.mkdtempSync(path.join(scratch, "stock-history-fanout-"));
  conn = openConnection(createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: path.join(dir, "test.db") }));
  store = createDrizzleStore(conn);
  await store.setup();
});

afterAll(async () => {
  await conn.close();
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      await Bun.sleep(50);
    }
  }
});

// red-on-parent-waive: "^stock history with high invoice-link fanout loads every saved sale source when 500 invoice IDs return 700,000 links$" - Base b6d2e24e lacks stock_links.invoice_line_id and stock_outflow_consumptions, so fixture preparation cannot reach assertions; the same fixture reproduces RangeError against pre-fix a3a65992 and passes all 1,002 assertions with iterative appends.
describe("stock history with high invoice-link fanout", () => {
  it("loads every saved sale source when 500 invoice IDs return 700,000 links", async () => {
    const [category] = await store.listCategories();
    if (!category) throw new Error("seed category missing");
    const item = await store.createItem({ name: "fanout-target", categoryId: category.id, costPrice: 100, sellingPrice: 200 });
    const distractor = await store.createItem({ name: "fanout-distractor", categoryId: category.id, costPrice: 50, sellingPrice: 100 });
    const sourceId = "fanout-source";
    const distractorSourceId = "fanout-distractor-source";
    const timestamp = "2026-11-01T00:00:00";

    conn.raw.exec("BEGIN");
    try {
      const movement = conn.raw.prepare(`INSERT INTO stock_movements
        (id, item_id, kind, delta, unit_cost, cost_pending, reason, ref, return_mark, occurred_at, created_at)
        VALUES (?, ?, ?, ?, ?, 0, NULL, ?, NULL, ?, ?)`);
      movement.run(sourceId, item.id, "PURCHASE", 1, 100, null, timestamp, timestamp);
      movement.run(distractorSourceId, distractor.id, "PURCHASE", 1, 50, null, timestamp, timestamp);
      const invoice = conn.raw.prepare(`INSERT INTO invoices
        (id, invoice_number, kind, invoice_date, subtotal_amount, discount_amount, total_amount, paid_amount, remaining_amount, created_at, updated_at)
        VALUES (?, ?, 'SALE', ?, 200, 0, 200, 200, 0, ?, ?)`);
      const line = conn.raw.prepare(`INSERT INTO invoice_lines
        (id, invoice_id, item_id, description, quantity, unit_price, cost_at_sale, cogs_exact, total, net_total)
        VALUES (?, ?, ?, 'fanout sale', 1, 200, 100, 100, 200, 200)`);
      const saleMovement = conn.raw.prepare(`INSERT INTO stock_movements
        (id, item_id, kind, delta, unit_cost, cost_pending, reason, ref, return_mark, occurred_at, created_at)
        VALUES (?, ?, 'SALE', -1, 100, 0, NULL, ?, NULL, ?, ?)`);
      const link = conn.raw.prepare(`INSERT INTO stock_links
        (id, invoice_id, invoice_line_id, movement_id, quantity, created_at)
        VALUES (?, ?, ?, ?, ?, ?)`);
      const savedConsumption = conn.raw.prepare(`INSERT INTO stock_outflow_consumptions
        (movement_id, source_movement_id, quantity) VALUES (?, ?, 1)`);
      for (let index = 0; index < invoiceCount; index++) {
        const invoiceId = `fanout-invoice-${index}`;
        const lineId = `fanout-line-${index}`;
        const saleId = `fanout-sale-${index}`;
        invoice.run(invoiceId, `FAN-${String(index).padStart(4, "0")}`, timestamp, timestamp, timestamp);
        line.run(lineId, invoiceId, item.id);
        saleMovement.run(saleId, item.id, invoiceId, timestamp, timestamp);
        savedConsumption.run(saleId, distractorSourceId);
        link.run(`fanout-valid-${index}`, invoiceId, lineId, sourceId, 1, timestamp);
        for (let row = 1; row < linksPerInvoice; row++) {
          link.run(`fanout-noise-${index}-${row}`, invoiceId, null, distractorSourceId, 1, timestamp);
        }
      }
      conn.raw.exec("COMMIT");
    } catch (error) {
      if (conn.raw.inTransaction) conn.raw.exec("ROLLBACK");
      throw error;
    }

    const movements = await store.listStockMovements(item.id);
    const sales = movements.filter((movement) => movement.kind === "SALE");
    expect(sales).toHaveLength(invoiceCount);
    for (const [index, movement] of sales.entries()) {
      expect(movement.ref).toBe(`fanout-invoice-${index}`);
      expect(movement.consumedMovements).toEqual([{ movementId: sourceId, quantity: 1 }]);
    }
    expect(expectedFanout).toBe(700_000);
  }, 60_000);
});
