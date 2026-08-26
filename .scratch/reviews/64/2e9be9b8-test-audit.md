# Test Audit — issue 64 (portable build)

**Tier:** Standard · **Base:** `ffe5cf6` · **Reviewed head:** `2e9be9b8`
**Diff:** `git diff ffe5cf6...2e9be9b8` (apps/desktop/src-tauri/src/desktop.rs,
apps/desktop/scripts/{portable.mjs, script-security-utils.mjs, release.ts,
portable.test.ts}, package.json wiring, .scratch/implementation/64-design.md)

Three audit rounds (3 specialized sub-agents each responsive round: edge-case
hunter, coverage analyst, quality reviewer). Fixed during the loop:
unknown-flag rejection, zero-byte/wrong-type/empty-`ui` artifact guards, `-new`
zip naming, staging-dir cleanup + pid-unique temp name, byte-identical exe
copy assertion, win32 preflight, stale-`bundle/nsis` removal, exception-safe
scoped cleanup.

## Coverage vs acceptance criteria — all satisfied

| Criterion | Evidence |
|---|---|
| Rust detection: marker ⇒ `<exe-dir>/data` + `data/run`; absent ⇒ `%APPDATA%`; TOCTOU untouched | `runtime_data_dir_is_exe_adjacent_when_the_portable_marker_sits_next_to_the_exe`, `…_falls_back_to_the_os_app_data_dir_without_the_marker` (incl. marker-as-directory must not flip). TOCTOU/registry/health pre-existing tests intact. `cargo test` 13/13 |
| Folder assembly: exe+sidecar+ui+marker, no `setup.exe` | `portable.test.ts` happy path: renamed exe present, source name absent, deep-copied ui, EMPTY marker (`size === 0`), byte-identical exe copy (source survives), `walkNames` finds no `setup.exe`, no `.tmp-` staging leftover; build outputs (deps/, .pdb, .cargo-lock) never shipped |
| Fail-loud guards | missing sidecar/exe, zero-byte sidecar/exe, sidecar-as-directory, empty `ui/`, unknown CLI flags |
| Dispatch | default portable, `--installer`, explicit `--portable` wins, unknown flags throw |
| Zip | real run on win32: exists + non-empty, name follows the folder incl. `-new` (`outputNames`/`zipPathFor`) |
| e2e | 18/18 green at base-equivalent dev mode (desktop dev path untouched: `cfg!(debug_assertions)` early return) |

## Residual risks (documented, not auto-tested)

- Empty `ui/` guard checks top-level only; a pathological `ui/` containing only
  an empty subdir could slip (real web builds always emit index.html).
- `-new` fallback is unit-tested via `outputNames`; the OS-lock `rmSync`-throws
  path is not integration-exercisable (Bun's rmSync ignores open-handle locks).
- Env-glue line (`DOKAN_DATA_DIR` = resolved path) and `runTauri` CLI args are
  not mocked; covered by the real end-to-end portable build + e2e.
- Zip contents only existence/non-empty-verified off Windows (`skipIf`); the
  win32 CI lane exercises it for real.

## Test-quality verdict

Grade **A** (final round) with one demonstrated mutation fix: the folder test
now asserts the source exe survives AND the portable exe is byte-identical, so
a rename-vs-copy regression fails. Cleanup hygiene is guarded: every scratch
dir is asserted to be a direct child of `os.tmpdir()` before deletion, and
cleanup runs in `finally`. Suite avoids the bun-1.3.14 Windows hang by never
passing the skip-callback to `it()` alongside junction fs ops.

_Commands: `bun test` (desktop) 28 pass / 0 fail, 127 expects; `cargo test
--manifest-path apps/desktop/src-tauri/Cargo.toml` 13 pass; e2e 18 pass;
full end-to-end `bun run --filter @dokan/desktop portable` produced the folder
+ 41.8MB zip and `bundle/` contained only `portable/`._