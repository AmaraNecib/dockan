# Browser evidence runner

`capture-browser-evidence.ts` owns the Dokan API and web processes, gives them a private data directory and four distinct lane ports, waits for both listeners, then records a 1920×1080 journey. It captures locator screenshots and creates CRF 18 MP4 plus a palette GIF. It checks duration, stream dimensions and hashes, and writes a failure manifest for setup or capture errors. It never downloads tools or overwrites an output directory.

## Journey module

A journey module default-exports:

```ts
{
  servers: [
    { name: "api", command: "bun", args: ["src/main.ts"], cwd: "apps/api", readinessUrl: "http://127.0.0.1:{port}/api/vault/status" },
    { name: "web", command: "bun", args: ["run", "dev"], cwd: "apps/web", readinessUrl: "http://127.0.0.1:{port}/" }
  ],
  setup?(page, runtime),
  journey(page, { screenshotElement }, runtime)
}
```

`runtime.urls.api`, `runtime.urls.web`, and all four `runtime.ports` values are typed. `setup` runs in an unrecorded browser context; use it for login or other setup. Keep business selectors and assertions inside `journey`. The runner owns process startup, safety environment, readiness, media and cleanup.

Server commands use argument arrays and `shell: false`. `cwd` is relative to the exact source root and must resolve inside it. Server `env` cannot replace `DOKAN_DATA_DIR`, `DOKAN_PORT_ROOT`, or any allocated port. The runner assigns those after journey environment values.

## Capture a comparison pair

Use two existing, clean source roots checked out at distinct exact commits. The root paths and revisions must differ. The parent supplies these roots through the supported worktree mechanism; do not create a checkout in the shell, copy application data, or point either run at a mutable working tree. Keep both pinned roots unchanged for both captures. A concurrent edit is detected by the runner's final HEAD/tree/cleanliness check, but a transient edit that is changed back between checks cannot be ruled out.

The first capture is a **single capture**, not a verified pair. Record the second capture from a distinct root and pass its first manifest with `--comparison-manifest`; it must prove the exact other revision, clean source root, matching pair ID, and successful capture. The second capture remains a `pair-member`; only its `comparison-pair.json` reports `status: pair-verified`. That index hashes and names both manifests, roots, revisions and source trees. Pair ID alone is not evidence.

Example API and web commands are real Dokan commands. Add the project-specific actions and assertions to a copied journey file; use `runtime.urls` rather than hard-coded ports:

```js
export default {
  servers: [
    { name: "api", command: "bun", args: ["src/main.ts"], cwd: "apps/api", readinessUrl: "http://127.0.0.1:{port}/api/vault/status" },
    { name: "web", command: "bun", args: ["run", "dev"], cwd: "apps/web", readinessUrl: "http://127.0.0.1:{port}/" },
  ],
  async setup(page, runtime) {
    await page.goto(runtime.urls.web);
    // Perform login or other setup here. This context is not recorded.
  },
  async journey(page, evidence, runtime) {
    await page.goto(runtime.urls.web);
    // Put actual product actions and assertions here. Do not add idle waits.
    await evidence.screenshotElement("dokan-screen", "main");
  },
};
```

Run with four explicit distinct ports and a new output path:

```sh
bun scripts/capture-browser-evidence.ts \
  --journey /absolute/path/to/journey.mjs \
  --source /absolute/path/to/clean-source-root \
  --revision <full-commit-sha> \
  --against <other-full-commit-sha> \
  --output /absolute/path/to/new-evidence-directory \
  --api-port 4617 --web-port 4618 --vault-port 4619 --vault-web-port 4620
```

For the second capture, add `--comparison-manifest /absolute/path/to/first/manifest.json`. `bun`, installed Playwright Chromium, `ffmpeg`, and `ffprobe` must already exist. The runner preflights them before starting servers. Install project dependencies only with `bun install --frozen-lockfile` before capture; do not install a browser or media tool from this runner. If server shutdown fails, the private fixture data stays in the output directory for diagnosis. Existing output is never replaced.
