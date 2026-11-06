# Browser evidence runner

Use `capture-browser-evidence.ts` for browser evidence. It checks a clean, exact source revision, starts one server with explicit argv (no shell), waits for HTTP readiness, records at 1920×1080, captures element screenshots, converts to MP4/GIF and validates duration and dimensions. The output directory must not exist. It writes a manifest with the revision, command, hashes and result. It never uploads files or installs tools.

## Journey contract

A journey module default-exports `EvidenceJourney`:

```ts
{
  server: { command, args, cwd, readinessUrl, env? },
  journey(page, { screenshotElement(name, selector) })
}
```

`cwd` is relative to the pinned source root. Set `readinessUrl` to include `{port}` and use the supplied port in server configuration. Journey code owns only application actions and assertions. Capture setup/login before the useful segment where possible. The recorded useful journey must naturally last 30–45 seconds. Add visible actions and reading pauses; do not pad with idle waits, change playback speed or accept an invalid duration.

## Capture exact before and after sources

Provide two already-existing clean source roots. Each root must have the exact expected commit checked out. `--against` names the other capture's full commit SHA, and the runner rejects identical revisions. The parent creates and validates these roots using the supported worktree mechanism; do not create shell worktrees or copy private application data. Keep each root immutable while its server runs. Run each capture separately with a fresh output directory and distinct port:

```sh
bun scripts/capture-browser-evidence.ts \
  --journey /absolute/path/to/source/scripts/my-journey.mjs \
  --source /absolute/path/to/clean-source-root \
  --revision <full-commit-sha> \
  --against <other-full-commit-sha> \
  --output /absolute/path/to/new-evidence-directory \
  --port 4617
```

The runner refuses a dirty or mismatched source, occupied port and existing output path. Install dependencies only with the frozen lockfile before capturing. `bun`, the installed Playwright Chromium and machine `ffmpeg`/`ffprobe` must already be available. A missing tool is a capture failure, not permission to install it.

See [`browser-evidence-example.mjs`](browser-evidence-example.mjs) for the small journey shape. Before/after labels and pairing belong in the capture handoff; the runner never claims two captures are comparable unless their revisions differ.
