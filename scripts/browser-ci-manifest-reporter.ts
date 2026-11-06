import { BrowserManifestReporter } from "./browser-ci-manifest-collector";

// Playwright loads reporters through a default export; tests use the named collector.
export default BrowserManifestReporter;
