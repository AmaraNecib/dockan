# Durable browser CI summaries

Run the exporter manually while the GitHub artifact still exists:

```bash
bun scripts/browser-ci-export.ts \
  --repo AmaraNecib/dockan \
  --archive "$HOME/.local/share/dokan/browser-ci/runs.jsonl" \
  --scope full \
  --run 42246263388
```

Choose an explicit absolute archive path. The command uses existing `gh` authentication to read run metadata and download the exact `playwright-e2e-manifest-<run-id>-<attempt>` artifact. It does not start Actions or upload data. Scope is caller supplied. Use `selected` with repeated `--selected-file tests/e2e/example.spec.ts` only when the exact file list is known; otherwise use `unknown`. Never infer full scope from counts or a green job.

**This is a manual export, not automatic retention.** If nobody exports a run before the GitHub artifact expires after five days, that inventory and per-test evidence is unrecoverable. This command makes no automatic coverage claim. Older run logs may retain some signals, but they cannot restore the expired manifest.

The archive is UTF-8 JSONL. Its rows are logically append-only, keyed by repository, run ID, run attempt and browser job ID. Re-exporting the same key and artifact digest is a no-op. A different digest for that key is a conflict. Writes take an exclusive lock, build a bounded temporary archive and atomically replace the file. A failed write leaves the old archive bytes intact. The exporter rejects symlink archive targets, but the caller should choose a private local directory. It does not send or prune archive data.

Rows keep only fixed run/job metadata, hashes and counts, scope and its selected file list, source artifact digest, export time, and per-test identity digests with attempt statuses. It omits actor, environment values, logs, titles, exceptions, parameters, attachment paths and secrets. Browser executable identity is always `unknown`. Duration is browser job elapsed time, not workflow duration and not billing. Incomplete or malformed manifests keep an explicit unavailable status and null measurements. Unknown does not mean complete.

The archive is measurement data. It does not authorize skipping or reusing tests, and this increment does not calculate savings or compare runs. Delete it only by an explicit operator action, for example:

```bash
rm "$HOME/.local/share/dokan/browser-ci/runs.jsonl"
```

The command only reads GitHub and writes the explicit local archive path. Tests use temporary directories and injected write failures; they do not access GitHub credentials or the network.
