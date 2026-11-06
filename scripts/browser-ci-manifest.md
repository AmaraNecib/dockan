# Browser CI manifest pilot

The e2e job stores one `manifest.json` artifact per successful run attempt as `playwright-e2e-manifest-<run-id>-<attempt>`. GitHub retains it for five days. It is capped at 256 KiB. Existing failure/cancellation artifacts remain unchanged.

The manifest records Playwright's discovered inventory and reporter callback outcomes for that execution. `complete` is false for missing callbacks, missing results, duplicate/malformed identities, collector errors, or interrupted runs. Retries, skips and expected failures remain explicit. The output contains only fixed provenance fields and an allowlist of app/test environment values; it does not include logs, exceptions, attachments, environment dumps or test parameters.

`browserIdentity` explicitly reports actual executable hash, revision and version as `unknown`: the current reporter seam cannot observe the launched browser. It does not treat Playwright's resolved default or package expectation as a runtime observation.

This is observation only: it saves zero minutes, sets `noSafeReuseCertified: true`, and never authorizes reusing or skipping a browser run. A missing artifact is nonblocking; inspect the Playwright job's normal result and existing failure evidence.
