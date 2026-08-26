# Development Workflow

Permanent development workflow for Dokan: branching, issue tracking, and planning.

## 1. Planning Flow

```
Domain glossary (CONTEXT.md)
    ↓
Architecture / ADRs (docs/adr/)
    ↓
.scratch/issues (draft planning)
    ↓
GitHub Issues (execution)
    ↓
Implementation
```

| Stage | Location | Purpose |
|-------|----------|---------|
| Domain glossary | `CONTEXT.md` | Canonical terms (Arabic + English). Read-only during implementation. |
| Architecture | `docs/`, `docs/adr/` | Approved decisions. Changes only through a new ADR. |
| Draft planning | `.scratch/issues/` | Temporary workspace for issue breakdown before GitHub. |
| Execution | GitHub Issues | Source of truth during implementation. |

## 2. Issue Taxonomy

### Labels — Priority

| Label | Meaning |
|-------|---------|
| `priority:high` | Blocking. Must be completed in current milestone. |
| `priority:medium` | Important. Should be completed in current milestone. |
| `priority:low` | Nice to have. Deferred if time runs short. |

### Labels — Area

| Label | Scope |
|-------|-------|
| `area:items` | Items, categories, stock quantities, low-stock thresholds |
| `area:sales` | Sales, sale invoices, invoice printing |
| `area:purchases` | Purchases from suppliers, average cost updates |
| `area:payments` | Payments, partial payment, remaining amounts, debt lists |
| `area:customers` | Customers and customer debt tracking |
| `area:suppliers` | Suppliers and supplier debt tracking |
| `area:auth` | Admin login, session management, build-secret reset |
| `area:activity` | Activity log / audit trail |
| `area:backup` | Daily automatic backup, manual USB export |
| `area:i18n` | Arabic-first UI strings, RTL, translations |
| `area:desktop` | Tauri shell (`apps/desktop/src-tauri/`): window, packaging, IPC |
| `area:web` | React frontend (`apps/web/`): routes, pages, components |
| `area:api` | Hono API (`apps/api/`): oRPC procedures, validation, DB access |
| `area:contracts` | Shared contracts (`packages/contracts/`): Zod schemas, types |
| `area:testing` | Unit/integration tests, Playwright E2E infrastructure |
| `area:tooling` | Build, lint, CI, repo scripts, dependencies |

### Labels — Type

| Label | Meaning |
|-------|---------|
| `type:feat` | New user-facing capability |
| `type:fix` | Bug fix |
| `type:refactor` | Behavior-preserving restructure |
| `type:test` | Test-only change |
| `type:docs` | Documentation only |
| `type:chore` | Tooling, deps, config |

## 3. Definition of Done

A ticket is done when:

1. All gates in `engineering-workflow.md` pass for its review tier.
2. User-facing flows have a Playwright E2E test; business rules have unit tests.
3. UI text is Arabic-first with English keys in place via i18next.
4. No generated artifacts entered the diff.
5. PR is open (or updated) with review evidence linked; merge is a separate user decision.

## 4. Milestones

Milestones follow the MVP slice order in the domain glossary (stock → invoicing → payments/debts →
auth → backup). A milestone closes only when all its tickets are merged into `develop`.

## 5. Desktop packaging (ticket 15)

### Architecture (production)

The packaged app is a Tauri shell that spawns the **compiled Bun api as a
sidecar** and points the window at the api's origin:

```
desktop exe ──spawn──► dokan-api.exe (bun build --compile, bundled externalBin)
     │  env: DOKAN_DATA_DIR  = %APPDATA%/dz.dokan.app
     │       DOKAN_PORT_ROOT = %APPDATA%/dz.dokan.app/run
     │       DOKAN_WEB_DIST  = <resource>/ui   (bundled web dist)
     │  baked: per-customer provisioning secret AND the better-auth
     │         session-signing secret INLINED into the sidecar exe at build
     │         time (bun --define), never in env, logs or disk state
     └─ binds 127.0.0.1:0 (kernel-assigned free port, held as a reservation)
        → hands the exact port to the child explicitly (DOKAN_PORT)
        → waits for the child to echo the one-time DOKAN_BOOT_TOKEN at
        /health-token AND publish its pid's registry entry for that port
        → navigates window to http://127.0.0.1:<port>
```

The api serves the bundled UI (static + SPA fallback) **only when
`DOKAN_WEB_DIST` is set** — dev/e2e never set it, so their behavior is
unchanged. The webview origin equals the api origin, so the frontend's
relative `/api/*` calls, auth cookies and sessions work with no CORS and no
custom protocol. Data, logs and backups live under the OS app-data dir, never
in the install folder (which holds only the exe, the sidecar and the read-only
`ui/` assets).

Dev mode (`tauri dev`) never spawns the sidecar: run `bun run dev:api` +
`bun run dev:desktop` as usual and the window loads the vite devUrl.

### Commands

