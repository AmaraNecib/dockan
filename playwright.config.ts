import path from "node:path";

import { defineConfig } from "@playwright/test";

// #343 — the app is served from a loopback hostname of its own, so the vault
// cookie is scoped to this app alone (a cookie for 127.0.0.1 is handed to
// every other local service, because cookies ignore ports).
//
// Imported by path: the Playwright config is loaded by Node, which cannot
// follow the workspace packages' extensionless imports.
import { resolveAppHost } from "./packages/contracts/src/app-host";
import { installLoopbackHostnames } from "./packages/e2e-support/src/loopback-hostnames";

// A browser maps every `*.localhost` name to the loopback address (RFC 6761);
// Node's resolver does not, and the harness runs on Node. The mapping goes in
// before any spec runs, so a request addressed to the app's own name reaches
// the same server the browser reaches — without it, the specs would have to
// address 127.0.0.1, which is the sharing this change exists to end.
installLoopbackHostnames();

// Defaults honoured; env wins so parallel CI lanes can run side by side.
// The api and web servers themselves fall back to a free port if taken.
const API_PORT = Number(process.env.DOKAN_PORT ?? 4317);
const WEB_PORT = Number(process.env.DOKAN_WEB_PORT ?? 5173);
/** the name the app answers on — the same one the api and the dev server use */
const APP_HOST = resolveAppHost(process.env);

// The API resolves DOKAN_DATA_DIR itself and may run from any workspace cwd,
// so the e2e database path must be absolute. This is also the path the
// clean-room wipe deletes, so reruns never accumulate items (a strict-mode
// duplicate caught in development). One source of truth: a harness that
// overrides E2E_DATA_DIR must move the server and the reset scripts together,
// or the reset would clear a different database than the tests run against.
const e2eData = process.env.E2E_DATA_DIR ?? path.join(process.cwd(), ".e2e-data");

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 30_000,
  retries: 0,
  // every spec shares one sqlite database (wipe -> setup -> login), so spec
  // files must run sequentially; parallel workers would race first-time setup
  workers: 1,
  use: {
    // the app's own name, not 127.0.0.1: the vault cookie is scoped to the
    // host it was written for, and the specs must exercise the host the
    // owner actually uses (#343)
    baseURL: `http://${APP_HOST}:${WEB_PORT}`,
    locale: "ar-DZ",
    // Failure evidence for CI (#197): the e2e job uploads test-results/ when a
    // step fails. retain-on-failure, not on-first-retry: retries are 0 above, so
    // on-first-retry would record nothing. The trace carries the DOM snapshots
    // and the /api/rpc request/response bodies that a bare 30s timeout cannot
    // attribute (wisdom 2026-10-14-e2e-ack-vs-test-budget); the screenshot and
    // error-context.md land beside it. No video by default: it adds per-test
    // encoding cost on a sequential suite without answering anything the trace
    // leaves open. A spec that owes "real user pace" evidence (#259) opts in
    // with `test.use({ video: ... })` instead of paying for it everywhere.
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  webServer: [
    {
      command: "node scripts/wipe-e2e.mjs && bun run --filter @dokan/api start",
      url: `http://127.0.0.1:${API_PORT}/health`,
      reuseExistingServer: false,
      timeout: 30_000,
      // stdout defaults to "ignore", which would discard the API log the e2e job
      // uploads on failure (#197). "pipe" forwards it to Playwright's stdout,
      // where the CI step tees it into e2e-logs/. stderr already defaults here.
      stdout: "pipe",
      env: {
        DOKAN_PORT: String(API_PORT),
        DOKAN_DATA_DIR: e2eData,
        E2E_DATA_DIR: e2eData,
        // The web server's port, so the api knows the origin the browser
        // reaches the app at (#343) — the origin its own-origin checks and
        // better-auth's trusted origins are written against.
        DOKAN_WEB_PORT: String(WEB_PORT),
        // The shared suite covers the legacy plaintext flows (setup with a
        // password, login, session cookies). The unified vault has its own
        // isolated pair in tests/e2e/vault.spec.ts with DOKAN_VAULT unset.
        DOKAN_VAULT: "disabled",
      },
    },
    {
      command: "bun run --filter @dokan/web dev",
      url: `http://127.0.0.1:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 30_000,
      stdout: "pipe", // see the API entry above
      env: {
        DOKAN_WEB_PORT: String(WEB_PORT),
        DOKAN_PORT: String(API_PORT),
        // the app's name, so the dev server and the harness agree on the
        // origin the app answers on (#343)
        DOKAN_APP_HOST: APP_HOST,
        // enlarge the scanner's duplicate-suppression window under e2e so
        // "rescan same code" is deterministically suppressed (typing takes
        // ~150 ms) while "new scan after the window" stays provable
        VITE_SCAN_DUPLICATE_WINDOW_MS: "1200",
        // widen the editable-field burst gap under e2e: the focused-input
        // regime is timing-based, and CI load made 50 ms drop scans
        // (wisdom 2026-08-24-deterministic-timing-tests)
        VITE_SCAN_MAX_GAP_MS: "250",
      },
    },
  ],
});