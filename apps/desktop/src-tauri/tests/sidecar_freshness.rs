//! Freshness tests for the sidecar stamp (PR #117 findings 1 and 5).
//!
//! `golden_fixture_fingerprint_matches_the_typescript_implementation` pins the
//! Rust fingerprint to the exact value the TS implementation asserts for the
//! same fixture; if either side drifts, one of the two tests fails.

use std::fs;
use std::path::{Path, PathBuf};

use dokan_sidecar_freshness::{
    decide, fnv1a64_hex, is_fresh, read_stamp, source_fingerprint, stamp_path_for, write_stamp, Decision,
    Stamp,
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
fn fnv1a64_matches_published_vectors() {
    assert_eq!(fnv1a64_hex(""), "cbf29ce484222325");
    assert_eq!(fnv1a64_hex("a"), "af63dc4c8601ec8c");
    assert_eq!(fnv1a64_hex("foobar"), "85944171f73967e8");
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
fn stamp_round_trips_and_never_stores_raw_secrets() {
    let stamp = Stamp::new(
        "0123456789abcdef",
        Some("acme"),
        Some("build-secret-0123456789"),
        Some("auth-secret-0123456789-0123456789"),
    );
    let text = stamp.render();
    assert!(text.starts_with("dokan-sidecar-stamp v1\n"));
    assert!(text.contains("customer acme\n"));
    assert!(text.contains("sources 0123456789abcdef\n"));
    assert!(!text.contains("build-secret-0123456789"));
    assert!(!text.contains("auth-secret-0123456789"));
    assert_eq!(Stamp::parse(&text), Some(stamp));
    assert_eq!(Stamp::parse("some other file"), None);

    // a customer-less stamp renders "-" and parses back to None
    let neutral = Stamp::new("fp", None, Some("build"), None);
    assert!(neutral.render().contains("customer -\n"));
    assert_eq!(Stamp::parse(&neutral.render()).unwrap().customer, None);
}

#[test]
fn stamp_files_round_trip_next_to_the_sidecar() {
    let dir = std::env::temp_dir().join(format!("dokan-stamp-io-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let sidecar = dir.join("dokan-api-x86_64-pc-windows-msvc.exe");
    let stamp = Stamp::new("fp", None, Some("build"), None);

    assert_eq!(stamp_path_for(&sidecar), dir.join("dokan-api-x86_64-pc-windows-msvc.exe.stamp"));
    write_stamp(&stamp_path_for(&sidecar), &stamp).unwrap();
    assert_eq!(read_stamp(&stamp_path_for(&sidecar)), Some(stamp));
    assert_eq!(read_stamp(&dir.join("missing.stamp")), None);
}

#[test]
fn freshness_requires_matching_sources_and_any_present_secret() {
    let stamp = Stamp::new("sources-fp", None, Some("build"), Some("auth"));

    assert!(is_fresh(&stamp, "sources-fp", None, None));
    assert!(is_fresh(&stamp, "sources-fp", Some("build"), Some("auth")));
    assert!(!is_fresh(&stamp, "other-fp", Some("build"), Some("auth")));
    assert!(!is_fresh(&stamp, "sources-fp", Some("other"), Some("auth")));
    assert!(!is_fresh(&stamp, "sources-fp", Some("build"), Some("other")));
    // a secret absent from the environment imposes no constraint
    assert!(is_fresh(&stamp, "sources-fp", None, Some("auth")));
    assert!(is_fresh(&stamp, "sources-fp", Some("build"), None));
}

#[test]
fn a_secret_less_stamp_is_stale_once_a_secret_appears_in_the_environment() {
    let stamp = Stamp::new("fp", None, None, None);
    assert!(is_fresh(&stamp, "fp", None, None));
    assert!(!is_fresh(&stamp, "fp", Some("build"), None));
    assert!(!is_fresh(&stamp, "fp", None, Some("auth")));
}

#[test]
fn decide_reuses_only_a_current_stamp_without_a_customer() {
    let stamp = Stamp::new("sources-fp", None, Some("build"), Some("auth"));

    assert_eq!(decide(Some(&stamp), true, "sources-fp", None, None, None), Decision::Reuse);
    assert_eq!(
        decide(Some(&stamp), true, "sources-fp", None, Some("build"), Some("auth")),
        Decision::Reuse
    );
    // a changed API forces a rebuild
    assert_eq!(decide(Some(&stamp), true, "other-fp", None, None, None), Decision::Rebuild);
    // different secrets force a rebuild (they will be re-inlined)
    assert_eq!(
        decide(Some(&stamp), true, "sources-fp", None, Some("other"), None),
        Decision::Rebuild
    );
    // no sidecar file or no stamp forces a rebuild
    assert_eq!(decide(Some(&stamp), false, "sources-fp", None, None, None), Decision::Rebuild);
    assert_eq!(decide(None, true, "sources-fp", None, None, None), Decision::Rebuild);
    assert_eq!(decide(None, true, "", None, None, None), Decision::Rebuild);
}

#[test]
fn decide_reuses_a_slugged_stamp_only_for_that_same_customer() {
    let acme = Stamp::new("sources-fp", Some("acme"), Some("build"), Some("auth"));

    assert_eq!(
        decide(Some(&acme), true, "sources-fp", Some("acme"), None, None),
        Decision::Reuse
    );
    // the environment may hold the customer-less preload; the stamp wins
    assert_eq!(
        decide(Some(&acme), true, "sources-fp", Some("acme"), Some("base"), Some("base-auth")),
        Decision::Reuse
    );

    // another customer, a customer-less stamp, a stale source tree or no stamp
    // at all must refuse rather than compile with the wrong secrets
    assert!(matches!(
        decide(Some(&acme), true, "sources-fp", Some("beta"), None, None),
        Decision::Refuse(_)
    ));
    assert!(matches!(
        decide(Some(&acme), true, "other-fp", Some("acme"), None, None),
        Decision::Refuse(_)
    ));
    assert!(matches!(
        decide(None, true, "sources-fp", Some("acme"), None, None),
        Decision::Refuse(_)
    ));
    assert!(matches!(
        decide(Some(&acme), false, "sources-fp", Some("acme"), None, None),
        Decision::Refuse(_)
    ));
}
