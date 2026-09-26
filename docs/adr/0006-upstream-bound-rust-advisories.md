# Upstream-bound Rust advisories in the desktop lock

Two advisories in `apps/desktop/src-tauri/Cargo.lock` cannot be cleared from this
repository: `glib 0.18.5` (RUSTSEC-2024-0429) and `block-buffer 0.10.4`
(GHSA-qwgh-2vcv-g2f7). `glib` is blocked behind unreleased upstream GTK3 work.
`block-buffer` is blocked behind tauri's MSRV policy, and the concrete defect that
advisory describes is not present in the 0.10 line that we lock. We accept both as a
tracked residual and revisit them when the triggers below fire, rather than pinning a
version that cannot build or suppressing the findings.

Verified 2026-09-26 on `develop` (`a9d2bca`), rustc 1.88.0, Windows host.

## Baseline scan

`cargo audit` reports no vulnerabilities and seven warnings, of which one is the
`glib` advisory. The other six are `unmaintained` warnings, not advisories, and are out
of scope here.

```
$ cd apps/desktop/src-tauri && cargo audit
    Fetching advisory database from `https://github.com/RustSec/advisory-db.git`
      Loaded 1271 security advisories (from C:\Users\sensei57\.cargo\advisory-db)
    Updating crates.io index
    Scanning Cargo.lock for vulnerabilities (429 crate dependencies)
Crate:     proc-macro-error
Version:   1.0.4
Warning:   unmaintained
Title:     proc-macro-error is unmaintained
...
Crate:     glib
Version:   0.18.5
Warning:   unsound
Title:     Unsoundness in `Iterator` and `DoubleEndedIterator` impls for `glib::VariantStrIter`
Date:      2024-03-30
ID:        RUSTSEC-2024-0429
URL:       https://rustsec.org/advisories/RUSTSEC-2024-0429

warning: 7 allowed warnings found
$ echo $?
0
```

`cargo audit` does not report `block-buffer` at all: the RustSec database has no entry
for it. The finding comes from the GitHub Advisory Database and from Socket, which match
on the version range `block_buffer < 0.12.1`. Raw GitHub API output for both:

```
$ curl -s -H 'Accept: application/vnd.github+json' \
    https://api.github.com/advisories/GHSA-qwgh-2vcv-g2f7
ghsa_id    = "GHSA-qwgh-2vcv-g2f7"
severity   = "medium"
published_at = "2026-08-19T19:15:34Z"
vulnerabilities = [{ package: { ecosystem: "rust", name: "block_buffer" },
                     vulnerable_version_range: "< 0.12.1",
                     first_patched_version: "0.12.1" }]

$ curl -s -H 'Accept: application/vnd.github+json' \
    https://api.github.com/advisories/GHSA-wrw7-89jp-8q8g
ghsa_id    = "GHSA-wrw7-89jp-8q8g"
severity   = "medium"
vulnerabilities = [{ package: { ecosystem: "rust", name: "glib" },
                     vulnerable_version_range: ">= 0.15.0, < 0.20.0",
                     first_patched_version: "0.20.0" }]
```

## `glib` 0.18.5 — RUSTSEC-2024-0429 / GHSA-wrw7-89jp-8q8g

Unsound `Iterator` and `DoubleEndedIterator` impls for `glib::VariantStrIter`.
Marked `informational = "unsound"`, not a CVE. Patched upstream in `>=0.20.0`.

The Linux GTK3 stack pins `glib ^0.18` throughout, and `^0.18` is
semver-incompatible with 0.20 and later:

```
$ cargo update -p glib --precise 0.22.10 --dry-run
error: failed to select a version for the requirement `glib = "^0.18"`
candidate versions found which didn't match: 0.22.10
location searched: crates.io index
required by package `gtk v0.18.2`
    ... which satisfies dependency `gtk = "^0.18"` (locked to 0.18.2) of package `tauri v2.11.5`
    ... which satisfies dependency `tauri = "^2"` (locked to 2.11.5) of package `dokan v0.1.0`
