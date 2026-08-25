# Ticket 15 — Desktop packaging (installable Windows app)

Tier: Standard + Rust gates. Base SHA: 9e4e97b (merge-base with origin/develop).

## Problem

The owner installs the product on one Windows PC. Today `apps/desktop` is a Tauri
stub: empty `lib.rs`, `targets: ["nsis"]`, no icons, no sidecar, no bootstrap.
Nothing bundles the Bun API or the built UI in a way that runs on a clean PC
with no setup.

## Design: same-origin production topology

The web frontend calls the API with **relative** `/api/*` URLs (same-origin
through the Vite proxy in dev — `apps/web/src/lib/rpc.ts`,
`apps/web/src/lib/auth-client.ts`). In a packaged app there is no Vite, so the
relative calls must land on the API's origin. Rather than rewrite web sources
(owned by other lanes) or proxy through Tauri custom protocols (cookie
fragility on WebView2), the packaged app makes the **API itself the origin**:

```
desktop exe (Rust shell)
  └─ spawns  sidecar:  apps/api compiled via `bun build --compile` (externalBin)
  └─ env:    DOKAN_DATA_DIR   = %APPDATA%/dz.dokan.app          (data, logs, backups)
             DOKAN_PORT_ROOT   = %APPDATA%/dz.dokan.app/run     (port record files)
             DOKAN_WEB_DIST    = <resource>/ui                  (bundled web dist)
             DOKAN_BUILD_SECRET= baked per-build secret
  └─ waits for <.dokan-port> + TCP probe  →  navigates main window to
             http://127.0.0.1:<port>
```

The API serves the bundled UI (static + SPA fallback) **only when
`DOKAN_WEB_DIST` is set** (production); dev and e2e never set it, so their
behavior is byte-identical. The window's *startup* page is still the bundled
`frontendDist` assets — if the API ever fails to boot, the user sees the real
UI with its in-app error states instead of a connection-refused flash.

Dev mode (`tauri dev`) is untouched: `debug_assertions` builds skip the sidecar
entirely and load the Vite devUrl — the developer runs `bun run dev:api` +
`bun run dev:desktop` as today.

## Changes

### 1. API compile entry — `apps/api/src/main.ts`, `apps/api/src/config.ts`

- `createAppConfig`: add optional `webDataDir` read from `DOKAN_WEB_DIST`
  (absent in dev → no behavior change; unit tests construct configs without it).
- `main.ts`:
  - `fs.mkdirSync(dataDir, { recursive: true })` and `dataDir/backups` at boot —
    today nothing creates them, so a fresh `DOKAN_DATA_DIR` (the app-data
    folder on a clean PC) would fail at `openConnection` / daily backup.
  - Port-record location: when `DOKAN_PORT_ROOT` is set, `.dokan-port`,
    `.dokan-port.lock` and `.dokan-port.registry` live under that directory
    instead of the git workspace root (`findWorkspaceRoot` is a dev concept).
    Unset → current behavior, e2e untouched.
  - When `config.webDataDir` is set, mount the api app inside a parent Hono
    app that also serves static files from `webDataDir` (SPA fallback to
    `index.html`). `createApp` itself is NOT touched (store/router seam
    belongs to the api lane).

### 2. Tauri shell — `apps/desktop/src-tauri/`

- `tauri.conf.json`: `externalBin: ["binaries/dokan-api"]`, resources
  `{ "../../apps/web/dist": "ui" }`, icon list, NSIS `installMode: "perUser"`,
  `webviewInstallMode: { type: "embedBootstrapper" }`, window `label: "main"`.
- New `src/desktop.rs` (spawn + wait + navigate + cleanup), exercised from a
  thin `lib.rs`:
  - release only: resolve `app_data_dir` (create), spawn
    `resource_dir()/dokan-api.exe` (CREATE_NO_WINDOW on Windows) with the env
    above, then poll `<port_root>/.dokan-port` and TCP-probe the port, then
    `WebviewWindow::navigate("http://127.0.0.1:<port>")`.
  - kill the sidecar on `RunEvent::Exit` / window close; state held in a
    managed `Mutex<Option<Child>>`.
  - no new crates (std::process::Command; std::net::TcpStream probe).
- `capabilities/default.json` with `core:default`.

### 3. Icons — `apps/desktop/src-tauri/icons/`

Master 1024² PNG generated (Python PIL: rounded square, teal gradient, white
"D" mark) → `bunx tauri icon` produces the full set (ico/icns/png). Windows
taskbar/installer icon comes from `icon.ico` via tauri-build.

### 4. Scripts — `apps/desktop/package.json`, root `package.json`, `.gitignore`

- `apps/desktop`: `"sidecar"` = `bun build --compile ../api/src/main.ts
  --outfile src-tauri/binaries/dokan-api-x86_64-pc-windows-msvc`;
  `"portable"` = `sidecar && tauri build --bundles nsis`.
- root: `"desktop:portable"` passthrough.
- `.gitignore`: `target/`, `apps/desktop/src-tauri/binaries/`,
  `apps/desktop/src-tauri/gen/`. `dist/` already ignored.

## Deliverable command (documented + run)

```bash
bun run --filter @dokan/desktop portable
# → apps/desktop/src-tauri/target/release/bundle/nsis/Dokan_0.1.0_x64-setup.exe
```

## Tests

- Unit: `apps/api/src/config` reads `DOKAN_WEB_DIST`; nothing else changes
  (existing suite stays green: `bun run typecheck && bun run lint && bun run test`,
  plus Rust gates `cargo test` / `cargo clippy -D warnings`).
- E2E: untouched (`bun run test:e2e` with `DOKAN_PORT=4329 DOKAN_WEB_PORT=5185
  --workers=1`) — proves dev/e2e paths still bind (no `DOKAN_PORT_ROOT` /
  `DOKAN_WEB_DIST` set).
- Packaging evidence: sidecar compiles + boots an SQLite server; `tauri build
  --bundles nsis` produces the installer; icons present.

## Risks

- **Rust compile time** (full Tauri tree, first build) — several minutes.
- **NSIS embedBootstrapper** downloads WebView2 bootstrapper at build time;
  if the fetch fails the build errors — fall back to the default
  downloadBootstrapper and document (Win10/11 ships WebView2 anyway).
- **Built-in `.exe` is ~100 MB** (Bun runtime) → installer ~110 MB. Accepted
  for a kiosk PC; documented.
- **Sidecar orphan after hard crash** (kill is TerminateProcess, no cleanup
  hooks): next launch probes a free port and rewrites the record — self-heals.
- Remote-origin webview (http://127.0.0.1): no Tauri IPC capability is used
  by the app, so the remote restriction has no impact.

## Deferred (pending, documented)

Fresh-install smoke on a clean PC (login → first sale → backup file exists) —
blocked by #11 receipts landing.