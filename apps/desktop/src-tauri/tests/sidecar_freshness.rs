//! Freshness tests for the sidecar stamp (PR #117 findings 1, 2 and 5).
//!
//! `golden_fixture_fingerprint_matches_the_typescript_implementation` pins the
//! Rust fingerprint to the exact value the TS implementation asserts for the
//! same fixture; if either side drifts, one of the two tests fails.

use std::fs;
use std::path::{Path, PathBuf};

use dokan_sidecar_freshness::{
    binary_fingerprint, decide, fnv1a32_hex, fnv1a64_hex, is_fresh, read_stamp, source_fingerprint,
    stamp_path_for, write_stamp, Decision, Stamp,
};

fn fixture_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../scripts/__fixtures__/api-fingerprint")
}

fn temp_api_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("dokan-sidecar-freshness-{}-{name}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(dir.join("src")).unwrap();
    dir
}

#[test]
fn fnv_vectors_match_published_values() {
    assert_eq!(fnv1a64_hex(""), "cbf29ce484222325");
    assert_eq!(fnv1a64_hex("a"), "af63dc4c8601ec8c");
    assert_eq!(fnv1a64_hex("foobar"), "85944171f73967e8");
    assert_eq!(fnv1a32_hex(""), "811c9dc5");
    assert_eq!(fnv1a32_hex("a"), "e40c292c");
    assert_eq!(fnv1a32_hex("foobar"), "bf9cf968");
}

#[test]
fn golden_fixture_fingerprint_matches_the_typescript_implementation() {
    assert_eq!(source_fingerprint(&fixture_dir()).unwrap(), "cc24a8aae6afe5b0");
}

#[test]
fn fingerprint_changes_with_source_content_and_the_package_manifest() {
    let dir = temp_api_dir("changes");
    fs::write(dir.join("package.json"), "{\"name\":\"fixture\"}\n").unwrap();
    fs::write(dir.join("src/main.ts"), "export const x = 1;\n").unwrap();
    let before = source_fingerprint(&dir).unwrap();

    fs::write(dir.join("src/main.ts"), "export const x = 2;\n").unwrap();
    let after_edit = source_fingerprint(&dir).unwrap();
    assert_ne!(before, after_edit);

    fs::write(dir.join("src/main.ts"), "export const x = 1;\n").unwrap();
    assert_eq!(source_fingerprint(&dir).unwrap(), before);

    fs::write(dir.join("package.json"), "{\"name\":\"fixture\",\"version\":\"2\"}\n").unwrap();
    assert_ne!(source_fingerprint(&dir).unwrap(), before);
}

#[test]
fn binary_fingerprint_matches_the_typescript_golden_and_sees_rewrites() {
    let dir = temp_api_dir("binary");
    let binary = dir.join("sidecar.exe");
    fs::write(&binary, b"binary-bytes").unwrap();
    // the same literal is asserted by sidecar-freshness.test.ts
    assert_eq!(binary_fingerprint(&binary).unwrap(), "f44e0ab6");

    fs::write(&binary, b"other-bytes").unwrap();
    assert_ne!(binary_fingerprint(&binary).unwrap(), "f44e0ab6");
}

#[test]
fn stamp_round_trips_and_never_stores_raw_secrets() {
    let stamp = Stamp::new(
        "0123456789abcdef",
        Some("acme"),
        Some("f44e0ab6"),
        Some("build-secret-0123456789"),
        Some("auth-secret-0123456789-0123456789"),
    );
    let text = stamp.render();
    assert!(text.starts_with("dokan-sidecar-stamp v1\n"));
    assert!(text.contains("customer acme\n"));
    assert!(text.contains("sources 0123456789abcdef\n"));
    assert!(text.contains("binary f44e0ab6\n"));
    assert!(!text.contains("build-secret-0123456789"));
    assert!(!text.contains("auth-secret-0123456789"));
    assert_eq!(Stamp::parse(&text), Some(stamp));
    assert_eq!(Stamp::parse("some other file"), None);

    // a customer-less stamp renders "-" and parses back to None
    let neutral = Stamp::new("fp", None, Some("00000000"), Some("build"), None);
    assert!(neutral.render().contains("customer -\n"));
    assert_eq!(Stamp::parse(&neutral.render()).unwrap().customer, None);
}

