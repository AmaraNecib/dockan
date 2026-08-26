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

- `apps/desktop/scripts/sidecar.ts`: validates `DOKAN_BUILD_SECRET` (≥16
  chars — refuses a default/weak secret, PR #51 finding 2) and compiles the
  sidecar with the secret inlined via `bun build --define` replacing
  `process.env.DOKAN_BUILD_SECRET` (the literal the api reads in `main.ts`).
- `apps/desktop/scripts/release.ts`: the `portable` pipeline — validate →
  compile sidecar → `tauri build --bundles nsis` → rename the installer with
  `DOKAN_CUSTOMER_SLUG` when set (e.g. `Dokan_0.1.0_acme_x64-setup.exe`).
- `apps/desktop/package.json`: `build` = `sidecar && tauri build`,
  `portable` = `scripts/release.ts`; `test` = `bun test` (pipeline tests).
- `src-tauri/build.rs`: ensures the sidecar exists for cargo gates from a
  clean checkout (PR #51 finding 3); inlines the secret only when a strong
  `DOKAN_BUILD_SECRET` is present, otherwise compiles a secret-less test
  artifact with a loud `cargo:warning` — never shippable, never a default.
- root: `"desktop:portable"` passthrough.
- `.gitignore`: `target/`, `apps/desktop/src-tauri/binaries/`,
  `apps/desktop/src-tauri/gen/`. `dist/` already ignored.

## Security review round (PR #51) — findings 1, 2, 3

### Finding 1 — verified sidecar discovery (done)

The release bootstrap previously navigated from the persistent port record.
Now: the shell binds a listener on `127.0.0.1:0` — the kernel assigns a
free port and the socket reserves it while the child is spawned — hands the
exact port to the child explicitly (`DOKAN_PORT` = authoritative for the
api), generates a one-time boot token (`DOKAN_BOOT_TOKEN`), and only
navigates after BOTH identity checks pass: the child echoes the token at
`GET /health-token?token=…` (constant-time compare both sides; the response
body must contain the exact `"token":"…"` JSON field) AND the port-record
registry entry under the child's pid records that port. A stale, tampered,
decoyed or race-hijacked record can never redirect the webview — verified
live (decoy on 4444 + planted record → app bound its own kernel-assigned
port, decoy saw zero requests). Rust unit tests pin `reserve_port`,
`registry_owned_by`, `health_token_ok`, `generate_boot_token`.

**PR #51 TOCTOU follow-up (done):** the original fix probed a free port,
leaving a window where a local process could bind the eventual port before
 the child, intercept the token URL, echo it, and pass verification. The
probe is GONE: `reserve_port()` binds port 0 and holds the reservation
through the spawn; the child then takes over the exact assigned port.
Ownership is cross-checked via the child-pid registry entry (a hijacker who
won the drop→bind window would have made the child's explicit bind fail and
exit — no entry, no navigation). Regression tests: the reservation is
unbindable while alive and re-bindable after release; a kernel-assigned port
never collides with an occupied one; `registry_owned_by` rejects missing,
wrong, longer (`43189` ≠ `4318`) and wrong-host entries.

### Finding 5 — committed session-signing secret (done)

**Vulnerability:** the released Rust shell contained a COMMITTED
`PRODUCTION_AUTH_SECRET` constant forwarded to the child as
`DOKAN_AUTH_SECRET` — the better-auth session-signing key. Anyone who could
read the binary or the source could extract it, forge admin session cookies,
and pass every protected RPC on EVERY install (one shared key for the whole
fleet). The per-customer round covered DOKAN_BUILD_SECRET only; the signing
key stayed shared.

**Fix — mirror the build-secret pipeline exactly:**
1. `DOKAN_AUTH_SECRET` (>= 32 chars) is now REQUIRED at release build time
   and inlined into the sidecar exe with the same `bun build --define` seam
   as the build secret (scripts/sidecar.ts + release.ts; per-customer value
   supplied by the vendor).
2. Missing/weak AUTH_SECRET fails the build loudly (exit 1) — the committed
   `PRODUCTION_AUTH_SECRET` constant is deleted from desktop.rs and the shell
   no longer passes any secret to the child. Dev/test keep the explicit
   `DEV_AUTH_SECRET` sentinel only outside packaged builds; a packaged binary
   whose signing secret is missing/weak/sentinel is refused at boot (main.ts
   packaged-boot guard), so no shipped binary can sign sessions with a shared
   key even if misbuilt.
3. Leak scan: no auth secret in env-passing, logs, port-record, app-data or
   committed files.
4. Tests: pipeline unit tests assert release builds exit 1 without
   `DOKAN_AUTH_SECRET` (missing and weak); live verification of a compiled
   sidecar: a session signed by the INLINED secret is accepted by a protected
   RPC and a token signed by any other secret is rejected; dev builds still
   boot without it (config sentinel + e2e).

### Finding 2 — per-customer build secret (done, parent decision)

**Decision (parent): option 2 — per-customer secret, no shared committed
value.** The vendor picks a unique secret per shop and passes it at build
time; it is inlined into the compiled sidecar exe with `bun build --define`,
never committed, never in the runtime environment, logs, port-record or
app-data (the Rust shell no longer passes it to the child). The api's reset
procedure reads it from the binary via the `main.ts` define seam
(`config.buildSecret ??= process.env.DOKAN_BUILD_SECRET`). PASSWORD_RESET
behavior unchanged — verified live: the packaged exe accepts the inlined
secret (`ok:true`) and rejects any other (`WRONG_BUILD_SECRET`).

**Exact per-customer release command (documented + run):**

```bash
DOKAN_BUILD_SECRET='<unique-per-shop-secret, >=16 chars>' \
DOKAN_CUSTOMER_SLUG='shop-slug' \          # optional: names the installer
bun run --filter @dokan/desktop portable
# → src-tauri/target/release/bundle/nsis/Dokan_<version>[_<slug>]_x64-setup.exe
```

Missing or weak (<16 chars) secrets fail loudly (exit 1, message + example);
there is no fallback secret. Verified: `Dokan_0.1.0_acme-shop_x64-setup.exe`
produced with `DOKAN_CUSTOMER_SLUG=acme-shop`.

### Threat model — who holds what

- **Vendor** holds the per-shop secret at build time (in the build shell
  env, briefly on the build command line, and inside the produced exe).
- **Installer holder** (shop owner) receives a binary with the secret baked
  in. After provisioning, a determined local attacker with access to the exe
  **can** extract the secret (strings/RE on the binary) and run the reset
  procedure — honest statement: per-customer inlining does not make the
  secret inextractable from the artifact itself.
- **Why per-customer bounds the blast radius:** one shop's extracted secret
  does not unlock any other shop's install; rotation for a compromised shop
  is rebuild + reinstall with a fresh secret. The shared-laptop threat model
  is casual co-users, not RE attackers, and the session model (server-side
  sessions, better-auth signing secret held separately) is unchanged.
- **At runtime the secrets are never written**: not to committed files, not
  to logs (the reset procedure logs no secret), not to the port record or
  app-data; the shell passes neither to the child (the child's env is clean).
- The better-auth session-signing secret (`DOKAN_AUTH_SECRET`, PR #51 finding
  5) is a SECOND per-customer credential protecting session cookies, inlined
  into the sidecar at build time exactly like the provisioning secret. The
  two are deliberately independent — a per-customer build must vary BOTH so
  the fleet never silently shares a signing key. The shell holds neither; the
  api reads both from the binary via `bun build --define` seams in main.ts.

### Future: hybrid reset models (open)

A follow-up could move secret-ownership off the binary: e.g. a per-install
secret generated at first boot and shown once to the vendor (printed setup
code), or a vendor-held secret compared server-side only if the app ever
gains an onboarding channel. Not decided; the current per-customer model
keeps the reset path local and offline as the MVP requires.

### Finding 3 — clean build generates the sidecar (done)

`binaries/` is gitignored, yet tauri-build hard-fails without the artifact.
The pipeline now generates it: `bun run build` = validating sidecar script +
`tauri build`; `bun run portable` = release.ts; and `build.rs` compiles the
sidecar (secret only when provided) when missing, so `cargo test`/`clippy`
work from a clean checkout too. Verified: sidecar deleted → `cargo test`
regenerated it and passed.

## Deliverable command (documented + run)

```bash
DOKAN_BUILD_SECRET='<unique-per-shop-secret>' bun run --filter @dokan/desktop portable
# → apps/desktop/src-tauri/target/release/bundle/nsis/Dokan_0.1.0[_<slug>]_x64-setup.exe
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