# Offline browser CI comparison

Run the local, read-only analyzer with explicit PR/push run IDs:

```bash
bun scripts/browser-ci-analyzer.ts --repo AmaraNecib/dockan \
  --pair 42101309032:42103231162 \
  --pair 42106001119:42108565362
```

It calls `gh run view` for exact run metadata and the `playwright e2e` job log, then resolves each browser job's own checkout SHA to its Git tree. It starts no Actions. `gh` must already be authenticated and able to read these runs and commits. Each `gh` lookup times out after 20 seconds, output is capped at 8 MiB, and requests run serially for up to 20 explicit pairs. A lookup or log failure prints evidence as unknown rather than stopping with an implied match.

Classifications mean:

- `candidate`: the collected evidence aligns enough to merit investigation.
- `mismatch`: collected source, scope, result, or runtime signals disagree.
- `unknown`: required evidence is missing, ambiguous, malformed, unsuccessful, or attempt identity is uncertain.

Every record states `noSafeReuseCertified: true`. A candidate is not a safe-to-skip signal. Matching test counts do not establish identical inventory. Matching source does not establish that mutable runner state, event data, environment, or SHA-dependent behavior is interchangeable. Browser checkout SHA and tree are separate from workflow-head/checks-job metadata. Browser wall seconds are separate from workflow duration; neither is billing nor guaranteed savings.

The parser anchors checkout on the browser log's exact `git log -1 --format=%H` command, even when the step label is `UNKNOWN STEP`. It reads the Playwright final summary, not arbitrary `failed` words in application RPC output. Logs with absent or repeated summaries remain unknown. The current parser relies on the GH CLI log shape and the workflow's `E2E_SPECS` / `bun run test:e2e` pipeline. Runtime signals are observed identifiers, not full environment equivalence. It does not establish Playwright browser binary identity or validate secrets, mutable services, trust or event inputs.

The five source/full-scope pairs in the offline handoff total 71 observed browser-job estimated minutes across the push runs. Running the command above against those ten runs produced three `candidate` pairs and two `unknown` pairs because GitHub logs for one side of each pair lacked enough checkout, scope, or summary data. The three candidates had matching browser trees and counts (148, 153 and 155); this does not prove matching test inventories. This is a measured comparison sample only. It does not guarantee avoidable cost, and the 71 excludes other workflow jobs. Do not use this analyzer to change a workflow, required check, cache, permission or coverage decision.
