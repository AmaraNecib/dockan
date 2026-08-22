import path from "node:path";

import { defineConfig } from "@playwright/test";

// The API resolves DOKAN_DATA_DIR itself and may run from any workspace cwd,
// so the e2e database path must be absolute. This is also the path the
// clean-room wipe deletes, so reruns never accumulate items (a strict-mode
// duplicate caught in development).
const e2eData = path.join(process.cwd(), ".e2e-data");

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  retries: 0,
  use: {
    baseURL: "http://localhost:5173",
    locale: "ar-DZ",
  },
  webServer: [
    {
      command: "node scripts/wipe-e2e.mjs && bun run --filter @dokan/api start",
      url: "http://127.0.0.1:4317/health",
      reuseExistingServer: false,
      timeout: 30_000,
      env: { DOKAN_DATA_DIR: e2eData, E2E_DATA_DIR: e2eData },
    },
    {
      command: "bun run --filter @dokan/web dev",
      url: "http://localhost:5173",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});