$ echo $?
101
```

`cargo update --dry-run` moves 51 packages and none of them are `glib`, `gtk`,
`webkit2gtk`, `wry`, `tao`, `muda`, or `libappindicator`:

```
$ cargo update --dry-run | grep -Ei "glib|gtk|webkit|wry|tao |muda|sha2|digest|block-buffer"
$ echo $?
1
```

`--precise 0.20.0` fails identically to `--precise 0.22.10`.

### Reachability

`glib` is not compiled for the Windows target this app ships. `cargo tree -i glib`
on the host prints `nothing to print`; the graph only appears under `--target all`,
rooted at `gtk 0.18.2` via `muda 0.19.3`, `tao 0.35.3`, `webkit2gtk 2.0.2`,
`wry 0.55.1` and the `tauri-runtime*` crates.

The unsound API is also never constructed by anything we link. `VariantStrIter` is
built by exactly one function, `glib::Variant::array_iter_str()`, and a source grep
across the sources of every GTK3-stack crate in the lock returns nothing outside
`glib` itself. Run in a scratch directory holding the unpacked `.crate` sources listed
below:

```
$ grep -rln "array_iter_str\|VariantStrIter" --include=*.rs .
glib-0.18.5/src/lib.rs
glib-0.18.5/src/variant.rs
glib-0.18.5/src/variant_iter.rs
$ cd <repo> && grep -rn "glib\|Variant\|sha2\|block_buffer" apps/desktop/src-tauri/src apps/desktop/src-tauri/build.rs
    (none)
```

Crates searched: `gtk 0.18.2`, `gdk 0.18.2`, `gdk-pixbuf 0.18.5`, `gdkx11 0.18.2`,
`gio 0.18.4`, `atk 0.18.2`, `pango 0.18.3`, `cairo-rs 0.18.5`,
`javascriptcore-rs 1.1.2`, `soup3 0.5.0`, `webkit2gtk 2.0.2`,
`libappindicator 0.9.0`, `tao 0.35.3`, `muda 0.19.3`, `wry 0.55.1`,
`tauri 2.11.5`, `tauri-runtime 2.11.3`, `tauri-runtime-wry 2.11.4`.

### Upstream status, and why the blocker moved

When this was first investigated the conclusion was that nothing consumed
`gtk 0.19.0`. That is no longer true, so this ADR supersedes it. As of 2026-09-26 the
GTK3 line is being migrated by upstream, in this order:

| Component | Newest | Requirement | Status |
|---|---|---|---|
| `gtk3-rs` (the `gtk` crate) | **0.19.0**, 2026-09-08 | `glib ^0.22`, MSRV 1.92 | released |
| `javascriptcore-rs` | **2.0.0**, 2026-09-22 | `glib ^0.22` | released |
| `webkit2gtk` | 2.0.2, 2025-12-16 | `gtk ^0.18`, `javascriptcore-rs ==1.1` | PR #166 open, `mergeable_state: clean`; PR #165 will cut 3.0.0 |
| `webkit2gtk-sys` | 2.0.2 | — | same as above |
| `tao` | 0.37.1 | `gtk ^0.18` | PR #1332 open |
| `muda` | 0.20.0 | `gtk ^0.18` | PR #403 open |
| `wry` | 0.57.0 | `gtk ^0.18`, `webkit2gtk ==2.0.2` | no gtk 0.19 PR |
| `tauri` | 2.11.6 | `gtk ^0.18`, `muda ^0.19`, `webkit2gtk ^2` | no gtk 0.19 PR; GTK4 tracked for v3 |

Repositories: `gtk-rs/gtk3-rs` (archived in 2024, un-archived and taken over by
`kelnos` in 2026-08), `tauri-apps/webkit2gtk-rs`, `tauri-apps/javascriptcore-rs`.
Upstream requirements read from the crates.io dependency API per version, not from
release notes.

Two things still stand in the way after `webkit2gtk 3.0.0` ships:

1. `tauri` has to move to `gtk 0.19` and `webkit2gtk 3`, and it has no PR for that yet.
2. `gtk 0.19.0` and `glib 0.22.10` declare MSRV **1.92** and edition 2024.
   `tauri 2.11.6` declares MSRV **1.77.2**. Our installed toolchain is rustc 1.88.0,
   so a hand-pin could not be built here even if one resolved.

## `block-buffer` 0.10.4 — GHSA-qwgh-2vcv-g2f7

The advisory says a caught panic can leave the cursor position of `EagerBuffer` or
`ReadBuffer` corrupted, which allows out-of-bounds reads and writes. Fixed in
`>=0.12.1`, no backport to 0.10 or 0.11.

The version is held by a chain we cannot shorten, and this one *is* built on Windows:

```
$ cargo tree -e normal -i block-buffer
block-buffer v0.10.4
└── digest v0.10.7
    └── sha2 v0.10.9
        └── tauri-codegen v2.6.3
            └── tauri-macros v2.6.3 (proc-macro)
                └── tauri v2.11.5
                    └── dokan v0.1.0

