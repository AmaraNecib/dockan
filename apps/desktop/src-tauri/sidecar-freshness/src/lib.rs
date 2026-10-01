//! Sidecar freshness support for `build.rs` (PR #117 finding 5).
//!
//! `build.rs` must not reuse a staged sidecar just because a `.exe` happens to
//! exist: a stale binary from before an API change (or before the current
//! secrets) must never be bundled. The pipeline (`sidecar.ts`) writes a stamp
//! describing what it compiled; this crate recomputes the same fingerprints and
//! decides whether the staged sidecar is current.
//!
//! The fingerprint format is duplicated by `scripts/sidecar-freshness.ts`;
//! both are pinned to the same golden fixture value by their tests.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

/// Header line of the stamp file; bumped if the format ever changes.
pub const STAMP_VERSION: &str = "dokan-sidecar-stamp v1";

const FNV_OFFSET: u64 = 0xcbf29ce484222325;
const FNV_PRIME: u64 = 0x100000001b3;

fn fnv1a64_from(start: u64, bytes: &[u8]) -> u64 {
    let mut hash = start;
    for &byte in bytes {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

/// FNV-1a 64 of `bytes`.
pub fn fnv1a64(bytes: &[u8]) -> u64 {
    fnv1a64_from(FNV_OFFSET, bytes)
}

/// FNV-1a 64 of `input`, as 16 lower-case hex digits.
pub fn fnv1a64_hex(input: &str) -> String {
    format!("{:016x}", fnv1a64(input.as_bytes()))
}

fn collect_files(dir: &Path, base: &Path, out: &mut Vec<(String, Vec<u8>)>) -> io::Result<()> {
    let mut entries: Vec<_> = fs::read_dir(dir)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let file_type = entry.file_type()?;
        let path = entry.path();
        if file_type.is_dir() {
            collect_files(&path, base, out)?;
        } else if file_type.is_file() {
            let relative = path
                .strip_prefix(base)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            out.push((relative, fs::read(&path)?));
        }
    }
    Ok(())
}

/// Fingerprint of everything that goes into the compiled sidecar: every file
/// under `<api_dir>/src` plus `<api_dir>/package.json`. Paths are relative,
/// POSIX-separated and sorted by UTF-8 bytes; each entry hashes
/// `path \0 content \0`.
pub fn source_fingerprint(api_dir: &Path) -> io::Result<String> {
    let mut entries = Vec::new();
    collect_files(&api_dir.join("src"), api_dir, &mut entries)?;
    let manifest = api_dir.join("package.json");
    if manifest.is_file() {
        entries.push(("package.json".to_string(), fs::read(&manifest)?));
    }
    entries.sort_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));

    let mut hash = FNV_OFFSET;
    for (relative, content) in entries {
        hash = fnv1a64_from(hash, relative.as_bytes());
        hash = fnv1a64_from(hash, &[0]);
        hash = fnv1a64_from(hash, &content);
        hash = fnv1a64_from(hash, &[0]);
    }
    Ok(format!("{hash:016x}"))
}

/// What a staged sidecar was compiled from. Secret values are stored only as
/// fingerprints, never verbatim.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stamp {
    pub customer: Option<String>,
    pub sources: String,
    pub build_secret: Option<String>,
    pub auth_secret: Option<String>,
}

impl Stamp {
    /// Build a stamp: the source fingerprint verbatim, each secret as a hash.
    pub fn new(
        sources: impl Into<String>,
        customer: Option<&str>,
        build_secret: Option<&str>,
        auth_secret: Option<&str>,
    ) -> Self {
        Self {
            customer: customer.map(str::to_string),
            sources: sources.into(),
            build_secret: build_secret.map(fnv1a64_hex),
            auth_secret: auth_secret.map(fnv1a64_hex),
        }
    }

    pub fn render(&self) -> String {
        format!(
            "{STAMP_VERSION}\ncustomer {}\nsources {}\nbuild-secret {}\nauth-secret {}\n",
            self.customer.as_deref().unwrap_or("-"),
            self.sources,
            self.build_secret.as_deref().unwrap_or("-"),
            self.auth_secret.as_deref().unwrap_or("-"),
        )
    }

    pub fn parse(text: &str) -> Option<Self> {
        let mut lines = text.lines();
        if lines.next()? != STAMP_VERSION {
            return None;
        }
        let mut customer = None;
        let mut sources = None;
        let mut build_secret = None;
        let mut auth_secret = None;
        for line in lines {
            let (key, value) = line.split_once(' ')?;
            match key {
                "customer" => customer = secret_value(value),
                "sources" => sources = Some(value.to_string()),
                "build-secret" => build_secret = secret_value(value),
                "auth-secret" => auth_secret = secret_value(value),
                _ => return None,
            }
        }
        Some(Self {
            customer,
            sources: sources?,
            build_secret,
            auth_secret,
        })
    }
}

