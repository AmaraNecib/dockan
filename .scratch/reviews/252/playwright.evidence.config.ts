// Issue #252 lane evidence — committed as the provenance for the before/after
// run (`.scratch/reviews/252/direction-labels.evidence.spec.ts`). Not part of the
// suite or the build: copy it to the repo root as `playwright.evidence.config.ts`
// to rerun the walkthrough, then delete it.
import { defineConfig } from "@playwright/test";

import base from "./playwright.config";

export default defineConfig({
  ...base,
  testDir: "./.scratch/reviews/252",
  testMatch: "**/direction-labels.evidence.spec.ts",
  outputDir: "./.scratch/reviews/252/pw-output",
  use: { ...base.use, video: "on", viewport: { width: 1280, height: 820 } },
});