$ cargo update -p block-buffer --precise 0.12.1 --dry-run
error: failed to select a version for the requirement `block-buffer = "^0.10"`
candidate versions found which didn't match: 0.12.1
location searched: crates.io index
required by package `digest v0.10.7`
    ... which satisfies dependency `digest = "^0.10.7"` (locked to 0.10.7) of package `sha2 v0.10.9`
    ... which satisfies dependency `sha2 = "^0.10"` (locked to 0.10.9) of package `tauri-codegen v2.6.3`
    ... which satisfies dependency `tauri-codegen = "^2.6.3"` (locked to 2.6.3) of package `tauri-macros v2.6.3`
    ... which satisfies dependency `tauri-macros = "^2.6.3"` (locked to 2.6.3) of package `tauri v2.11.5`
$ echo $?
101
```

`tauri-codegen 2.6.3` and `tauri-codegen 3.0.0-alpha.1` both still require
`sha2 ^0.10`; `sha2` 0.11.0 is the first release on `digest ^0.11`, and `digest 0.11.1`
is the first on `block-buffer ^0.12`. Adding `sha2 = 0.11` to `dokan` would only add a
second copy to the graph and leave 0.10.4 in place, and `[patch]` cannot satisfy a
`^0.10` requirement.

### The locked version does not have the defect

`block-buffer 0.12.x` stores the cursor *inside* the block. `Eager::Pos` is `()`, and
`get_pos`/`set_pos` read and write the last byte of the block itself
(`block-buffer-0.12.1/src/sealed.rs`). `digest_blocks` therefore writes input over its
own cursor before calling `compress`, and a panic there leaves the cursor byte
attacker-influenced.

`block-buffer 0.10.4` has no in-block cursor. Its cursor is an ordinary struct field:

```rust
// block-buffer-0.10.4/src/lib.rs
pub struct BlockBuffer<BlockSize, Kind> {
    buffer: Block<BlockSize>,
    pos: u8,
    _pd: PhantomData<Kind>,
}
```

`get_pos` reads that field and nothing else, and every path that writes it does so
after checking `Kind::invariant`, so no panic inside `compress` can put `pos` out of
range. The corrupt state the advisory describes is not representable in this layout.

A four-way probe over the same catch-the-panic sequence, run in each version's own
scratch crate, shows this directly. The assertion is the eager invariant `pos < 4`;
in debug builds an invariant violation trips `debug_assert!(false)` in `get_pos`, and
in release builds the same branch is the `unreachable_unchecked()` the advisory calls
out.

```
########## block-buffer 0.10.4 ##########
   observed pos after caught panic = 2 (block size 4)
test result: ok. 1 passed; 0 failed

########## block-buffer 0.11.0 ##########
thread 'panic_in_compress_keeps_cursor_valid' panicked at
  block-buffer-0.11.0\src\lib.rs:240:13: assertion failed: false
test result: FAILED

########## block-buffer 0.12.0 ##########
thread 'panic_in_compress_keeps_cursor_valid' panicked at
  block-buffer-0.12.0\src\lib.rs:233:13: assertion failed: false
test result: FAILED

########## block-buffer 0.12.1 ##########
   observed pos after caught panic = 0 (block size 4)
