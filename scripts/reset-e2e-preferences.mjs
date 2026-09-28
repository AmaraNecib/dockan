import fs from "node:fs";
import path from "node:path";
import { Database } from "bun:sqlite";

/**
 * Clear UI preferences between e2e tests. They are server-side now (issue 97
 * follow-up), so one test's dismissal/completion would otherwise leak into the
 * next. Called from the onboarding spec's beforeEach; records are untouched.
 */
const dir = process.env.E2E_DATA_DIR;
if (!dir) throw new Error("E2E_DATA_DIR is required");
const dbPath = path.join(dir, "dokan.db");
if (!fs.existsSync(dbPath)) throw new Error(`e2e database not found at ${dbPath}`);

const db = new Database(dbPath);
try {
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("DELETE FROM preferences;");
} finally {
  db.close();
}
