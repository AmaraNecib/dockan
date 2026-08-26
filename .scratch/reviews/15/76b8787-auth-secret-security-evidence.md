# Security-fix evidence — PR #51 finding 5 (session forgery) — HEAD 76b8787

- Branch: `feat/15-desktop-packaging`. Base SHA `3d5763f` (origin/develop).
  Head SHA `76b8787`.
- Prior rounds: `.scratch/reviews/15/bbfc84d-security-evidence.md` (findings
  1–3, incl. per-customer build secret) and `.scratch/reviews/15/419ddbb-security-evidence.md`
  (TOCTOU). This file covers the session-forgery finding — the committed
  session-signing secret — and re-keys the security series to the rebased head.

## Finding — committed session-signing secret (fixed)

**Vulnerability:** `apps/desktop/src-tauri/src/desktop.rs` shipped a COMMITTED
`PRODUCTION_AUTH_SECRET` constant (64 hex chars) forwarded to the sidecar as
`DOKAN_AUTH_SECRET` — the better-auth session-signing key. Anyone who could
read the binary or the source could extract it, forge admin session cookies,
and pass every protected RPC on EVERY install. The per-customer round covered
`DOKAN_BUILD_SECRET` only; the signing key stayed a single shared value for
the whole fleet — the parent's debate flagged "per-customer builds must vary
BOTH secrets or the fleet silently shares a signing key".

**Fix — mirror the build-secret pipeline exactly:**

1. **Build-time requirement + inline (>= 32 chars):** `DOKAN_AUTH_SECRET` is
   now REQUIRED at release build time and inlined into the sidecar exe with
   the same `bun build --define` seam as the build secret:
   - `apps/desktop/scripts/sidecar.ts` — `validateAuthSecret` (rejects
     missing/empty/<32), `compileSidecar(buildSecret, authSecret)` passes
     BOTH defines; `main()` fails loudly (exit 1) on either.
   - `apps/desktop/scripts/release.ts` — validates both before compiling.
   - `apps/desktop/src-tauri/build.rs` — inlines the auth secret at the cargo
     sidecar-compile path when a strong value is in the env; else the loud
     test-artifact warning.
2. **Committed fallback removed:** the `PRODUCTION_AUTH_SECRET` constant is
   DELETED from desktop.rs and the shell passes NO secret to the child (env
   carries only port, data dirs, boot token). The api's `DEV_AUTH_SECRET`
   sentinel lives on only as a dev/test default (`bun run dev:api`, unit
   tests, e2e); a packaged binary can never sign sessions with it.
3. **API seam + packaged-boot guard:** `apps/api/src/main.ts` mirrors the
   build-secret seam (`config.authSecret = process.env.DOKAN_AUTH_SECRET ??
   config.authSecret` — the define replaces the expression), then refuses to
   boot (exit 1) a packaged binary (webDataDir/bootToken present) whose
   effective signing secret is missing, < 32 chars, or the dev sentinel.
4. **Leak scan clean:** the secret never appears in env-passing, logs, the
   port record, app-data, or committed files (`grep` for DOKAN_AUTH_SECRET in
   desktop.rs returns only comments).

**Live verification (compiled sidecar, CLEAN runtime env — no secret env vars
set):** `apps/api/verify-auth-secret-live.tmp.ts` was run against the binary
built via `bun run sidecar` with two test secrets, then deleted. All 7 checks
passed:

| Check | Result |
| --- | --- |
| `authResetPassword` with INLINED build secret | `{"ok":true}` |
| `authResetPassword` with any other secret | `WRONG_BUILD_SECRET` |
| sign-in (better-auth) issues a session cookie | 200 |
| guarded RPC (`categoriesList`) with the genuine cookie | accepted (`items: [...]`) |
| SAME token re-signed with a DIFFERENT secret | `AUTH_REQUIRED` (rejected) |
| cookie signature parses to HMAC(inlined secret) of the JWT | matches |
| cookie signature is NOT HMAC(other secret) | differs |

The signed-cookie format is hono's `value.signature` with
`btoa(HMAC-SHA256(value, secret))`; the value is a JWT HS256-signed with the
same secret — both layers verified against the inlined value.

**Packaged-boot guard (live):** a second sidecar compiled WITHOUT the auth
define (the dev/test-artifact path) and booted with `DOKAN_WEB_DIST` +
`DOKAN_BOOT_TOKEN` set exited 1 with "refusing to boot: packaged build
without a strong per-customer DOKAN_AUTH_SECRET (>= 32 chars)".
Dev builds still boot without it (sentinel config + full e2e suite).

## Tests

- `apps/desktop/scripts/pipeline.test.ts`: `validateAuthSecret` rejects
  missing/empty/weak and accepts >= 32 chars; the release main
  (`bun scripts/release.ts`) exits 1 with the right message when
  `DOKAN_AUTH_SECRET` is missing and when it is weak (subprocess tests).
- `apps/api/src/config.test.ts`: auth secret defaults to the dev sentinel
  only (and the sentinel is < 32 chars so packaged guard trips); an explicit
  env value wins.
- Existing suites unchanged and green (below).

## Gates (all green on HEAD 76b8787)

| Gate | Result |
| --- | --- |
| `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml` | 11 passed |
| `cargo clippy --manifest-path apps/desktop/src-tauri/Cargo.toml --lib -- -D warnings` | pass |
| `bun run typecheck` | pass |
| `bun run lint` (oxlint) | pass |
| `bun run test` | pass (api 307 + web + desktop pipeline 11) |
| `DOKAN_PORT=4329 DOKAN_WEB_PORT=5185 bun run test:e2e --workers=1` | 17 passed |
| `.dokan-port` restore | baseline `4317` restored byte-exact (`cmp` clean) |

Rebase note: branch rebased onto `origin/develop` (`3d5763f`, PR #55 from-only
clamp). Zero conflict hunks — #55 touches `apps/api/src/lib/report-ranges.ts`
+ `router.ts`; the desktop/auth pipeline touches `config.ts`/`main.ts`/desktop.
All 10 files owned by this round are byte-identical pre/post rebase (pure
re-parent).

## Risks carried

- A baked session-signing secret is still extractable from the binary by a
  determined local attacker (same honest note as the build secret). The fix
  bounds the blast radius to ONE shop per extracted key and makes rotation =
  rebuild + reinstall with a fresh secret; the fleet no longer shares a
  signing key.
- Fresh-install smoke on a clean PC stays deferred (blocked by #11 receipts,
  now merged — can be unblocked in a follow-up).