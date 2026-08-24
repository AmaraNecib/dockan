import path from "node:path";

import { defineConfig } from "@playwright/test";

// Defaults honoured; env wins so parallel CI lanes can run side by side.
// The api and web servers themselves fall back to a free port if taken.
const API_PORT = Number(process.env.DOKAN_PORT ?? 4317);
const WEB_PORT = Number(process.env.DOKAN_WEB_PORT ?? 5173);

// The API resolves DOKAN_DATA_DIR itself and may run from any workspace cwd,
// so the e2e database path must be absolute. This is also the path the
// clean-room wipe deletes, so reruns never accumulate items (a strict-mode
// duplicate caught in development).
const e2eData = path.join(process.cwd(), ".e2e-data");

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  retries: 0,
  // every spec shares one sqlite database (wipe -> setup -> login), so spec
  // files must run sequentially; parallel workers would race first-time setup
  workers: 1,
  use: {
    baseURL: `http://127.0.0.1:${WEB_PORT}`,
    locale: "ar-DZ",
  },
  webServer: [
    {
      command: "node scripts/wipe-e2e.mjs && bun run --filter @dokan/api start",
      url: `http://127.0.0.1:${API_PORT}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        DOKAN_PORT: String(API_PORT),
        DOKAN_DATA_DIR: e2eData,
        E2E_DATA_DIR: e2eData,
        // first-time setup in both e2e specs uses this secret
        DOKAN_BUILD_SECRET: "e2e-secret-0123456789",
      },
    },
    {
      command: "bun run --filter @dokan/web dev",
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 30_000,
      env: {
        DOKAN_WEB_PORT: String(WEB_PORT),
        DOKAN_PORT: String(API_PORT),
        // enlarge the scanner's duplicate-suppression window under e2e so
        // "rescan same code" is deterministically suppressed (typing takes
        // ~150 ms) while "new scan after the window" stays provable
        VITE_SCAN_DUPLICATE_WINDOW_MS: "1200",
      },
    },
  ],
});