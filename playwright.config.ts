import path from "node:path";

import { defineConfig } from "@playwright/test";

// Match the api's absolute DOKAN_DATA_DIR so the clean-room wipe hits the
// exact folder the api writes to, whichever cwd the filtered run uses.
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
      // clean-room start: wipe the previous run's database first
      command: "node scripts/wipe-e2e.mjs && bun run --filter @dokan/api start",
      url: "http://127.0.0.1:4317/health",
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        DOKAN_DATA_DIR: e2eData,
        E2E_DATA_DIR: e2eData,
        // the login e2e performs first-time setup with this secret
        DOKAN_BUILD_SECRET: "e2e-secret-0123456789",
      },
    },
    {
      command: "bun run --filter @dokan/web dev",
      url: "http://localhost:5173",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});