# Re-review fixes — PR #117 (findings on 9d3505c)

- Tier: High-assurance. Fixed head: `2a64c8b` (round 3, on top of `9d3505c`).
- Four re-review findings, all fixed; verification is end-to-end, not just unit.

## Findings and dispositions

### 1. P1 — unscoped build could reuse a customer sidecar (lib.rs:266-269)

`decide` now returns `Refuse` (not a warning) when the staged sidecar is
customer-stamped and the build has no `DOKAN_CUSTOMER_SLUG`; a slugged build
already refused a different/absent slug. Rust tests cover both the unscoped
refusal and the slugged matrix, and the message tells the operator to set the
slug or restage customer-less.

Verified: copying an acme stamp over the default path and running a plain
`cargo build` fails with exit 101 and
"the staged sidecar is stamped for customer acme — an unscoped build must not
reuse it".

### 2. P1 — one staged sidecar path; binary/stamp could tear (sidecar.ts:72-75)

- Each customer stages in `src-tauri/binaries/<slug>/`; the customer-less build
  keeps `src-tauri/binaries/`.
- The stamp now records an FNV-1a-32 hash of the binary (`binary <hex>`), so a
  compile that overwrote only the executable is detected.
- `compileSidecar` holds a per-customer lock across the binary write and the
  stamp write.
- `release.ts`, the new `scripts/build.ts` and `build.rs` point the bundler at
  the per-customer path with
  `tauri build --config '{"bundle":{"externalBin":["binaries/<slug>/dokan-api"]}}'`.
  `build.rs` refuses a slugged build that did not receive that override.
- Cross-language tests pin the same FNV-1a-32 vectors and the same file-hash
  golden (`f44e0ab6` for "binary-bytes") in TS and Rust.

Verified: a torn pair (stamp kept, binary appended to) is refused with exit 101
and "missing or does not match its stamp"; a full
`DOKAN_CUSTOMER_SLUG=acme bun run build` compiles
`binaries/acme/dokan-api-…exe` and `target/release/dokan-api.exe` hashes to the
same acme binary (`cb97159d`), while the shared default binary is `2bcc5bf4`.

### 3. P1 — explicit override equal to the customer-less value ignored (secrets.ts:249-251)

The root `desktop:*` and `build` scripts run under `BUN_OPTIONS=--no-env-file`,
which disables `.env` auto-loading for the entire bun process tree. The resolver
detects `BUN_OPTIONS` and treats every `DOKAN_*` value as a deliberate override,
honouring one that equals the base `.env` value. Paths without that proof (a
bare `bun run --filter @dokan/desktop …`) keep the base-file preload heuristic,
so finding 1's cross-shop protection still holds there. `turbo.json` declares
the customer and secret vars in `globalEnv` (cache key + passthrough) and
`BUN_OPTIONS` in `globalPassThroughEnv`, because turbo's strict env mode had
filtered `DOKAN_CUSTOMER_SLUG` out of the desktop build.

Verified with three runs of the same override value:

| Invocation | Stamp build-secret hash | Result |
|---|---|---|
| `DOKAN_CUSTOMER_SLUG=acme bun run desktop:sidecar` | `99e04e6d8e03d510` (`.env.acme` value) | file used |
| `… DOKAN_BUILD_SECRET=<base value> bun run desktop:sidecar` | `36b6e33f4f35b480` (base value) | override honoured, `.env.acme` unchanged |
| same override via `bun run --filter @dokan/desktop sidecar` | `99e04e6d8e03d510` | preload heuristic keeps the customer file |

### 4. P1 — temp file not covered by `.env.*` (secrets.ts:465)

`envTempPath` names the atomic-write temp file
`.env[.<slug>].<pid>.<random>.tmp` (the old shape was `..env…tmp`). The
existing `.env.*` rule covers it; `git check-ignore -v` confirms
`.env.12345.abcdef.tmp`, `.env.acme.12345.abcdef.tmp`, `.env.acme.lock` and
`.env.lock` are all ignored. A unit test asserts the name shape for both the
base and slug files.

## Verification (final HEAD)

| Gate | Result |
|---|---|
| `bun run typecheck` | exit 0 |
| `bun run lint` | exit 0 |
| `bun run test` (desktop 62 tests incl. new spawn test) | exit 0 |
| `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` | 13 + 10 passed |
| `cargo clippy … --lib -- -D warnings` | exit 0 |
| `cargo clippy … --all-targets -- -D warnings` | exit 0 |
| `cargo clippy …/sidecar-freshness/Cargo.toml --all-targets -- -D warnings` | exit 0 |
| `DOKAN_CUSTOMER_SLUG=acme bun run build` | exit 0, acme binary staged and bundled |
| unscoped build over a customer stamp | refused (exit 101) |
| slugged build with a torn binary | refused (exit 101) |
| bare slugged build without `--config` | refused (exit 101) |
| `git check-ignore` on temp/lock names | covered by `.env.*` |

## Residual risks

- A direct `cd apps/desktop && bun run sidecar` (no root wrapper) can still
  inherit a pre-loaded `.env`; it therefore keeps the safe preload heuristic and
  ignores an override that equals the base value. Documented: use the root
  `desktop:*` scripts for one-off overrides.
- `globalEnv` includes the secret values so turbo keys its cache on them; turbo
  stores hashes, not the values, and the build task has no declared outputs.
