import fs from "node:fs";

// Clean-room e2e start: delete the previous run's database so reruns never
// accumulate records. Called by playwright.webServer before the API boots.
const dir = process.env.E2E_DATA_DIR;
if (!dir) throw new Error("E2E_DATA_DIR is required");
fs.rmSync(dir, { recursive: true, force: true });