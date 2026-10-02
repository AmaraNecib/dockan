// Sidecar freshness: fingerprint the inputs a compiled sidecar depends on and
// decide whether a staged binary can be reused.
//
// This file is shared two ways: `build.rs` includes it textually, and the
// crate's test build declares it as a `#[cfg(test)] mod` (see lib.rs) so the
// stamp logic is unit-tested by `cargo test` instead of being untestable
// build-script code. (Plain comments, not `//!`: a textually included file
// cannot carry inner doc comments.)
//
// FNV-1a over file names and contents. Missing inputs are part of the
// fingerprint, so a stamp can never match a build made without them. The
// algorithm is not cryptographic — it only needs to detect change, and both
// sides of every comparison are produced locally.
//
// No top-level `use` items on purpose: the file is textually included into
// build.rs, where its imports would merge with (and could clash with) the
// host file's imports.

const FNV_OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;

/// FNV-1a over the contents and names of every input.
pub fn fingerprint(paths: &[std::path::PathBuf]) -> String {
    let mut hash = FNV_OFFSET;
    for path in paths {
        hash_path(&mut hash, path);
    }
    format!("{hash:016x}")
}

/// The stamp value for a set of source inputs and the staged binary bytes.
pub fn stamp_value(sources: &str, sidecar: &std::path::Path) -> String {
    format!("{sources}:{}", fingerprint(&[sidecar.to_path_buf()]))
}

/// True when `stamp_path` holds exactly the `expected` fingerprint. A missing,
/// unreadable, malformed or stale stamp is false.
pub fn stamp_matches(stamp_path: &std::path::Path, expected: &str) -> bool {
    match std::fs::read_to_string(stamp_path) {
        Ok(recorded) => recorded.trim() == expected,
        Err(_) => false,
    }
}

/// Whether a staged sidecar may be reused: it must exist AND its stamp must
/// prove it was compiled from the current sources and bytes. Anything else
/// (missing binary, missing stamp, malformed stamp, changed input) recompiles.
pub fn reuse_staged_sidecar(sidecar_exists: bool, stamp_path: &std::path::Path, expected: &str) -> bool {
    sidecar_exists && stamp_matches(stamp_path, expected)
}

fn hash_path(hash: &mut u64, path: &std::path::Path) {
    let Ok(metadata) = std::fs::metadata(path) else {
        mix(hash, path.to_string_lossy().as_bytes());
        mix(hash, b"<missing>");
        return;
    };
    if metadata.is_dir() {
        mix(hash, path.to_string_lossy().as_bytes());
        let Ok(entries) = std::fs::read_dir(path) else {
            mix(hash, b"<unreadable-dir>");
            return;
        };
        let mut children: Vec<std::path::PathBuf> = entries
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
        match std::fs::File::open(path) {
            Ok(mut file) => {
                use std::io::Read;
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    /// A unique scratch directory per test (tests run in parallel).
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dokan-sidecar-freshness-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("create scratch dir");
        dir
    }

    fn cleanup(dir: &PathBuf) {
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn fingerprint_changes_when_an_input_changes() {
        let dir = scratch("fingerprint-change");
        let input = dir.join("input.ts");
        std::fs::write(&input, "one").expect("write input");
        let before = fingerprint(&[input.clone()]);
        std::fs::write(&input, "two").expect("rewrite input");
        let after = fingerprint(&[input.clone()]);
        assert_ne!(before, after);
        cleanup(&dir);
    }

    #[test]
    fn fingerprint_changes_when_an_input_disappears() {
        let dir = scratch("fingerprint-missing");
        let input = dir.join("input.ts");
        std::fs::write(&input, "present").expect("write input");
        let present = fingerprint(&[input.clone()]);
        std::fs::remove_file(&input).expect("remove input");
        let missing = fingerprint(&[input.clone()]);
        assert_ne!(present, missing);
        cleanup(&dir);
    }

    #[test]
    fn fingerprint_is_stable_for_unchanged_inputs() {
        let dir = scratch("fingerprint-stable");
        let input = dir.join("input.ts");
        std::fs::write(&input, "same").expect("write input");
        assert_eq!(fingerprint(&[input.clone()]), fingerprint(&[input.clone()]));
        cleanup(&dir);
    }

    #[test]
    fn a_missing_stamp_never_matches() {
        let dir = scratch("stamp-missing");
        let stamp = dir.join("sidecar.stamp");
        assert!(!stamp_matches(&stamp, "abc"));
        assert!(!reuse_staged_sidecar(true, &stamp, "abc"));
        cleanup(&dir);
    }

    #[test]
    fn a_malformed_stamp_never_matches() {
        let dir = scratch("stamp-malformed");
        let stamp = dir.join("sidecar.stamp");
        std::fs::write(&stamp, "not-a-stamp").expect("write stamp");
        assert!(!stamp_matches(&stamp, "abc"));
        assert!(!reuse_staged_sidecar(true, &stamp, "abc"));
        cleanup(&dir);
    }

    #[test]
    fn a_mismatched_stamp_never_matches() {
        let dir = scratch("stamp-mismatch");
        let stamp = dir.join("sidecar.stamp");
        std::fs::write(&stamp, "deadbeef:deadbeef").expect("write stamp");
        assert!(!stamp_matches(&stamp, "cafebabe:cafebabe"));
        assert!(!reuse_staged_sidecar(true, &stamp, "cafebabe:cafebabe"));
        cleanup(&dir);
    }

    #[test]
    fn an_exact_stamp_matches_and_reuses() {
        let dir = scratch("stamp-match");
        let stamp = dir.join("sidecar.stamp");
        std::fs::write(&stamp, "abc:def\n").expect("write stamp");
        assert!(stamp_matches(&stamp, "abc:def"));
        assert!(reuse_staged_sidecar(true, &stamp, "abc:def"));
        // a missing binary still forces a compile even with a good stamp
        assert!(!reuse_staged_sidecar(false, &stamp, "abc:def"));
        cleanup(&dir);
    }

    #[test]
    fn stamp_value_pins_the_binary_bytes() {
        let dir = scratch("stamp-binary");
        let binary = dir.join("sidecar.exe");
        std::fs::write(&binary, "first").expect("write binary");
        let first = stamp_value("sources", &binary);
        std::fs::write(&binary, "second").expect("rewrite binary");
        let second = stamp_value("sources", &binary);
        assert_ne!(first, second);
        cleanup(&dir);
    }
}
