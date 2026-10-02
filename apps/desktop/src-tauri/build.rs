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

use std::env;
use std::fs::{self, File};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Relative to `CARGO_MANIFEST_DIR` (src-tauri). Bun appends the platform
/// executable suffix; tauri-build's `externalBin` resolves the same name.
const SIDECAR_NAME: &str = "dokan-api-x86_64-pc-windows-msvc";

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

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
    println!("cargo:rerun-if-changed=../../../bun.lock");
    // Replacing the staged binary (e.g. the release pipeline just compiled it)
    // must invalidate the stamp, so track the binary itself too.
    println!("cargo:rerun-if-changed={}", sidecar.display());

    let input_paths = [
        manifest_dir.join("../../api/src"),
        manifest_dir.join("../../api/package.json"),
        manifest_dir.join("../../../packages/contracts/src"),
        manifest_dir.join("../../../bun.lock"),
    ];
    let sources = fingerprint(&input_paths);
    let stamp_path = sidecar.with_extension("stamp");

    if sidecar.is_file() {
        let recorded = fs::read_to_string(&stamp_path).unwrap_or_default();
        if recorded.trim() == format!("{sources}:{}", fingerprint(&[sidecar.clone()])) {
            tauri_build::build();
            return;
        }
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

    // Record the sources and the compiled bytes so the next run can trust the
    // staged sidecar; a failed stamp write only costs a recompile.
    let stamp = format!("{sources}:{}", fingerprint(&[sidecar.clone()]));
    if let Err(error) = fs::write(&stamp_path, stamp) {
        println!("cargo:warning=dokan: could not write the sidecar freshness stamp ({error}); the next build will recompile the sidecar");
    }

    tauri_build::build();
}

/// FNV-1a over the contents and names of every input. Missing inputs are part
/// of the fingerprint, so a stamp can never match a build made without them.
fn fingerprint(paths: &[PathBuf]) -> String {
    let mut hash = FNV_OFFSET;
    for path in paths {
        hash_path(&mut hash, path);
    }
    format!("{hash:016x}")
}

fn hash_path(hash: &mut u64, path: &Path) {
    let Ok(metadata) = fs::metadata(path) else {
        mix(hash, path.to_string_lossy().as_bytes());
        mix(hash, b"<missing>");
        return;
    };
    if metadata.is_dir() {
        mix(hash, path.to_string_lossy().as_bytes());
        let Ok(entries) = fs::read_dir(path) else {
            mix(hash, b"<unreadable-dir>");
            return;
        };
        let mut children: Vec<PathBuf> = entries
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .collect();
        children.sort();
        for child in children {
            hash_path(hash, &child);
        }
        return;
    }
    if metadata.is_file() {
        mix(hash, path.to_string_lossy().as_bytes());
        match File::open(path) {
            Ok(mut file) => {
                let mut buffer = [0u8; 64 * 1024];
                loop {
                    match file.read(&mut buffer) {
                        Ok(0) => break,
                        Ok(read) => mix(hash, &buffer[..read]),
                        Err(_) => {
                            mix(hash, b"<unreadable>");
                            break;
                        }
                    }
                }
            }
            Err(_) => mix(hash, b"<unreadable>"),
        }
    }
}

fn mix(hash: &mut u64, bytes: &[u8]) {
    for byte in bytes {
        *hash ^= u64::from(*byte);
        *hash = hash.wrapping_mul(FNV_PRIME);
    }
}
