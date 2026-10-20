import fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";

/**
 * Reset the shared e2e database to a "no shop records" state.
 *
 * `scripts/wipe-e2e.mjs` deletes the whole data dir once, before the API boots.
 * That is not enough for the getting-started spec's fresh-install assertion
 * under `playwright --repeat-each`: the second group still sees the first
 * group's items/invoices. The onboarding spec calls this in `beforeAll`, which
 * runs once per repeat group, so the assertion owns its state.
 *
 * Auth, store settings, and the number sequences are deliberately preserved:
 * the owner stays provisioned (login is not under test here) and invoice
 * numbering stays honest. UI preferences ARE cleared, because a dismissal
 * persisted by the previous group would hide the panel the spec expects.
 */
const dir = process.env.E2E_DATA_DIR;
if (!dir) throw new Error("E2E_DATA_DIR is required");
const dbPath = path.join(dir, "dokan.db");
// the API is up (webServer readiness) before this runs, so a missing database
// means the path is wrong — fail loudly instead of silently resetting nothing
if (!fs.existsSync(dbPath)) throw new Error(`e2e database not found at ${dbPath}`);

const db = new Database(dbPath);
/** The tables the reset must empty: the shop's own records, in one list. */
const SHOP_RECORD_TABLES = ["items", "invoices", "stock_movements"];
try {
  // busy_timeout: the API holds its own WAL connection while this one writes.
  db.exec("PRAGMA busy_timeout = 5000;");
  // children before parents; FKs are off on this connection but the order is
  // still the safe one if that ever changes. Every SHOP-RECORD table in
  // apps/api/src/db/schema.ts is listed here; the named survivors are settings,
  // the auth tables, the expense categories (a seeded default) and the three
  // number sequences (invoice, customer-return and supplier-return numbering
  // must stay honest).
  db.exec(`
    DELETE FROM supplier_return_lines;
    DELETE FROM supplier_returns;
    DELETE FROM supplier_account_entries;
    DELETE FROM stock_links;
    DELETE FROM return_lines;
    DELETE FROM returns;
    DELETE FROM payments;
    DELETE FROM invoice_lines;
    DELETE FROM invoices;
    DELETE FROM stock_movements;
    DELETE FROM items;
    -- item categories go with the items; expense categories are seeded
    -- defaults and deliberately survive (expenses reference expense_categories)
    DELETE FROM categories;
    DELETE FROM activities;
    DELETE FROM expenses;
    DELETE FROM customers;
    DELETE FROM suppliers;
    DELETE FROM preferences;
  `);

  // PROVE the end state, not the intent. A reset that half-happened — one
  // table left behind, one DELETE line deleted from the list above — used to
  // leave the suite green and the next spec with a dirty database. The counts
  // are read back from the same connection that did the deletes, and a
  // leftover row is a non-zero exit: the spec's afterAll fails loudly
  // instead of the run going green over a table that is not empty.
  const leftovers = SHOP_RECORD_TABLES.map((table) => {
    const row = db.query(`SELECT COUNT(*) AS count FROM ${table}`).get();
    return { table, count: Number(row?.count ?? 0) };
  });
  const dirty = leftovers.filter((entry) => entry.count > 0);
  if (dirty.length > 0) {
    throw new Error(
      `reset did not clear the shop records: ${dirty.map((entry) => `${entry.table}=${entry.count}`).join(", ")}`,
    );
  }
} finally {
  db.close();
}