#[test]
fn stamp_files_round_trip_next_to_the_sidecar() {
    let dir = std::env::temp_dir().join(format!("dokan-stamp-io-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let sidecar = dir.join("dokan-api-x86_64-pc-windows-msvc.exe");
    let stamp = Stamp::new("fp", None, Some("deadbeef"), Some("build"), None);

    assert_eq!(stamp_path_for(&sidecar), dir.join("dokan-api-x86_64-pc-windows-msvc.exe.stamp"));
    write_stamp(&stamp_path_for(&sidecar), &stamp).unwrap();
    assert_eq!(read_stamp(&stamp_path_for(&sidecar)), Some(stamp));
    assert_eq!(read_stamp(&dir.join("missing.stamp")), None);
}

#[test]
fn freshness_requires_matching_sources_binary_and_any_present_secret() {
    let stamp = Stamp::new("sources-fp", None, Some("bin-fp"), Some("build"), Some("auth"));

    assert!(is_fresh(&stamp, "sources-fp", "bin-fp", None, None));
    assert!(is_fresh(&stamp, "sources-fp", "bin-fp", Some("build"), Some("auth")));
    assert!(!is_fresh(&stamp, "other-fp", "bin-fp", Some("build"), Some("auth")));
    // a replaced binary invalidates the stamp even when the sources match
    assert!(!is_fresh(&stamp, "sources-fp", "other-fp", None, None));
    assert!(!is_fresh(&stamp, "sources-fp", "", None, None));
    assert!(!is_fresh(&stamp, "sources-fp", "bin-fp", Some("other"), Some("auth")));
    assert!(!is_fresh(&stamp, "sources-fp", "bin-fp", Some("build"), Some("other")));
    // a secret absent from the environment imposes no constraint
    assert!(is_fresh(&stamp, "sources-fp", "bin-fp", None, Some("auth")));
    assert!(is_fresh(&stamp, "sources-fp", "bin-fp", Some("build"), None));
}

#[test]
fn decide_rebuilds_a_customer_less_build_over_a_stale_stamp() {
    let stamp = Stamp::new("sources-fp", None, Some("bin-fp"), Some("build"), Some("auth"));

    assert_eq!(
        decide(Some(&stamp), true, "sources-fp", "bin-fp", None, None, None),
        Decision::Reuse
    );
    assert_eq!(
        decide(Some(&stamp), true, "sources-fp", "bin-fp", None, Some("build"), Some("auth")),
        Decision::Reuse
    );
    // a changed API, a replaced binary or different secrets force a rebuild
    assert_eq!(
        decide(Some(&stamp), true, "other-fp", "bin-fp", None, None, None),
        Decision::Rebuild
    );
    assert_eq!(
        decide(Some(&stamp), true, "sources-fp", "other-fp", None, None, None),
        Decision::Rebuild
    );
    assert_eq!(
        decide(Some(&stamp), true, "sources-fp", "bin-fp", None, Some("other"), None),
        Decision::Rebuild
    );
    // no sidecar file or no stamp forces a rebuild
    assert_eq!(
        decide(Some(&stamp), false, "sources-fp", "bin-fp", None, None, None),
        Decision::Rebuild
    );
    assert_eq!(decide(None, true, "sources-fp", "bin-fp", None, None, None), Decision::Rebuild);
}

#[test]
fn decide_refuses_to_leak_a_customer_sidecar_into_an_unscoped_build() {
    let acme = Stamp::new("sources-fp", Some("acme"), Some("bin-fp"), Some("build"), Some("auth"));

    // the whole point: an NSIS installer with no slug must not carry a shop's
    // credentials, even when every fingerprint matches
    assert!(matches!(
        decide(Some(&acme), true, "sources-fp", "bin-fp", None, None, None),
        Decision::Refuse(_)
    ));
    assert!(matches!(
        decide(Some(&acme), true, "sources-fp", "bin-fp", None, Some("build"), Some("auth")),
        Decision::Refuse(_)
    ));
}

#[test]
fn decide_reuses_a_slugged_stamp_only_for_that_same_customer_and_binary() {
    let acme = Stamp::new("sources-fp", Some("acme"), Some("bin-fp"), Some("build"), Some("auth"));

    assert_eq!(
        decide(Some(&acme), true, "sources-fp", "bin-fp", Some("acme"), None, None),
        Decision::Reuse
    );
    // the environment may hold the customer-less preload; the stamp wins
    assert_eq!(
        decide(Some(&acme), true, "sources-fp", "bin-fp", Some("acme"), Some("base"), Some("base-auth")),
        Decision::Reuse
    );

    // another customer, a torn binary, a stale source tree or no stamp at all
    // must refuse rather than compile with the wrong secrets
    assert!(matches!(
        decide(Some(&acme), true, "sources-fp", "bin-fp", Some("beta"), None, None),
        Decision::Refuse(_)
    ));
    assert!(matches!(
        decide(Some(&acme), true, "sources-fp", "other-bin", Some("acme"), None, None),
        Decision::Refuse(_)
    ));
    assert!(matches!(
        decide(Some(&acme), true, "other-fp", "bin-fp", Some("acme"), None, None),
        Decision::Refuse(_)
    ));
    assert!(matches!(
        decide(None, true, "sources-fp", "bin-fp", Some("acme"), None, None),
        Decision::Refuse(_)
    ));
    assert!(matches!(
        decide(Some(&acme), false, "sources-fp", "bin-fp", Some("acme"), None, None),
        Decision::Refuse(_)
    ));
}
