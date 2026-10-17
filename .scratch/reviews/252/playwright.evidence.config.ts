// TEMPORARY (issue #252 lane) — not committed. Points the real Playwright
// config at the evidence spec in .scratch and turns video on so the before/after
// flow is recorded at real pace.
import { defineConfig } from "@playwright/test";

import base from "./playwright.config";

export default defineConfig({
  ...base,
  testDir: "./.scratch/reviews/252",
  outputDir: "./.scratch/reviews/252/pw-output",
  use: { ...base.use, video: "on", viewport: { width: 1280, height: 820 } },
});
