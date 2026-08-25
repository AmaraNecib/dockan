//! Build script. Two jobs:
//!
//! 1. Ensure the API sidecar binary exists (PR #51 finding 3). tauri-build
//!    hard-fails when `bundle.externalBin` is missing, so a clean checkout
//!    must be able to run `cargo build` / `cargo test` / `cargo clippy` /
//!    `tauri build` without a manual sidecar step. When the configured binary
//!    is absent, compile it first via the same command the pipeline uses.
//!
//!    The per-customer build secret (PR #51 finding 2) is ONLY inlined when a
//!    strong `DOKAN_BUILD_SECRET` is present in the build environment — this
//!    path is for the dev/test gates; the shippable artifacts come from
//!    `bun run portable` / `bun run build`, which validate the secret and
//!    refuse to build without one.
//! 2. Delegate to tauri-build for the app manifest, icons and capabilities.

use std::env;
use std::path::PathBuf;
use std::process::Command;

/// Relative to `CARGO_MANIFEST_DIR` (src-tauri). Bun appends the `.exe`
/// suffix on Windows; tauri-build's `externalBin` resolves the same name.
const SIDECAR_NAME: &str = "dokan-api-x86_64-pc-windows-msvc";
const MIN_SECRET_LEN: usize = 16;

fn main() {
    let manifest_dir = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let sidecar = manifest_dir.join("binaries").join(SIDECAR_NAME);
    if sidecar.is_file() {
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

    let mut reason = "no DOKAN_BUILD_SECRET in the build environment (test artifact, not for distribution)";
    if let Ok(secret) = env::var("DOKAN_BUILD_SECRET") {
        if secret.len() >= MIN_SECRET_LEN {
            cmd.arg(format!("--define=process.env.DOKAN_BUILD_SECRET={}", js_string(&secret)));
            reason = "per-customer DOKAN_BUILD_SECRET inlined";
        }
    }
    // PRINT is the build-script status channel: a loud warning so a sidecar
    // built for the gates is never mistaken for a shippable artifact.
    println!("cargo:warning=dokan: sidecar compiled without a release secret ({reason}) — cargo-built artifacts are for tests only; ship via `bun run portable`");

    let status = cmd.status().unwrap_or_else(|err| {
        panic!("could not run `bun build --compile` for the api sidecar ({err}); install bun or run `bun run sidecar` manually first")
    });
    assert!(status.success(), "sidecar compile failed with status {status}");
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