test result: ok. 1 passed; 0 failed
```

So the advisory is real for 0.11.0 and 0.12.0, fixed in 0.12.1, and **not applicable to
the 0.10.4 we lock**. The `< 0.12.1` range is a blanket range across a rewrite, not a
statement about the 0.10 implementation.

The probe is one test file run once per version in its own scratch crate, since Cargo
unifies the two `0.12.x` versions into one:

```rust
// Cargo.toml: block-buffer = "=<version>"
use block_buffer::EagerBuffer;
use block_buffer::array::typenum::U4; // 0.10.4: block_buffer::generic_array::typenum::U4

#[test]
fn panic_in_compress_keeps_cursor_valid() {
    let mut buf = EagerBuffer::<U4>::new(&[1, 2]);
    let caught = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        buf.digest_blocks(&[3, 4, 5], |_| panic!("simulated compression failure"));
    }));
    assert!(caught.is_err(), "compress should have panicked");
    let pos = buf.get_pos();
    assert!(pos < 4, "eager invariant violated: pos={pos} is not < block size 4");
}
```

This does not make the scanner finding go away: GitHub and Socket match on version
range, so 0.10.4 keeps being flagged. It does mean there is no memory-safety work to do
in this repository for it.

### Upstream status

The blocker is tauri's MSRV policy, not the crates. `sha2 0.11.0` and
`block-buffer 0.12.1` require rustc 1.85 and edition 2024; `tauri-codegen 2.6.3`
declares MSRV 1.77.2. Renovate opened the bump and tauri closed it:

```
tauri-apps/tauri PR #15168 "chore(deps): update rust crate sha2 to 0.11"
closed 2026-03-28, not merged
  Legend-Master 2026-03-28: "MSRV too high"
  renovate[bot] 2026-03-28: "Because you closed this PR without merging, Renovate will
    ignore this update (0.11). You will get a PR once a newer version is released."

tauri-apps/wry PR #1702 "chore(deps): update rust crate sha2 to 0.11"
closed 2026-03-25, not merged
```

`wry` also requires `sha2 ^0.10`, but only under `cfg(target_os = "android")` in both
0.55.1 and 0.57.0, so on the desktop targets the built consumer of `sha2` is
`tauri-codegen` alone. `wry 0.57.0` is already at MSRV 1.85 and could take `sha2 0.11`;
`tauri-codegen 2.6.3` is at 1.77.2 and is the one holding the version back.

## What would unblock this

**`glib`:** `webkit2gtk 3.0.0` and `webkit2gtk-sys 3.0.0` released (tauri-apps/webkit2gtk-rs
PR #165), then `wry`, `tao`, `muda` and `tauri` releases that accept `gtk 0.19` and
`webkit2gtk 3`, plus a decision from tauri that MSRV 1.92 and edition 2024 are
acceptable. The downstream work would then be a `cargo update`.

**`block-buffer`:** nothing, for this repository. A `tauri-codegen` release on
`sha2 0.11`/`digest 0.11`, or `sha2 0.12` once released, would clear the scanner
finding. Given the 0.10.4 probe above, we do not need it.

## Revisit triggers

Revisit this ADR when any of these happens, and re-run `cargo audit` and the two
`cargo update --precise` probes above:

1. `webkit2gtk` 3.x appears on crates.io.
2. A `tauri`, `wry`, `tao` or `muda` release takes `gtk 0.19` or `webkit2gtk 3`.
3. A `tauri-codegen` release takes `sha2 0.11` or later.
4. Next scheduled review: 2026-12-31.

If a gate ever runs `cargo audit` with warnings denied, record the residual as a dated
allowlist entry in `apps/desktop/src-tauri/audit.toml` pointing back at this ADR,
instead of letting the build fail or the ignore go undocumented.

## Consequences

- Two advisories stay visible in Socket and GitHub alerting until upstream ships. That
  is expected and tracked here, not silently tolerated.
- We do not ship a `[patch.crates-io]` fork of `glib`: it is not compiled on the target
  we ship, `gtk 0.18.2` would need rewriting against a semver-incompatible `glib`, and
  the result could not be built or tested on this host.
- `cargo update` stays routine. Both residuals are pinned by dependency requirements
  rather than by a deliberate hold, so ordinary updates cannot regress them.

Status: accepted. Decided during issue #81; supersedes the "nothing depends on
`gtk 0.19.0`" note in that issue, which upstream has since invalidated.
