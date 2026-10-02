//! Build script. Two jobs:
//!
//! 1. Ensure the API sidecar binary exists and is fresh (ADR-0008 §5).
//!    tauri-build hard-fails when `bundle.externalBin` is missing, so a clean
//!    checkout must be able to run `cargo build` / `cargo test` /
//!    `cargo clippy` / `tauri build` without a manual sidecar step. A staged
//!    sidecar is reused only when a freshness stamp proves it was compiled
//!    from the current API and contract sources and from the same binary
//!    bytes; cargo would not otherwise re-run this script when the API
//!    changes, so those inputs are declared with `rerun-if-changed` too.
//!    One universal build: no secret is baked in — the session-signing secret
//!    is generated at first run and lives in the database.
//! 2. Delegate to tauri-build for the app manifest, icons and capabilities.
//!
//! The fingerprint/stamp logic lives in `src/sidecar_freshness.rs`, shared
//! with the crate's test build so `cargo test` covers it.

include!("src/sidecar_freshness.rs");

use std::env;
use std::fs;
use std::path::PathBuf;
use std::process::Command;

/// Relative to `CARGO_MANIFEST_DIR` (src-tauri). Bun appends the platform
/// executable suffix; tauri-build's `externalBin` resolves the same name.
const SIDECAR_NAME: &str = "dokan-api-x86_64-pc-windows-msvc";

fn main() {
    let manifest_dir = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let sidecar = manifest_dir
        .join("binaries")
        .join(format!("{SIDECAR_NAME}{}", env::consts::EXE_SUFFIX));

    // The sidecar's inputs live outside this package; without these cargo
    // would never re-run this script when the API changes.
    println!("cargo:rerun-if-changed=../../api/src");
    println!("cargo:rerun-if-changed=../../api/package.json");
    println!("cargo:rerun-if-changed=../../../packages/contracts/src");
    // the contracts package.json carries the exports map the sidecar bundles
    println!("cargo:rerun-if-changed=../../../packages/contracts/package.json");
    println!("cargo:rerun-if-changed=../../../bun.lock");
    // the root tsconfig feeds the API build (paths/options)
    println!("cargo:rerun-if-changed=../../../tsconfig.base.json");
    // Replacing the staged binary (e.g. the release pipeline just compiled it)
    // must invalidate the stamp, so track the binary itself too.
    println!("cargo:rerun-if-changed={}", sidecar.display());

    let input_paths = [
        manifest_dir.join("../../api/src"),
        manifest_dir.join("../../api/package.json"),
        manifest_dir.join("../../../packages/contracts/src"),
        manifest_dir.join("../../../packages/contracts/package.json"),
        manifest_dir.join("../../../bun.lock"),
        manifest_dir.join("../../../tsconfig.base.json"),
    ];
    let sources = fingerprint(&input_paths);
    let stamp_path = sidecar.with_extension("stamp");
    let expected = stamp_value(&sources, &sidecar);

    if reuse_staged_sidecar(sidecar.is_file(), &stamp_path, &expected) {
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
    let status = cmd.status().unwrap_or_else(|err| {
        panic!("could not run `bun build --compile` for the api sidecar ({err}); install bun or run `bun run sidecar` manually first")
    });
    assert!(status.success(), "sidecar compile failed with status {status}");

    // Record the sources and the COMPILED bytes so the next run can trust the
    // staged sidecar; a failed stamp write only costs a recompile.
    let compiled = stamp_value(&sources, &sidecar);
    if let Err(error) = fs::write(&stamp_path, compiled) {
        println!("cargo:warning=dokan: could not write the sidecar freshness stamp ({error}); the next build will recompile the sidecar");
    }

    tauri_build::build();
}
