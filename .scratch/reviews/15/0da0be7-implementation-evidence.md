# Implementation evidence — Dokan Ticket #15 (desktop packaging)

- Tier: Standard + Rust gates. Base SHA: `9e4e97b` (merge-base with origin/develop).
- Lane: implementation (`feat/15-desktop-packaging`, working tree unpushed).
- Design: `.scratch/implementation/15-design.md`.

## What changed (source only)

| File | Change |
| --- | --- |
| `apps/api/src/main.ts` | boot mkdir for fresh data dir; `DOKAN_PORT_ROOT` redirect for the port record; packaged UI serving behind `DOKAN_WEB_DIST` (static + SPA fallback; api app untouched) |
| `apps/api/src/config.ts` | typed `webDataDir` (`DOKAN_WEB_DIST`) and `portRecordDir` (`DOKAN_PORT_ROOT`) |
| `apps/api/src/config.test.ts` | new — env override reads + dev degradation |
| `apps/desktop/src-tauri/src/desktop.rs` | new — release-only sidecar spawn (CREATE_NO_WINDOW), app-data env, port-file + health probe wait, window navigate, kill-on-exit; 4 unit tests |
| `apps/desktop/src-tauri/src/lib.rs` | builder wiring: state, setup hook, CloseRequested/Exit kill |
| `apps/desktop/src-tauri/tauri.conf.json` | window label, externalBin, resources `ui`, icon list, NSIS currentUser + embedBootstrapper; fixed frontendDist depth |
| `apps/desktop/src-tauri/capabilities/default.json` | new — `core:default` |
| `apps/desktop/src-tauri/icons/*` | generated set from `tools/generate-icon.py` master |
| `apps/desktop/package.json` | `sidecar` + `portable` scripts |
| `package.json` | `desktop:sidecar`, `desktop:portable` passthroughs |
| `.gitignore` | `target/`, `src-tauri/binaries/`, `src-tauri/gen/` |
| `tools/generate-icon.py` | new — reproducible icon master |
| `docs/development-workflow.md` | desktop packaging section |

Not touched: `apps/web/**`, `apps/api/src/app.ts`, `apps/api/src/store/**`,
`apps/api/src/rpc/**`, i18n, `.dokan-port` (restored byte-exact, see below).

## Gates (all run on this worktree)

| Gate | Command | Result |
| --- | --- | --- |
| typecheck | `bun run typecheck` | pass (exit 0) |
| lint | `bun run lint` | pass (exit 0) |
| unit | `bun run test` (api 221 + web) | pass |
| rust unit | `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` | 4 passed |
| rust clippy | `cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --lib -- -D warnings` | pass |
| e2e | `DOKAN_PORT=4329 DOKAN_WEB_PORT=5185 bun run test:e2e --workers=1` | 13 passed |
| `.dokan-port` | baseline `4317` (4 bytes, no EOL) | restored byte-exact (`cmp` clean) |

## Packaging acceptance (produced locally)

1. **Sidecar compiles + bundles + starts on launch.** `bun run --filter @dokan/desktop sidecar`
   → `src-tauri/binaries/dokan-api-x86_64-pc-windows-msvc.exe` (100 MB, runs SQLite
   server). `tauri.conf.json` `externalBin` bundles it; release `dokan.exe`
   spawns it on launch **and the running app verified**: `%APPDATA%/dz.dokan.app`
   created with `dokan.db`, `backups/dokan-2026-08-25.db` (daily backup),
   `logs/…jsonl`, `run/.dokan-port` → `http://127.0.0.1:4318/health` returns
   `{"ok":true,…}`; window title "Dokan" present; graceful WM_CLOSE kills the
   sidecar (verified: 0 sidecars left after close).
2. **Dev mode without the sidecar.** `desktop.rs` skips everything under
   `debug_assertions` (`tauri dev` loads vite devUrl; `bun run dev:api` runs the
   api as today). e2e (dev-shaped) stays green.
3. **Icons.** PIL master → `bunx tauri icon` full set; `icon.ico` (6 sizes)
   embedded via tauri-build; installer + window icon.
4. **NSIS portable installer builds.** `bun run --filter @dokan/desktop portable`
   → `Dokan_0.1.0_x64-setup.exe` (~30 MB) built; NSIS `currentUser` install,
   `embedBootstrapper` WebView2 (downloaded + embedded during build).
5. **App-data placement.** Data/logs/backups live under `%APPDATA%/dz.dokan.app`
   (env `DOKAN_DATA_DIR` / `DOKAN_PORT_ROOT` set by the bootstrap); the install
   folder holds only read-only assets (`dokan.exe`, `dokan-api.exe`, `ui/`).
   API serves the bundled `ui/` only when `DOKAN_WEB_DIST` is set (dev/e2e
   untouched). Root cause fixed: the api never created a fresh data dir
   (`dataDir` + `backups/` mkdir at boot).

## Deferred (documented, per parent scope note)

Fresh-install smoke on a clean PC (login → first sale → backup file exists):
blocked by ticket #11 (receipts) landing. Documented in the design doc.

## Risks carried

- Bun-runtime sidecar ≈ 100 MB → installer ≈ 30 MB compressed. Accepted for a
  kiosk PC.
- Kill is `TerminateProcess` on Windows (hard-crash orphan): next launch probes
  a free port and rewrites the record — self-heals (verified on relaunch).
- Code review / test audit evidence still to be produced by the parent's
  review lane at final HEAD.