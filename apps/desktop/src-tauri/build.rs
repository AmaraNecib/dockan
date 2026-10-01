//! Build script. Two jobs:
//!
//! 1. Ensure the API sidecar binary exists (PR #51 finding 3). tauri-build
//!    hard-fails when `bundle.externalBin` is missing, so a clean checkout
//!    must be able to run `cargo build` / `cargo test` / `cargo clippy` /
//!    `tauri build` without a manual sidecar step. When the configured binary
//!    is absent — or stale — compile it first via the same command the
//!    pipeline uses.
//!
//!    A staged sidecar is reused ONLY when its freshness stamp proves it was
//!    compiled from the current API sources and from the secrets present in
//!    this build environment (PR #117 finding 5). A `.exe` lying around is not
//!    evidence of anything.
//!
//!    The per-customer secrets (PR #51 findings 2 & 5) are only inlined when
//!    strong `DOKAN_BUILD_SECRET` / `DOKAN_AUTH_SECRET` values are present in
//!    the build environment — this path is for the dev/test gates; the
//!    shippable artifacts come from `bun run portable` / `bun run build`,
//!    which resolve both secrets and stamp the sidecar.
//! 2. Delegate to tauri-build for the app manifest, icons and capabilities.

use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

use dokan_sidecar_freshness::{
    is_fresh, read_stamp, source_fingerprint, stamp_path_for, write_stamp, Stamp,
};

/// Relative to `CARGO_MANIFEST_DIR` (src-tauri). Bun appends the `.exe`
/// suffix on Windows; tauri-build's `externalBin` resolves the same name.
const SIDECAR_NAME: &str = "dokan-api-x86_64-pc-windows-msvc";
const MIN_BUILD_SECRET_LEN: usize = 16;
const MIN_AUTH_SECRET_LEN: usize = 32;

/// The staged sidecar as it actually lands on disk. Bun appends the platform
/// executable suffix, so on Windows the file is `<SIDECAR_NAME>.exe` — the
/// bare name never exists, which used to defeat the "already compiled by the
/// pipeline" fast path below and silently rebuild it here instead.
fn staged_sidecar(manifest_dir: &Path) -> PathBuf {
    manifest_dir
        .join("binaries")
        .join(format!("{SIDECAR_NAME}{}", env::consts::EXE_SUFFIX))
}

fn main() {
    let manifest_dir = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));

    // These inputs live outside the tauri package, so cargo would not otherwise
    // re-run this script when the API changes (and the freshness check below
    // would never get the chance to see it). Paths are relative to the package
    // root (src-tauri); the API workspace sits at apps/api.
    println!("cargo:rerun-if-changed=../../api/src");
    println!("cargo:rerun-if-changed=../../api/package.json");
    // A different shop's secrets must invalidate the staged sidecar too:
    // without these, cargo would keep a sidecar stamped for the previous
    // customer when only the environment changed.
    println!("cargo:rerun-if-env-changed=DOKAN_BUILD_SECRET");
    println!("cargo:rerun-if-env-changed=DOKAN_AUTH_SECRET");

    let sidecar = staged_sidecar(&manifest_dir);
    let api_dir = manifest_dir.join("../..").join("api");
    let sources_fingerprint = match source_fingerprint(&api_dir) {
        Ok(fingerprint) => fingerprint,
        Err(error) => {
            println!(
                "cargo:warning=dokan: could not fingerprint {} ({error}); the sidecar will be rebuilt",
                api_dir.display()
            );
            String::new()
        }
    };

    let build_secret = env::var("DOKAN_BUILD_SECRET")
        .ok()
        .filter(|secret| secret.len() >= MIN_BUILD_SECRET_LEN);
    let auth_secret = env::var("DOKAN_AUTH_SECRET")
        .ok()
        .filter(|secret| secret.len() >= MIN_AUTH_SECRET_LEN);

    // Reuse the staged sidecar only when its stamp proves it belongs to THIS
    // build: the API sources must match, and any secret supplied in the
    // environment must be the one already inlined.
    let stamp_path = stamp_path_for(&sidecar);
    let sidecar_is_current = !sources_fingerprint.is_empty()
        && sidecar.is_file()
        && read_stamp(&stamp_path)
            .map(|stamp| {
                is_fresh(
                    &stamp,
                    &sources_fingerprint,
                    build_secret.as_deref(),
                    auth_secret.as_deref(),
                )
            })
            .unwrap_or(false);
    if sidecar_is_current {
        // `bun run sidecar` / `release.ts` already compiled it WITH the secrets
        // validated and inlined; rebuilding it here would throw that away.
        tauri_build::build();
        return;
    }

    // The outfile is passed without extension: bun appends the platform
    // executable suffix. cwd = apps/desktop so the relative input path
    // (../api/src/main.ts) matches the pipeline scripts.
    let mut cmd = Command::new("bun");
    cmd.args(["build", "--compile", "../api/src/main.ts", "--outfile"]);
    cmd.arg(&sidecar);
    cmd.current_dir(manifest_dir.join(".."));

    // Track both secrets so the status line can tell a shippable sidecar from a
    // test one. The previous wording always claimed "without a release secret"
    // even when both were inlined, which read as a failure on a good build.
    if let Some(secret) = &build_secret {
        cmd.arg(format!(
            "--define=process.env.DOKAN_BUILD_SECRET={}",
            js_string(secret)
        ));
    }
    // PR #51 finding 5: session signing is per-customer too — inline the
    // auth secret exactly like the build secret when a strong value is
    // supplied; the packaged-boot guard in main.ts refuses a binary whose
    // signing secret stayed at the shared dev sentinel.
    if let Some(secret) = &auth_secret {
        cmd.arg(format!(
            "--define=process.env.DOKAN_AUTH_SECRET={}",
            js_string(secret)
        ));
    }

    // PRINT is the build-script status channel. Both secrets inlined is the
    // shippable case; anything else is a test artifact and says so loudly.
    match (build_secret.is_some(), auth_secret.is_some()) {
        (true, true) => println!(
            "cargo:warning=dokan: sidecar compiled with both per-customer secrets inlined (shippable)"
        ),
        (build_inlined, auth_inlined) => {
            let missing = match (build_inlined, auth_inlined) {
                (true, false) => "DOKAN_AUTH_SECRET",
                (false, true) => "DOKAN_BUILD_SECRET",
                _ => "DOKAN_BUILD_SECRET / DOKAN_AUTH_SECRET",
            };
            println!("cargo:warning=dokan: sidecar compiled without {missing} — cargo-built artifacts are for tests only; ship via `bun run portable`");
        }
    }

    let status = cmd.status().unwrap_or_else(|err| {
        panic!("could not run `bun build --compile` for the api sidecar ({err}); install bun or run `bun run sidecar` manually first")
    });
    assert!(status.success(), "sidecar compile failed with status {status}");

    // Record what this sidecar was built from so the next run can trust it.
    let stamp = Stamp::new(sources_fingerprint, build_secret.as_deref(), auth_secret.as_deref());
    if let Err(error) = write_stamp(&stamp_path, &stamp) {
        println!(
            "cargo:warning=dokan: could not write the sidecar freshness stamp ({error}); the next build will recompile the sidecar"
        );
    }

    tauri_build::build();
}

/// Render a Rust string as a double-quoted JavaScript string literal for the
/// `--define` value (no serde dependency in build-dependencies).
fn js_string(value: &str) -> String {
    let mut out = String::from("\"");
    for ch in value.chars() {
        match ch {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}
