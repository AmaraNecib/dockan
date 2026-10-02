# Re-review fixes — PR #117 (round-5 findings on 05986bb, 8 findings)

- Tier: High-assurance. Fixed head: `ccfd747` (round 5, on top of `05986bb`).
- All eight findings fixed; tests added; every fix verified (unit and, where
  possible, end-to-end).

## 1. Commented quotes bypassed the inherited-value guard (secrets.ts:71-75)

`parseEnvValue` now matches Bun 1.4 for a quoted value followed by an inline
comment or trailing junk: it scans to the matching closing quote (`\"` escapes
the next character inside double quotes; the backslash is kept verbatim), takes
the inside, and ignores the rest. Single quotes close at the next `'`.

Tests: `parseEnvFile` cases for `"x" # note`, `'x' # note`, `"a#b"`,
`"a" tail`, `"a\"b" # c`, and `export 'x' # c`. End-to-end: a repo-root `.env`
with `DOKAN_BUILD_SECRET="root-inherited-secret-0001" # note` was ignored by a
slugged build, which stamped the `.env.acme` value `99e04e6d8e03d510`.

## 2. Empty secret silently regenerated (secrets.ts:249-250)

An explicit `DOKAN_X=` and an empty `KEY=` line in the file now fail loudly
(`not set — refusing to ship a default secret`) instead of generating a
replacement, which silently rotated sessions on rebuild.

Tests: explicit-empty env and empty-in-file both throw and leave the file
untouched. End-to-end: `DOKAN_CUSTOMER_SLUG=acme DOKAN_BUILD_SECRET= bun run
desktop:sidecar` exits 1 with that message.

## 3. Loose mode on a complete file (secrets.ts:385)

`ensureReleaseSecrets` now calls `restrictSecretFilePermissions` on the target
file (and the customer-less base for slugged builds) on every read path, before
the values are read — a complete `.env.<slug>` restored with mode 0644 is
tightened even when nothing is generated.

Tests: POSIX-only assertion that a complete 0644 `.env.acme` becomes 0600
without regenerating anything (runs on Linux CI; skipped on Windows).

## 4. Compile lock could go stale during a long compile (sidecar.ts:92)

`compileSidecar` now acquires its per-customer lock with `refreshMs: 30_000`;
the lock's mtime is touched while held, so a long compile is not stolen as
stale. `acquireFileLock` gained the `refreshMs` heartbeat (only refreshes a lock
it still owns).

Test: a held lock with `refreshMs: 25, staleMs: 100` keeps an mtime younger
than the stale window after 250 ms.

## 5. Scoped reuse ignored secret rotation (lib.rs:281-283)

The customer-scoped branch of `decide` now passes the environment secrets to
`is_fresh`, so a rotated `DOKAN_BUILD_SECRET`/`DOKAN_AUTH_SECRET` refuses the
previously stamped binary (the pipeline adopts the resolved values into the
cargo environment).

Tests: matching secrets reuse, absent secrets reuse, rotated build/auth secrets
refuse, and a customer-less preload mismatch refuses. End-to-end: a rotated
build secret with a matching slug exits 101; the matching pair reuses without
recompiling.

## 6. Standalone staging skipped the release lock (sidecar.ts:133-137)

`sidecar.ts main()` wraps `compileSidecar` in `withCheckoutReleaseLock`, so a
standalone staging waits for an in-flight release instead of restaging between
build.rs's validation and the bundler copy. `release.ts`/`build.ts` already
hold the same lock and call `compileSidecar` directly (no reentrancy needed).

End-to-end: while a background process held the release lock for 3 s,
`DOKAN_CUSTOMER_SLUG=acme bun run desktop:sidecar` took 3698 ms (normal compile
is ~0.5 s), proving it waited.

## 7. Turbo cache key omitted the customer env files (turbo.json:3)

`globalDependencies` now lists `apps/desktop/.env` and `apps/desktop/.env.*`.
Verified with `turbo build --dry=json`: turbo hashes both files
(`globalCacheInputs.files`), and appending a comment to `.env.acme` changed
every task hash, including `@dokan/desktop#build` (`023fc90985dd5863` →
`ad1f7c2e21cc14b1`). The file was restored afterwards.

## 8. Fingerprint omitted contracts and bun.lock (sidecar-freshness.ts:76-79, #134)

`source_fingerprint` now covers `apps/api/src`, `apps/api/package.json`,
`packages/contracts/src` and `bun.lock`, with repo-root-relative POSIX paths.
The TS and Rust implementations share the new golden `755844f99e63478f`; the
fixture tree now mirrors the repo layout. `build.rs` also watches
`../../../packages/contracts/src` and `../../../bun.lock`.

Tests: TS and Rust golden fixture, plus contract-content and lockfile
sensitivity in both languages. End-to-end: appending a comment to
`packages/contracts/src/index.ts` made `cargo build` recompile the sidecar, and
restoring it recompiled again.

## Gates on the final HEAD

| Gate | Result |
|---|---|
| `bun run typecheck` | exit 0 |
| `bun run lint` | exit 0 |
| `bun run test` | exit 0 (desktop 87+ tests) |
| `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` | 13 + 12 passed |
| `cargo clippy … --lib -- -D warnings` | exit 0 |
| `cargo clippy … --all-targets -- -D warnings` | exit 0 |
| `cargo clippy …/sidecar-freshness/Cargo.toml --all-targets -- -D warnings` | exit 0 |
| build.rs policy checks (rotation, matching, contract change, commented-quote ambient, empty secret, standalone lock wait, unscoped/wrong-slug/bare-slug/torn-binary refusals) | all as expected |

## Residual risks

- The parser still does not model Bun's multi-line values for an unterminated
  quote; such a file is malformed and the parser keeps it inert.
- `globalDependencies` also matches transient `.env.*.lock`/`.tmp` files; they
  are absent when turbo computes its hash, and a leftover only forces a cache
  miss.
- The POSIX permission assertions are skipped on Windows; they run on Linux CI.
