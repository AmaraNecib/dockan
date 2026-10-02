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
//!    compiled from the current API sources, for the same customer, from the
//!    same binary and from the secrets present in this build environment
//!    (PR #117 findings 1, 2, 5). A `.exe` lying around is not evidence of
//!    anything.
//!      - a customer-stamped sidecar is REFUSED by an unscoped build (and by
//!        any other customer): an installer with no slug must never carry a
//!        shop's secrets;
//!      - a build with `DOKAN_CUSTOMER_SLUG` set never falls through to the
//!        compile path — `build.rs` cannot read `.env.<slug>`, so it refuses
//!        and points at `bun run sidecar` / the release pipeline;
//!      - the stamp pins the binary's bytes, so a compile that overwrote only
//!        the executable is detected.
//!
//!    The per-customer secrets (PR #51 findings 2 & 5) are only inlined when
//!    strong `DOKAN_BUILD_SECRET` / `DOKAN_AUTH_SECRET` values are present in
//!    the build environment — this path is for the dev/test gates; the
//!    shippable artifacts come from `bun run portable` / `bun run build`,
//!    which resolve both secrets, stage per customer and stamp the sidecar.
//! 2. Delegate to tauri-build for the app manifest, icons and capabilities.

use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

use dokan_sidecar_freshness::{
    binary_fingerprint, decide, read_stamp, source_fingerprint, stamp_path_for, write_stamp, Decision,
    Stamp,
};

/// Stem of the sidecar file. tauri-build appends `-<target triple>` from
/// `bundle.externalBin`; bun appends the `.exe` suffix on Windows.
const SIDECAR_STEM: &str = "dokan-api";
const MIN_BUILD_SECRET_LEN: usize = 16;
const MIN_AUTH_SECRET_LEN: usize = 32;

/// The staged sidecar as it actually lands on disk, in the same per-customer
/// directory the TS pipeline stages it in. Bun appends the platform executable
/// suffix, so on Windows the file is `<stem>-<triple>.exe` — the bare name
/// never exists, which used to defeat the "already compiled by the pipeline"
/// fast path and silently rebuild it here instead.
fn staged_sidecar(manifest_dir: &Path, customer_slug: Option<&str>) -> PathBuf {
    let file_name = format!(
        "{SIDECAR_STEM}-{}{}",
        env::var("TARGET").unwrap_or_else(|_| "x86_64-pc-windows-msvc".to_string()),
        env::consts::EXE_SUFFIX
    );
    match customer_slug {
        Some(slug) => manifest_dir.join("binaries").join(slug).join(file_name),
        None => manifest_dir.join("binaries").join(file_name),
    }
}

fn main() {
    let manifest_dir = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));

    // These inputs live outside the tauri package, so cargo would not otherwise
    // re-run this script when the API changes (and the freshness check below
    // would never get the chance to see it). Paths are relative to the package
    // root (src-tauri); the API workspace sits at apps/api.
    println!("cargo:rerun-if-changed=../../api/src");
    println!("cargo:rerun-if-changed=../../api/package.json");
    // The sidecar bundles the workspace contracts and the dependency graph in
    // bun.lock; both are part of its fingerprint (issue #134).
    println!("cargo:rerun-if-changed=../../../packages/contracts/src");
    println!("cargo:rerun-if-changed=../../../bun.lock");
    // A different shop's secrets must invalidate the staged sidecar too:
    // without these, cargo would keep a sidecar stamped for the previous
    // customer when only the environment changed.
    println!("cargo:rerun-if-env-changed=DOKAN_BUILD_SECRET");
    println!("cargo:rerun-if-env-changed=DOKAN_AUTH_SECRET");
    // A changed customer selects a different staged sidecar entirely.
    println!("cargo:rerun-if-env-changed=DOKAN_CUSTOMER_SLUG");

    let customer_slug = env::var("DOKAN_CUSTOMER_SLUG")
        .ok()
        .map(|slug| slug.trim().to_string())
        .filter(|slug| !slug.is_empty());

    // A slugged build must come through the pipeline (`release.ts` /
    // `build.ts` / `sidecar.ts`): those pass the matching `--config` override
    // so tauri-build and the bundler read `binaries/<slug>/dokan-api`. Without
    // it a bare `tauri build` would copy the shared default path and either
    // fail or bundle the wrong customer's sidecar.
    if let Some(slug) = &customer_slug {
        let expected = format!("binaries/{slug}/{SIDECAR_STEM}");
        let configured = env::var("TAURI_CONFIG").unwrap_or_default();
        if !configured.contains(&expected) {
            panic!(
                "dokan: DOKAN_CUSTOMER_SLUG={slug} requires the release pipeline (or `tauri build --config` with externalBin `{expected}`); refusing a bare cargo/tauri build"
            );
        }
    }

    let sidecar = staged_sidecar(&manifest_dir, customer_slug.as_deref());
    let repo_root = manifest_dir.join("../../..");
    let sources_fingerprint = match source_fingerprint(&repo_root) {
        Ok(fingerprint) => fingerprint,
        Err(error) => {
            println!(
                "cargo:warning=dokan: could not fingerprint {} ({error}); the sidecar will be rebuilt",
                repo_root.display()
            );
            String::new()
        }
    };
    let binary_fp = binary_fingerprint(&sidecar).unwrap_or_default();

    let build_secret = env::var("DOKAN_BUILD_SECRET")
        .ok()
        .filter(|secret| secret.len() >= MIN_BUILD_SECRET_LEN);
    let auth_secret = env::var("DOKAN_AUTH_SECRET")
        .ok()
        .filter(|secret| secret.len() >= MIN_AUTH_SECRET_LEN);

    // Reuse the staged sidecar only when the stamp proves it belongs to THIS
    // build. A customer-stamped binary is never reused without that customer's
    // slug, and a slugged build never falls through to the compile path (the
    // customer's secrets live in `.env.<slug>`, which this script cannot read).
    let stamp_path = stamp_path_for(&sidecar);
    let stamp = read_stamp(&stamp_path);
    match decide(
        stamp.as_ref(),
        sidecar.is_file(),
        &sources_fingerprint,
        &binary_fp,
        customer_slug.as_deref(),
        build_secret.as_deref(),
        auth_secret.as_deref(),
    ) {
        Decision::Reuse => {
            // `bun run sidecar` / `release.ts` already compiled it WITH the
            // secrets validated and inlined; rebuilding it here would throw
            // that away.
            tauri_build::build();
            return;
        }
        Decision::Refuse(reason) => panic!("dokan: {reason}"),
        Decision::Rebuild => {}
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
    // `build.rs` cannot know about a customer's `.env.<slug>`, so it never
    // claims a customer: only the TS pipeline stamps one (the slug path never
    // reaches this compile branch).
    let compiled_fp = binary_fingerprint(&sidecar).unwrap_or_default();
    let stamp = Stamp::new(
        sources_fingerprint,
        None,
        Some(&compiled_fp),
        build_secret.as_deref(),
        auth_secret.as_deref(),
    );
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
