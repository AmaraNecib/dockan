# Code Review — issue 64 (portable build)

**Tier:** Standard · **Base:** `ffe5cf6` · **Reviewed head:** `2e9be9b8`
**Diff:** `git diff ffe5cf6...2e9be9b8`
**Commits:** `aef13f8` initial · `c478565e` flat-layout fix · `36be366e`
review fixes · `2e9be9b8` win32 preflight + design backfill

## Standards

_Hard violations fixed during the loop:_ evidence files (this one +
`2e9be9b8-test-audit.md`) now exist per `docs/engineering-workflow.md`, and the
working tree is clean (`git status --short` empty — the earlier spurious
`Cargo.toml` modification was byte-identical line-ending noise and restored).

_Judgement calls (accepted,_ labelled):
- Commit `aef13f8` says `fix(64)` on a feature-shaped change; branch is
  `fix/64-portable-mode` and the change repairs the owner-facing portable
  command, so `fix` is consistent with the branch. Note only.
- No Playwright E2E added: this is a packaging pipeline, not a user-facing
  flow; dev mode is provably untouched. Scope-appropriate.
- Duplicated `[dokan] portable … ready at` log lines between `portable.mjs`
  `import.meta.main` and `release.ts::buildPortable` (two entry points);
  `PORTABLE_MARKER`/`Dokan-portable` literals are inherently cross-language
  (Rust + JS) with cross-referenced doc comments.
- `validateReleaseArtifacts`'s overridable `expectedFiles`/`expectedDirs`
  defaults are exercised only as defaults (kept as the tuari-mirroring testability
  seam); `resolveTrustedTarPath` DI seams are test-used.
- `-new` fallback broadly catches any `rmSync(portableDir)` failure as “locked”;
  mirrors tuari, documented.
- Residual risk from the standards review: `$1` `-new` base name and zip name
  are derived rather than stored, so they cannot drift.

_Not present:_ Mysterious Name, Feature Envy, Data Clumps, Repeated Switches,
Message Chains, Middle Man, Refused Bequest (final-round scan).

## Spec

All four brief requirements confirmed implemented, with the real build as
attestation:
1. **Rust detection** — `portable.marker` (empty file, `is_file()`-checked,
   directory-named-marker can't flip) next to `current_exe()` ⇒
   `data_dir = <exe-dir>/data`, `port_root = data/run`; absent ⇒ `%APPDATA%`
   unchanged; reserve-port/boot-token/registry verification untouched.
2. **portable.mjs** — assembles `bundle/portable/Dokan-portable/`
   (`Dokan-portable.exe` byte-copy + `dokan-api.exe` + `ui/` + marker) and
   `Dokan-portable.zip` via System32 `tar -a -c -f` (tuari style); prints
   final paths. NSIS is **avoided** (`tauri build --no-bundle`; verified
   `bundle/` contains only `portable/`, no `*setup.exe`) and a stale
   `bundle/nsis` from an earlier installer run is deleted.
3. **Wiring** — desktop scripts `portable` (default; secrets → sidecar →
   `--no-bundle` → assemble) and `installer` (`--installer` → nsis + slug);
   root `desktop:portable` / `desktop:installer`. Unknown flags fail loudly;
   non-Windows preflight before the multi-minute build.
4. **DOKAN_DATA_DIR** — carries the resolved (exe-adjacent in portable mode)
   path; api derives sqlite/backups/logs/port records from it unchanged.

**Scope note:** `-new` locked-folder fallback + zip-follows-folder naming is
beyond the literal brief but mirrors tuari, tested, and prevents a stale
canonical folder from being overwritten mid-run. `--portable` explicit flag
symmetry is deliberate and documented.

_Commands: `bun test` 28/28 desktop; `cargo test` 13/13; `cargo clippy … -D
warnings` clean; typecheck + lint + turbo test green; e2e 18/18; real
end-to-end portable build green (folder + 41.8MB zip; `bundle/portable/`
listing verified: `Dokan-portable.exe`, `dokan-api.exe`, `ui/` with real
assets, empty `portable.marker`)._

**Verdict per axis:** Standards — one judgement call remains (log-line
duplication across two entry points); worst item minor. Spec — no missing or
wrong behavior; no blockers on either axis.