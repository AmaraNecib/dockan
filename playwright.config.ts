import { defineConfig } from "@playwright/test";

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
      command: "bun run --filter @dokan/api start",
      url: "http://127.0.0.1:4317/health",
      reuseExistingServer: false,
      timeout: 30_000,
      env: { DOKAN_DATA_DIR: ".e2e-data" },
    },
    {
      command: "bun run --filter @dokan/web dev",
      url: "http://localhost:5173",
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});