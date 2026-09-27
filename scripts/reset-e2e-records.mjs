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
if (!fs.existsSync(dbPath)) process.exit(0);

const db = new Database(dbPath);
try {
  // busy_timeout: the API holds its own WAL connection while this one writes.
  db.exec("PRAGMA busy_timeout = 5000;");
  // children before parents; FKs are off on this connection but the order is
  // still the safe one if that ever changes
  db.exec(`
    DELETE FROM stock_links;
    DELETE FROM return_lines;
    DELETE FROM returns;
    DELETE FROM payments;
    DELETE FROM invoice_lines;
    DELETE FROM invoices;
    DELETE FROM stock_movements;
    DELETE FROM items;
    DELETE FROM activities;
    DELETE FROM preferences;
  `);
} finally {
  db.close();
}
