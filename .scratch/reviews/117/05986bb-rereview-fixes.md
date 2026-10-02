# Re-review fixes — PR #117 (round-4 findings on 2a64c8b)

- Tier: High-assurance. Fixed head: `05986bb` (round 4, on top of `2a64c8b`).
- Two re-review findings, both fixed with tests and end-to-end verification.

## Finding 1 — outer `bun run` can preload a repo-root `.env` (package.json:19)

`BUN_OPTIONS=--no-env-file` is set by the script command, but the OUTER
`bun run desktop:*` process starts before that and may pre-load a `.env` from
its cwd (the repo root). Those values were inherited, yet the resolver treated
them as deliberate overrides and could inline them into a slugged customer's
installer — two shops shipping the same signing/reset secrets.

Fix: when resolving with the real process environment and a customer slug, the
resolver now also reads the repo-root `.env` and `.env.local` (two directories
above `apps/desktop`) and never classifies a value matching them as an
override. Explicit overrides that equal the customer-less `apps/desktop/.env`
value are still honoured when `BUN_OPTIONS` proves auto-loading was off, so the
previous round's fix is preserved. Caller-supplied `env` objects (tests) have
no outer process, so the ambient check is skipped for them.

Tests:
- in-process: an `envIsExplicit` value equal to an ambient file is ignored and
  a fresh secret is generated;
- spawned child with a repo-root `.env` + `BUN_OPTIONS` + the inherited value
  in its environment: the value is ignored, source `generated`.

End-to-end: a real repo-root `.env` with
`DOKAN_BUILD_SECRET=root-inherited-secret-0001` (hash `eff5cbac3f0c0b8f`) was
created, then `DOKAN_CUSTOMER_SLUG=acme bun run desktop:sidecar` produced the
acme stamp `build-secret 99e04e6d8e03d510` (the `.env.acme` value), not the
inherited one. The probe `.env` was removed afterwards.

## Finding 2 — concurrent releases share target/packaging paths (release.ts:99-101)

Two customer releases stage separate sidecars correctly, but both use the same
`src-tauri/target/release` tree and pristine `bundle/nsis` artifact, and the
per-customer compile lock ends before bundling. Customer B could replace the
shared sidecar or the pristine installer before A assembled/renamed its
deliverable.

Fix: `release.ts` and the new `release-lock.ts` give every release a
checkout-wide lock (`src-tauri/target/.dokan-release.lock`) held from secret
resolution through bundling. `build.ts` takes the same lock. The lock is
refreshed every 30 s while held (so a multi-minute build is never stolen as
stale), waits up to an hour for another release, has a 5-minute crash-recovery
stale window, and is released on `process.exit` as well as `finally`.
Standalone `bun run desktop:sidecar` keeps its per-customer compile lock; the
docs say not to run it while a release is packaging.

Tests (`release-lock.test.ts`): two child processes run critical sections with
a shared lock — the markers prove the second starts only after the first ends;
and a throwing critical section still releases the lock for the next acquire.

End-to-end: with a repo-root `.env` still present,
`DOKAN_CUSTOMER_SLUG=acme bun run build` succeeded, `target/release/dokan-api.exe`
hashed `cb97159d` (the acme staged binary, not the shared default `2bcc5bf4`),
and `src-tauri/target/.dokan-release.lock` was gone afterwards.

## Gates on the final HEAD

| Gate | Result |
|---|---|
| `bun run typecheck` | exit 0 |
| `bun run lint` | exit 0 |
| `bun run test` (desktop 87 pass, 1 skip) | exit 0 |
| `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` | 13 + 10 passed |
| `cargo clippy … --lib -- -D warnings` | exit 0 |
| `cargo clippy … --all-targets -- -D warnings` | exit 0 |
| `cargo clippy …/sidecar-freshness/Cargo.toml --all-targets -- -D warnings` | exit 0 |
| build.rs policy checks (unscoped refusal, wrong slug, bare slug, torn binary, acme reuse) | all as expected |

## Residual risks

- A repo-root `.env.local` is covered; a `.env.<NODE_ENV>` at the root is not
  read as ambient. Our entry points never write DOKAN_* there.
- The checkout release lock serializes releases but not a standalone
  `bun run desktop:sidecar`; build.rs's stamp/binary checks still refuse a torn
  or mismatched staged sidecar in that case.
