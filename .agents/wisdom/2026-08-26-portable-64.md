# Wisdom: portable packaging — Windows/Tauri/Bun traps

## tauri-build 2.6.x copies resources FLAT into target/release, not a resources/ subdir

`tauri build` lays out `target/release/dokan.exe` + `target/release/dokan-api.exe`
(sidecar) + `target/release/ui/` (the resources map) — there is NO
`target/release/resources/` folder on this toolchain (the sibling tuari project
had one, so "mirror the sibling" will mislead you). With `tauri build
--no-bundle` the copy still happens and no installer is produced; `--bundles
none` is NOT accepted by @tauri-apps/cli 2.11.4 (possible values: msi, nsis).
**Always verify the real artifact layout with an actual end-to-end build before
finalizing a packaging script** — the first real run caught this mismatch that
no unit test could.

## bun test 1.3.14 on Windows hangs when a test takes the skip-callback and does junction fs ops

A test written `it("…", (test) => { symlinkSync(…, "junction"); … })` runs its
body to completion and then the RUNNER hangs forever even though the same body
passes as a plain script and as a `() =>` test. The `(test)` callback +
junction interplay deadlocks finalization. Fix: never pass the callback to
`it()`; use `it.skipIf(condition)(...)` / `describe.skipIf(...)` for
conditional skips, and handle environmental EPERM with a logged early return.

## Never `rmSync(dirname(dirname(child)))` in test cleanup

`mkdtempSync` under `os.tmpdir()` returns a DIRECT child of the temp root;
`dirname(dirname(that))` climbs to `os.tmpdir()` itself — a test cleanup bug
tried to recursively delete the whole system temp folder (EBUSY, minutes-long
hang, and your test looks like it's the hang). Pattern: keep the scoped root
from `mkdtempSync` explicitly, assert `path.dirname(scoped) === os.tmpdir()`
before deleting, delete only that, and assert it's gone.

## Resource-map + external-bin layout changes with the tauri version; assert, don't assume

resources map `{"../../apps/web/dist": "ui"}` yields `target/release/ui/…`
walked; the sidecar lands as `target/release/dokan-api.exe` (triple suffix
stripped). The Rust side needs no change for portable: on Windows
`resource_dir()` == the exe's folder, so sidecar + ui resolve next to the exe
automatically; only `app_data_dir()` needs the portable override.