fn secret_value(value: &str) -> Option<String> {
    if value == "-" {
        None
    } else {
        Some(value.to_string())
    }
}

/// `<sidecar>.stamp`, next to the staged binary (matches `sidecar.ts`).
pub fn stamp_path_for(sidecar: &Path) -> PathBuf {
    let mut name = sidecar
        .file_name()
        .map(|name| name.to_os_string())
        .unwrap_or_default();
    name.push(".stamp");
    sidecar.with_file_name(name)
}

pub fn read_stamp(path: &Path) -> Option<Stamp> {
    fs::read_to_string(path).ok().and_then(|text| Stamp::parse(&text))
}

pub fn write_stamp(path: &Path, stamp: &Stamp) -> io::Result<()> {
    fs::write(path, stamp.render())
}

/// Whether `stamp` still describes the sidecar that this build needs.
///
/// The sources must always match. A secret only has to match when it is
/// present in the build environment: the release pipeline exports the resolved
/// values to the cargo child, so a present value is always authoritative, and
/// an absent one tells cargo nothing.
///
/// This is the low-level check. {@link decide} adds the customer-slug policy
/// that `build.rs` actually applies.
pub fn is_fresh(
    stamp: &Stamp,
    sources_fingerprint: &str,
    build_secret: Option<&str>,
    auth_secret: Option<&str>,
) -> bool {
    if stamp.sources != sources_fingerprint {
        return false;
    }
    if let Some(secret) = build_secret {
        let expected = fnv1a64_hex(secret);
        if stamp.build_secret.as_deref() != Some(expected.as_str()) {
            return false;
        }
    }
    if let Some(secret) = auth_secret {
        let expected = fnv1a64_hex(secret);
        if stamp.auth_secret.as_deref() != Some(expected.as_str()) {
            return false;
        }
    }
    true
}

/// What `build.rs` should do with the staged sidecar.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    /// The stamp proves the staged sidecar belongs to this build.
    Reuse,
    /// Compile the sidecar now (the stamp is absent, stale, or unverifiable).
    Rebuild,
    /// Refuse the build: a slugged build cannot resolve `.env.<slug>` here, so
    /// compiling would inline the wrong customer's secrets.
    Refuse(String),
}

/// The `build.rs` reuse policy.
///
/// Without `DOKAN_CUSTOMER_SLUG`, this is sources + the secrets present in the
/// environment. With a slug, the sidecar is only reusable when the stamp says
/// it was built for that exact customer — `build.rs` cannot read
/// `.env.<slug>`, so anything else must be restamped by `bun run sidecar` or
/// the release pipeline rather than silently compiled with whatever is in the
/// environment (PR #117 findings 1 and 5).
///
/// `stamp` may be `None` (no file / unparsable) and `sources_fingerprint` may
/// be empty if the API tree could not be read; both force a rebuild or a
/// refusal.
pub fn decide(
    stamp: Option<&Stamp>,
    sidecar_present: bool,
    sources_fingerprint: &str,
    customer_slug: Option<&str>,
    build_secret: Option<&str>,
    auth_secret: Option<&str>,
) -> Decision {
    if let Some(slug) = customer_slug {
        if !sidecar_present {
            return Decision::Refuse(format!(
                "no staged sidecar and DOKAN_CUSTOMER_SLUG={slug} is set — run `DOKAN_CUSTOMER_SLUG={slug} bun run sidecar` (or the release pipeline) instead of a bare cargo/tauri build",
            ));
        }
        let current = stamp.filter(|s| {
            !sources_fingerprint.is_empty() && s.sources == sources_fingerprint
        });
        return match current {
            Some(stamp) if stamp.customer.as_deref() == Some(slug) => Decision::Reuse,
            Some(stamp) => Decision::Refuse(format!(
                "the staged sidecar is stamped for customer {}, not {slug} — run `DOKAN_CUSTOMER_SLUG={slug} bun run sidecar` (or the release pipeline) to restamp it",
                stamp.customer.as_deref().unwrap_or("<none>"),
            )),
            None => Decision::Refuse(format!(
                "DOKAN_CUSTOMER_SLUG={slug} is set but build.rs cannot read `.env.{slug}` — run `DOKAN_CUSTOMER_SLUG={slug} bun run sidecar` (or the release pipeline) instead of a bare cargo/tauri build",
            )),
        };
    }

    if !sidecar_present {
        return Decision::Rebuild;
    }
    let Some(stamp) = stamp else {
        return Decision::Rebuild;
    };
    if !is_fresh(stamp, sources_fingerprint, build_secret, auth_secret) {
        return Decision::Rebuild;
    }
    Decision::Reuse
}