```bash
# per-customer release (required): validates + inlines both secrets, builds NSIS
DOKAN_BUILD_SECRET='<unique-per-shop-secret>' \
DOKAN_AUTH_SECRET='<unique-per-shop-signing-secret (>=32 chars)>' \
DOKAN_CUSTOMER_SLUG='shop-slug' \
bun run --filter @dokan/desktop portable
# → apps/desktop/src-tauri/target/release/bundle/nsis/Dokan_<version>[_<slug>]_x64-setup.exe
# fails loudly when either secret is missing or too short — never ships a default

# pieces separately
bun run --filter @dokan/desktop sidecar   # validating compile → src-tauri/binaries/
bun run --filter @dokan/desktop build     # sidecar + tauri build (release)
```

The sidecar binary and `target/` are generated artifacts (gitignored); the
source of the icon master is `tools/generate-icon.py` (PIL) — regenerate the
icon set with `bunx tauri icon ./src-tauri/icons/dokan-master.png`.

### Installer facts

- NSIS, `installMode: currentUser` (no admin prompt on a clean PC),
  `webviewInstallMode: embedBootstrapper` (WebView2 runtime installed
  automatically by the installer).
- **Per-customer secrets** (PR #51 findings 2 & 5): the vendor picks a
  unique BUILD_SECRET **and** a unique AUTH_SECRET per shop and passes them
  at BUILD time — both are inlined into the compiled sidecar exe, never
  committed, never in runtime env/logs/app-data. The documented release
  command is:

  ```bash
  DOKAN_BUILD_SECRET='<unique-per-shop-secret (>=16 chars)>' \
  DOKAN_AUTH_SECRET='<unique-per-shop-signing-secret (>=32 chars)>' \
  DOKAN_CUSTOMER_SLUG='shop-slug' \          # optional: names the installer
  bun run --filter @dokan/desktop portable
  ```

  Missing or weak secrets fail the build loudly; installers built without
  them are test artifacts only (`cargo build`/`gates` fall back to a
  secret-less sidecar with a loud warning and are never shipped). A packaged
  binary that somehow boots without a strong signing secret is refused at
  startup (the api's packaged-boot guard).
- **Verified sidecar discovery** (PR #51 finding 1): the shell binds a
  listener on `127.0.0.1:0` — the kernel assigns a free port and the socket
  reserves it while the child is spawned, so no local process can race a
  probe (PR #51 TOCTOU fix: no probe at all anymore). The exact port is
  passed explicitly (`DOKAN_PORT`, authoritative) and navigation happens only
  after BOTH the one-time token echo at `/health-token` AND the child-pid
  registry entry for that port confirm identity — a stale, tampered, decoyed
  or race-hijacked record or port can never redirect the webview.
- First run: setup flow types the per-customer secret once to create the admin
  account (see `apps/api/src/auth/admin.ts`).
- If the app is hard-killed the sidecar may linger; the next launch probes a
  free port and rewrites the port record, so discovery self-heals.

## 6. Diagnostics log (developer-facing)

Every technical error (and every info/warn entry) is appended to a daily JSONL log:

- **Location:** `<DOKAN_DATA_DIR>/logs/YYYY-MM-DD.jsonl` — one file per Algeria-local day
  (`Africa/Algiers`, no DST); `DOKAN_DATA_DIR` defaults to `./data` at the api workspace root.
- **Fields per line:** `ts` (Algeria-local `YYYY-MM-DDTHH:mm:ss`), `level` (`info|warn|error`),
  `event` (stable call-site literal, e.g. `RPC_ERROR`, `SERVER_ERROR`), `message`, `code`,
  `stack`, `errorName`, `context` — see `LogEntry` in `apps/api/src/lib/logger.ts`.
- **Stable error codes:** `DKN-XXXXXXXX` is **derived, never random** — `sha256(event::errorKind)`
  truncated to 8 uppercase hex chars, where `errorKind` is the error's class name plus, when the
  error framework distinguishes a failure kind (oRPC's `ORPCError.code`, e.g. `UNAUTHORIZED` vs
  `INTERNAL_SERVER_ERROR`), that kind. Same error site + same failure kind ⇒ same code on every
  run and every machine; occurrences differ only by `ts`. To find a code in the source, grep the
  `event` literal — the code survives restarts and reinstallations. Note: **one event literal ⇒
  one code**, so when two genuinely different failure sites must be told apart by the log, give
  them distinct `event` literals at the call site.
- **Retention:** one file per day is kept indefinitely; there is no rotation. The viewer tail reads
  a whole day file into memory to slice it, so on a very long-lived install you can safely delete
  old `<date>.jsonl` files by hand (or move them off-box) — nothing references them.
- **Viewer:** admin-session-guarded page `/diagnostics` (nav link «التشخيص») shows today's tail,
  newest first, bounded to 200 lines; the `diagnosticsLogsTail` RPC clamps `lines` to 1..500.
- **Reading a failure:** the api mirrors non-info entries to stdout, and the workflow for a bug
  report is: open `/diagnostics`, copy the `DKN` code + `ts`, then grep the repo for the event.
