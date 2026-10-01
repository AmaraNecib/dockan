# Issue 117 — release secrets: fix six Greptile findings

- Tier: **High-assurance** (release credentials / session signing).
- Branch: `fix/117-secrets`. Base: `develop` @ `8579fcf`. PR head under repair: `a798d24`.
- Scope: `apps/desktop/scripts/{secrets,secret-rules,secrets-cli,sidecar,release}.ts`,
  `apps/desktop/src-tauri/build.rs`, a new `src-tauri/sidecar-freshness` support
  crate, tests, `docs/development-workflow.md`, `.gitignore`.

## Findings and the chosen fix

| # | Finding | Fix |
|---|---|---|
| 1 | Two shops built from one checkout share `.env` secrets; the slug only renames the installer | Per-customer secret files: `.env` for the customer-less build, `.env.<slug>` for a slugged build. A value preloaded by `bun run` from the base `.env` is not an override for a different customer. |
| 2 | `mode: 0o600` only applies on create; a pre-existing world-readable file keeps its mode | `chmod 0o600` the existing file before writing, create the temp file 0o600, and `rename` it into place. |
| 3 | Rewriting on partial generation re-serialises existing lines and changes quoted values | Line-preserving merge: only the generated key's line is written; every other byte of the file survives. |
| 4 | Two concurrent first-time generations rotate secrets | Exclusive lock file (`O_EXCL`) around generation; re-read under the lock; atomic rename so readers never see a partial file. |
| 5 | `build.rs` reuses any staged sidecar, even a stale one | A sidecar stamp records FNV-1a-64 fingerprints of the API sources + both inlined secrets. Both `sidecar.ts` and `build.rs` write/verify it; reuse only when sources (and, when known from the env, secrets) match. |
| 6 | Headers/comments describe the removed "missing secret is fatal" behaviour | Rewrite the `sidecar.ts` / `release.ts` headers and the release docs. |

## Public API (scripts)

`secrets.ts`

```ts
ensureReleaseSecrets({
  env?,               // default process.env
  envDir?,            // default process.cwd()
  envFilePath?,       // explicit file (tests / callers that know better)
  customerSlug?,      // default env.DOKAN_CUSTOMER_SLUG; validated [a-z0-9][a-z0-9-]*
  generate?,
  lockWaitMs?, lockRetryMs?, lockStaleMs?,   // test seams
}): ResolvedReleaseSecrets   // + envFilePath
```

- Target path: explicit `envFilePath` > `envDir/.env.<slug>` (slug) > `envDir/.env`.
- Precedence per key: explicit env value that differs from every file value →
  stored value in the target file → generated + persisted.
- `baseStored` (from `.env`) only matters for a slugged build; it stops a
  `bun run`-preloaded base value from leaking into a customer build.
- Exports kept: `generateSecret`, `parseEnvFile`, `renderEnvFile`,
  `RELEASE_ENV_*`. New: `releaseEnvPathFor(slug?)`, `releaseEnvHeader(slug?)`,
  `mergeEnvFile(text, values)`, `customerSlugFromEnv` is not exported
  (`customerSlug` stays in `release.ts`).

`sidecar-freshness.ts` (new TS module)

- `fnv1a64Hex(input)` — FNV-1a 64, 16 lowercase hex digits.
- `sidecarSourceFingerprint(apiDir)` — files under `apiDir/src` plus
  `apiDir/package.json`, relative paths POSIX-separated, sorted by UTF-8 bytes,
  hashed as `path \0 content \0` per entry.
- `sidecarStampPath(sidecarPath)` → `<sidecarPath>.stamp`.
- `writeSidecarStamp(apiDir, sidecarPath, buildSecret, authSecret)`.

`sidecar.ts`

- `compileSidecar(buildSecret, authSecret)` writes the stamp after a
  successful compile. `main()` resolves per-slug secrets from the env.

## Rust support crate

`apps/desktop/src-tauri/sidecar-freshness/` (lib, no tauri deps):

- Same FNV-1a 64 + source fingerprint spec as the TS module.
- `Stamp` parse/render (`dokan-sidecar-stamp v1` + `sources/build-secret/auth-secret` lines).
- `is_fresh(stamp, sourcesFp, envBuild?, envAuth?)` — sources must always match;
  a secret only has to match when it is present in the build environment.
- `write_stamp` / `read_stamp`.

`build.rs`

- Adds `cargo:rerun-if-changed=../api/src` and `../api/package.json`.
- Reuses the staged sidecar only when `is_fresh` accepts it; otherwise compiles
  (with any strong env secrets) and rewrites the stamp.
- No more "any staged `.exe` wins".

## Tests (all new/updated)

- `secrets.test.ts`: distinct secrets per slug; base-file preload is not an
  override; genuine override still wins and is not persisted; quote/trailing-
  space line preserved across partial generation; no rewrite when nothing is
  missing; permissions (POSIX assert + read-only-file recovery); two-process
  race converges on one secret set; stale lock stolen; lock timeout; invalid
  slug rejected; `--customer` CLI writes the per-customer file.
- `sidecar-freshness.test.ts`: FNV known vector; fingerprint determinism and
  sensitivity; stamp round-trip; golden fingerprint shared with the Rust test.
- `sidecar_freshness.rs` (integration): same golden fingerprint; freshness
  matrix (fresh, sources changed, secret mismatch/absent, missing stamp).
- `pipeline.test.ts`: release main still exits 1 on a weak explicit secret and
  now on an invalid slug.

## Round 2 (debate fixes)

- The sidecar stamp now records the **customer slug**, and `build.rs` applies a
  fail-closed policy through `dokan_sidecar_freshness::decide`: a build with
  `DOKAN_CUSTOMER_SLUG` set reuses only a sidecar stamped for that customer and
  otherwise refuses (it cannot read `.env.<slug>`, so compiling would inline
  the pre-loaded customer-less values). `cargo:rerun-if-env-changed` covers
  both secrets and the slug.
- `parseEnvFile`/`mergeEnvFile` now mirror Bun's dotenv rules (single quotes,
  inline `#` comments, `export `, CRLF) so the base-file preload guard cannot
  mistake those forms for an explicit override.
- Stale-lock stealing re-checks the lock's identity immediately before the
  unlink, so two waiters cannot both steal and overwrite each other's fresh
  lock.

## Risks / notes

- **Pipeline env adoption:** `release.ts` exports the resolved secrets into the
  tauri/cargo child after resolving them (`adoptReleaseSecrets`). Without this,
  `bun run`'s pre-load of the customer-less `.env` would make `build.rs` see a
  different customer's secrets and rebuild the sidecar with them. `build.rs`
  also registers both secrets with `cargo:rerun-if-env-changed` so a direct
  build with different secrets can never reuse the previous shop's sidecar.
- **Migration:** a shop that previously used the shared `.env` for a slugged
  installer gets a fresh `.env.<slug>` on first run; its old sessions die. That
  is the security fix (a shared value cannot be safely attributed to one shop).
  Docs tell the vendor to copy the old values into `.env.<slug>` when migrating.
- **Locking:** stale lock stolen after 60 s; generation is milliseconds, so a
  60 s pause means a crashed process.
- **Cross-language fingerprint:** both implementations are pinned by the same
  golden hex in TS and Rust tests; any drift fails a gate.
- `.gitignore`: add `.env.*` so per-customer files can never be committed.
