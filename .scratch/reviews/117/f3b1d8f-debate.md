# Debate evidence — issue 117 (release secrets)

- Tier: **High-assurance** (release credentials / session signing).
- Base: `develop` @ `8579fcf`. PR head repaired: `a798d24`.
- Reviewed commit: `e46ecd1` (round 1). Fixes for the debate: `f3b1d8f` (round 2).
- Roles: independent critic + defender, fresh context, read-only.
- Design: `.scratch/implementation/117-design.md`.

## Verdict

The defender found no blocker and scored every fix as justified (confidence
7–9/10). The critic found no blocker either, but three major (7/10) issues and
one 5/10; the top one was a wrong-secret ship path, and it was real and
reproducible. All must-fix findings were fixed in `f3b1d8f`; two are dismissed
with reasons and the remaining residuals are documented below.

## Critic findings and dispositions

| # | Sev | Finding | Disposition |
|---|---|---|---|
| 1 | 7 | `bun run build` (`bun run sidecar && tauri build`) never adopts the resolved secrets into the sibling `tauri build` process. With a slug, `build.rs` saw the pre-loaded customer-less secrets, treated the slug-stamped sidecar as stale, and recompiled it with the wrong shop's secrets. | **Fixed** — the stamp records the customer slug and `decide()` reuses a slugged sidecar only for the same customer; any other slugged compile path refuses with instructions instead of inlining the wrong secrets. Verified end-to-end: `DOKAN_CUSTOMER_SLUG=acme` + base env secrets now reuses; `beta`/unstamped refuses (exit 101). |
| 2 | 7 | The "base preload is not an override" guard compares Bun's loaded value against `parseEnvFile`, which did not handle single quotes, inline `#` comments, `export`, or CRLF — so a hand-edited base `.env` could pass a shop-A secret as an explicit override for shop B. | **Fixed** — parser now mirrors Bun 1.4 dotenv semantics (probed empirically), and the merge step preserves `export ` and CRLF. Regression test uses a single-quoted `export`ed base file. |
| 3 | 6 | `is_fresh` tolerates an absent secret, so a bare `tauri build` with a shop-A-stamped sidecar and no env reuses it silently. | **Partially fixed / accepted** — slugged builds now must match the stamp's customer; reusing a customer-stamped sidecar without a slug prints `cargo:warning` naming the customer. A bare no-slug build with no env cannot be refused without breaking `cargo test` after a slug pipeline run, and it is the documented test-artifact path. |
| 4 | 5 | Stale-lock stealing could unlink a fresh lock another waiter just created, letting two writers race and rotate the secret. | **Fixed** — re-stat immediately before the unlink; a changed inode/mtime/size aborts the steal. Residual: a sub-microsecond gap between the last stat and the unlink (no portable atomic conditional-unlink), documented in the function. |
| 5 | 4 | `export K=`, CRLF, duplicate keys were invisible to the file layer. | **Fixed** by the same parser/merge work: `export` lines are read and rewritten with the prefix preserved, CRLF is preserved, duplicate keys are all replaced with the new value. |
| 6 | 3 | A symlinked `.env.<slug>` pointing at `.env` defeats the base-leak guard and is silently replaced by a regular file. | **Dismissed** — requires a deliberate local symlink by someone who can already read `.env`; rejecting symlinks would break legitimate shared-secret setups. |
| 7 | 2 | Notes: cwd-derived roots, empty-fingerprint stamp on error, secrets on `--define` argv, crash temp files, dependency graph not fingerprinted. | **Mostly dismissed, one deferred** — argv exposure is the pre-existing `bun build --define` mechanism (out of scope); cwd roots are fixed by the package scripts; temp files are gitignored and crash-only; the empty stamp always forces a rebuild. **Deferred:** `source_fingerprint` covers `api/src` + `api/package.json` but not workspace deps (`packages/contracts`) or `bun.lock`; a direct `cargo build` can reuse a sidecar compiled against older deps. Shipping paths always recompile, so this is a dev/test-only gap. |

## Defender claims accepted

- Per-customer file selection, slug validation, and the base-preload guard are
  the right shape for finding 1.
- `mergeEnvFile` is the correct fix for finding 3 (only generated keys are
  written; everything else survives byte-for-byte).
- The O_EXCL lock + re-read + atomic rename closes finding 4 for the normal
  (non-stale) case; the race test is a real two-process test.
- The stamp design (FNV-1a, hashes only, cross-language golden fixture) is
  correctly pinned: both implementations assert `cc24a8aae6afe5b0` for the same
  fixture and the published FNV vectors.
- `adoptReleaseSecrets` is the keystone for the pipeline path; keep it even
  though the slug-stamp now also guards the slug case.
- `cargo:rerun-if-changed` (API sources) and `cargo:rerun-if-env-changed`
  (secrets + slug) are both required and now present.

## Residual risks (documented, not blocking)

1. **Migration:** a shop previously built from the shared `.env` gets a fresh
   `.env.<slug>` and its sessions die. Unavoidable given the finding; documented
   in `docs/development-workflow.md` with a copy-before-first-build note.
2. **Dependency-graph freshness:** see finding 7; dev/test-only, follow-up.
3. **`is_fresh` absent-secret leniency:** see finding 3.
4. **FNV-1a 64 not collision-resistant:** the stamp writer can already replace
   the binary; low value.
5. **Windows rename over an open file:** fails loudly and cleans up its temp
   file; the release pipeline is the only expected writer.

## Verification (final HEAD `f3b1d8f`)

| Gate | Result |
|---|---|
| `bun run typecheck` | exit 0 |
| `bun run lint` | exit 0 |
| `bun run test` (desktop 78 tests) | exit 0 |
| `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` | 13 + 9 passed |
| `cargo clippy --manifest-path … --lib -- -D warnings` | exit 0 |
| `cargo clippy --manifest-path … --all-targets -- -D warnings` | exit 0 |
| `cargo clippy --manifest-path …/sidecar-freshness/Cargo.toml --all-targets -- -D warnings` | exit 0 |

End-to-end `build.rs` policy checks:

| Scenario | Result |
|---|---|
| slug sidecar stamp + no env | reuse + warning naming the customer |
| slug `acme` + customer-less preloaded secrets (the `bun run build` flow) | reuse, no recompile |
| slug `beta` over an `acme` stamp | refused (exit 101) with restamp instructions |
| slug `acme` over a customer-less stamp | refused (exit 101) |
| API content change | recompile + new stamp |
| same secrets / same API again | reuse |
| different env secrets | recompile with those secrets |
