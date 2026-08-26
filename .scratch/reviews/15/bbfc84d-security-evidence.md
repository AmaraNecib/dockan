# Security-fix evidence — PR #51 findings 1–3 (desktop packaging) — HEAD bbfc84d

- Branch: `feat/15-desktop-packaging`. Base SHA: `9e4e97b`. Head SHA: `bbfc84d`.
- Prior implementation evidence: `.scratch/reviews/15/f07d986-implementation-evidence.md`
  (superseded for reviewable files; this file covers the PR #51 round).

## Finding 1 — verified sidecar discovery (fixed)

- Shell probes `4317..4317+25` for a free port (`find_free_port`), hands it to
  the child explicitly via `DOKAN_PORT` (api treats it as authoritative: binds
  exactly or exits loudly).
- One-time boot token (`getrandom`-backed, 64 hex) passed via
  `DOKAN_BOOT_TOKEN`; api exposes `GET /health-token?token=…` only when the
  token is configured (constant-time compare via `tokenMatches`, sha256+timingSafeEqual),
  echoing the exact token in the JSON body.
- Shell navigates ONLY after `wait_for_verified_health` sees HTTP 200 with the
  exact `"token":"…"` field on ITS chosen port. Persistent `.dokan-port` is
  never read for navigation.
- **Live tamper verification:** python decoy on 127.0.0.1:4444 logging all
  requests + planted `run/.dokan-port` = `4444`; release `dokan.exe` bound its
  own port 4317, decoy log stayed EMPTY, window loaded; graceful close killed
  both processes.
- Rust unit tests (7 total): `health_token_ok` accepts exact echo / rejects
  decoy-200 / rejects near-miss echo and dead port; `find_free_port` returns a
  free port and skips occupied one; `generate_boot_token` is 64 hex + unique;
  kill-on-exit.
- TS unit tests: `tokenMatches` (accept/reject/missing/empty/length/whitespace).

## Finding 2 — per-customer build secret (parent decision, option 2)

- `DOKAN_BUILD_SECRET` (>= 16 chars) required at BUILD time by
  `apps/desktop/scripts/sidecar.ts` (validated; exit 1 + example when
  missing/weak — **never ships a default**; unit-tested in
  `scripts/pipeline.test.ts`).
- Inlined into the sidecar exe: `bun build --compile … --define
  process.env.DOKAN_BUILD_SECRET:"<secret>"`; the api reads it via the
  `main.ts` seam `config.buildSecret ??= process.env.DOKAN_BUILD_SECRET`
  (dev unchanged — reads the shell env).
- Rust shell no longer passes the secret to the child; nothing writes it to
  env, logs, port record or app-data. `PASSWORD_RESET` behavior unchanged
  (exact same comparison path).
- **Live verification:** compiled exe run with NO runtime secret env —
  `authResetPassword` with the inlined secret → `{"ok":true}`; any other
  secret → `WRONG_BUILD_SECRET`. Secret bytes confirmed present only in the
  exe binary.
- **Release command (documented + run):**
  `DOKAN_BUILD_SECRET='<unique>=16>' DOKAN_CUSTOMER_SLUG='slug' bun run
  --filter @dokan/desktop portable` → `Dokan_0.1.0_acme-shop_x64-setup.exe`
  (slug rename unit-tested).
- Threat model + open "future: hybrid reset models" section in
  `.scratch/implementation/15-design.md`. Honest note: a baked secret is
  extractable from the binary by a determined local attacker; per-customer
  values bound the blast radius to one shop and rotation = rebuild.

## Finding 3 — clean build generates the sidecar (fixed)

- `bun run build` = `sidecar` (validating compile) + `tauri build`;
  `bun run portable` = `scripts/release.ts`.
- `build.rs` compiles the sidecar when `binaries/dokan-api-…exe` is absent
  (inlining the secret only when a strong `DOKAN_BUILD_SECRET` is present in
  the build env, else a loud `cargo:warning` test artifact — never shippable).
- **Verified:** sidecar deleted + `rm -rf target` → `cargo test` regenerated
  it and passed; `bun run portable` (no secret) fails loudly; with secret +
  slug succeeds end-to-end.

## Gates (all green on HEAD)

| Gate | Result |
| --- | --- |
| `bun run typecheck` | pass |
| `bun run lint` | pass |
| `bun run test` | pass (api 228 + web + desktop pipeline) |
| `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` | 7 passed |
| `cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --lib -- -D warnings` | pass |
| `DOKAN_PORT=4329 DOKAN_WEB_PORT=5185 bun run test:e2e --workers=1` | 13 passed |
| `.dokan-port` restore | baseline `4317` restored byte-exact (`cmp` clean) |

## Risks carried

- Baked secrets are extractable from binaries (bounded by per-customer scope;
  honest threat-model note in the design doc; hybrid reset models left open).
- `DOKAN_AUTH_SECRET` was a baked per-build constant passed by the shell at
  the time of this round — **superseded by the finding-5 round**
  (`.scratch/reviews/15/76b8787-auth-secret-security-evidence.md`): the
  committed signing key is gone, AUTH_SECRET is per-customer like
  BUILD_SECRET, and the shell passes no secrets.
- Fresh-install smoke on a clean PC stays deferred (blocked by #11 receipts).