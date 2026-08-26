# 64 — True portable build (folder + zip, run-in-place, exe-adjacent data)

**Tier: Standard** (packaging; no money math). **Base SHA:** `ffe5cf6`.

## Problem

`bun run --filter @dokan/desktop portable` currently runs
`tauri build --bundles nsis` and renames the installer: the customer gets an
NSIS-installed app whose data lives in `%APPDATA%\dz.dokan.app`. The owner
wants a real portable distribution — a **folder + zip** that is copyable to a
USB key or any folder, runs in place, and keeps **all data next to the exe**,
exactly like the sibling project `D:/projects/tuari_react_hono`
(`apps/desktop/scripts/build-portable.mjs` + exe-adjacent resources).

## Current topology (verified)

- `apps/desktop/src-tauri/src/desktop.rs::spawn_and_navigate()`:
  - `data_dir = ensure_dir(app.path().app_data_dir()?)` → `%APPDATA%\dz.dokan.app`
  - `port_root = ensure_dir(data_dir.join("run"))`
  - `DOKAN_WEB_DIST = resource_dir.join("ui")`, sidecar at `resource_dir/<dokan-api.exe>`
  - TOCTOU boot-token verification + port-record registry check (PR #51)
- `tauri.conf.json`: targets `["nsis"]`, resources `{"../../../apps/web/dist": "ui"}`, externalBin `binaries/dokan-api`
- `scripts/release.ts` validates `DOKAN_BUILD_SECRET` (>=16) + `DOKAN_AUTH_SECRET` (>=32), compiles the sidecar, then `tauri build --bundles nsis`, splugs installer rename

### Tauri facts that make portable work without touching resources

Verified in `tauri-utils-2.9.3/src/platform.rs::resource_dir_from`: on
**Windows `resource_dir` = the directory of the current exe** (raw binary or
bundled). So a portable folder laid out flat:

```
Dokan-portable/
  Dokan-portable.exe
  dokan-api.exe        <- sidecar (resource_dir/<dokan-api.exe>)
  ui/                  <- web assets (resource_dir/ui)
  portable.marker
```

needs **zero resource-path changes**: `resource_dir` already resolves to the
folder containing the exe.

## Design

### 1. Rust portable detection (`desktop.rs`)

- Marker file: **`portable.marker`** sitting next to the exe
  (`std::env::current_exe()` parent dir). An installed app never has it.
- New testable helper:

```rust
pub const PORTABLE_MARKER: &str = "portable.marker";

/// Needs-testing seam: data dir for a given exe dir + installed app-data dir.
/// Portable (marker next to exe) -> <exe-dir>/data; installed -> app_data_dir.
pub fn runtime_data_dir(exe_dir: &Path, app_data_dir: PathBuf) -> PathBuf
```

- `spawn_and_navigate()`:
  - `exe_dir = current_exe().parent()`
  - `data_dir = ensure_dir(runtime_data_dir(&exe_dir, app_data_dir()?))`
  - `port_root = ensure_dir(data_dir.join("run"))` (unchanged derivation)
- Everything else — reserve-port, boot token, `DOKAN_DATA_DIR` / `DOKAN_PORT_ROOT` /
  `DOKAN_WEB_DIST` env, health/registry verification — untouched. Logs, backups,
  sqlite and port records all derive from `data_dir`/`port_root` inside the API
  (`createAppConfig`), so they land exe-adjacent automatically in portable mode.
- Point 4 of the brief (API sees exe-adjacent data) is satisfied by the same
  `DOKAN_DATA_DIR` env plumbing: it now carries the portable path.

### 2. Packaging scripts (`apps/desktop/scripts/`)

| File | Role |
|---|---|
| `script-security-utils.mjs` | mirror of tuari's: `resolveTrustedTarPath` (System32 `tar.exe`), `validateReleaseArtifacts` (per-artifact existence/type/non-empty, refuses an empty `ui/`), `copyValidatedTree` (no symlinks / junctions) |
| `portable.mjs` | assembly: source the **flat** `target/release/` (`dokan.exe` + `dokan-api.exe` + `ui/` — tauri-build 2.6.x copies resources and the external sidecar straight into the release root, NO `resources/` subdir, verified by a real build), emit `target/release/bundle/portable/Dokan-portable/` + `.zip` via trusted `tar -a -c -f` (same zip style as tuari); per-process staging dir (pid-unique); `-new` fallback when the canonical folder is locked |
| `release.ts` (rework) | unchanged secret validation + sidecar compile; then dispatch: **default = portable** (`tauri build --no-bundle` — the nsis installer is never produced on this path), **`--installer` = nsis** (existing install + slug rename); win32 preflight, stale `bundle/nsis` removal, unknown flags fail loudly |

Portable layout produced (verified end-to-end with `bun run --filter @dokan/desktop portable` on 2026-08-26):

```
bundle/portable/Dokan-portable/
  Dokan-portable.exe     (copied from target/release/dokan.exe — byte-identical)
  dokan-api.exe          (sidecar, from the flat release root)
  ui/                    (built web assets)
  portable.marker        (empty marker)
bundle/portable/Dokan-portable.zip   (41.8 MB; entries: ./dokan-api.exe ./Dokan-portable.exe ./portable.marker ./ui/...)
```

- NSIS is **avoided in the portable path** by `tauri build --no-bundle` (verified:
  `bundle/` contains only `portable/`, no `bundle/nsis`, no `*setup.exe`), and a
  stale `bundle/nsis` from an earlier installer run is removed by release.ts.
- `validateReleaseArtifacts` guards the app exe, sidecar and ui tree (missing,
  zero-byte, wrong type, or an empty `ui/` all abort the build loudly); the
  release root's other build outputs (deps/, build/, .pdb, .cargo-lock) are
  legit and never shipped.
- Deterministic-ish zip: same `tar -a -c -f` invocation as tuari.

### 3. Script wiring

- `apps/desktop/package.json`:
  - `"portable": "bun scripts/release.ts"` (default → folder + zip)
  - `"installer": "bun scripts/release.ts --installer"` (nsis installer)
- Root `package.json` `desktop:portable` already forwards to the desktop
  workspace — owner command `bun run --filter @dokan/desktop portable` now
  produces the folder + zip.

## Tests

| Test | Gate |
|---|---|
| Rust: `runtime_data_dir` marker-present → `<exe-dir>/data`; marker-absent → `app_data_dir`. Temp dir + fake exe dir via the helper, no real exe needed | `cargo test` |
| `portable.test.ts` (bun): assemble from scratch dirs → folder contains `Dokan-portable.exe`, `dokan-api.exe`, `ui/`, `portable.marker` and **no** `*setup.exe` / nsis artifact; zip produced with expected name | `bun run test` (desktop workspace) |
| `script-security-utils.test.ts`-style assertions folded into `portable.test.ts` (entry validation rejects unexpected; copy rejects symlinks) | same |
| e2e continues green (dev mode untouched by Rust change — `cfg!(debug_assertions)` path unchanged) | `test:e2e` |

## Risks

- Portable exe on a machine without WebView2 Runtime needs the bootstrapper
  install (same constraint as tuari's raw-exe distribution; `embedBootstrapper`
  only attaches to NSIS). Document, do not fix here.
- `target/release/resources` must be byte-complete before assembly; validation
  catches a missing `dokan-api.exe` or `ui`.
- Zip via `tar.exe -a` emits DOS-style timestamps inside entries — acceptable
  "deterministic-ish", same as tuari.
- No behavior change in installed mode: marker absent → `%APPDATA%` unchanged.

## Verification (evidence)

`.scratch/reviews/64/<head-sha>-test-audit.md`, `<head-sha>-code-review.md` plus

the full gate command block recorded with exit codes (all green at the final head):

- `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` — 13 pass (11 pre-existing + 2 new portable-detection tests)
- `cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --lib -- -D warnings` — clean
- `bun run typecheck` / `bun run lint` / `bun run test` (turbo) — green (28 desktop tests)
- `DOKAN_PORT=4337 DOKAN_WEB_PORT=5192 bun run test:e2e -- --workers=1` — 18 pass
- `.dokan-port` restored byte-exact (`4317`) after e2e
- Full end-to-end `bun run --filter @dokan/desktop portable` (test secrets) — folder + zip produced; `bundle/` contains only `portable/`

Residual risks (documented, not fixed):

- Portable exe on a machine without WebView2 Runtime needs the bootstrapper install (`embedBootstrapper` attaches to NSIS only).
- Read-only media (write-protected USB) makes the Rust `ensure_dir(data)` fail; the shell logs loudly and the bundled UI's in-app error states cover it.
- No migration path from `%APPDATA%` data to portable `data/` (deliberate: switching modes is a manual folder choice).
- Zip content is only existence/non-empty-verified off Windows (packaging is Windows-only; the zip path is skipIf-gated).

## Exact commands

Portable — folder + zip (default `portable` script):

```
DOKAN_BUILD_SECRET='<unique-per-shop-secret>' \
DOKAN_AUTH_SECRET='<unique-per-shop-signing-secret (>=32 chars)>' \
bun run --filter @dokan/desktop portable
```

Produces (under `apps/desktop/src-tauri/target/release/bundle/portable/`):

- `Dokan-portable/` — `Dokan-portable.exe`, `dokan-api.exe`, `ui/`, `portable.marker`
- `Dokan-portable.zip`

Per-customer installer (nsis, unchanged flow + slug rename):

```
DOKAN_BUILD_SECRET='<unique-per-shop-secret>' \
DOKAN_AUTH_SECRET='<unique-per-shop-signing-secret (>=32 chars)>' \
DOKAN_CUSTOMER_SLUG='shop-slug' \
bun run --filter @dokan/desktop installer
```

Equivalents from the repo root: `bun run desktop:portable` / `bun run desktop:installer`.
Wizard convenience scripts unchanged: `bun run desktop:sidecar`, `bun run build`.