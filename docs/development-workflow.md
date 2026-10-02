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
# portable (folder + zip) — the default deliverable. No secrets needed on the
# command line: they are resolved from apps/desktop/.env (gitignored), and
# generated there once if missing.
bun run desktop:portable
# → apps/desktop/src-tauri/target/release/bundle/portable/Dokan-portable/  (folder)
# → apps/desktop/src-tauri/target/release/bundle/portable/Dokan-portable.zip

# per-customer installer: the slug names the artifact AND selects .env.<slug>
DOKAN_CUSTOMER_SLUG='shop-slug' bun run desktop:installer
# → apps/desktop/src-tauri/target/release/bundle/nsis/Dokan_<version>_<slug>_x64-setup.exe

# see (or print) the release secrets and where they came from
bun run desktop:secrets                  # the customer-less .env
bun run desktop:secrets --customer acme  # that customer's .env.acme
bun run desktop:secrets --show           # also prints the values

# pieces separately (the root wrapper keeps `.env` from being pre-loaded)
bun run desktop:sidecar   # validating compile → src-tauri/binaries/
```

The portable target is **Windows-only** and produces no installer.
`DOKAN_CUSTOMER_SLUG` selects the per-customer secret file and names the
installer; the portable folder name stays customer-neutral.

The sidecar binary and `target/` are generated artifacts (gitignored); the
source of the icon master is `tools/generate-icon.py` (PIL) — regenerate the
icon set with `bunx tauri icon ./src-tauri/icons/dokan-master.png`.

### Release secrets

Both per-customer secrets are **inlined into the compiled sidecar** at build
time (`bun build --compile --define`), so they never appear in the runtime
environment, logs, or app-data.

| Variable | Min | What it is |
|---|---|---|
| `DOKAN_BUILD_SECRET` | 16 | The provisioning secret for first-run setup and the password-reset path. |
| `DOKAN_AUTH_SECRET` | 32 | better-auth's session-signing key. Anyone holding it can mint an admin session. |

They resolve in this order:

1. an explicit environment variable — for one build that needs a specific
   shop's secret without rewriting the file;
2. this customer's gitignored env file — `apps/desktop/.env` for a build with
   no slug, `apps/desktop/.env.<slug>` when `DOKAN_CUSTOMER_SLUG` is set —
   where they are generated once and then reused;
3. a freshly generated value, written to that file.

**Keep the files.** A rebuild for a shop that already has data needs the SAME
values: a new `DOKAN_AUTH_SECRET` invalidates every session, and a new
`DOKAN_BUILD_SECRET` breaks that owner's password-reset path. A slugged build
never reads the customer-less `.env`: `bun run` pre-loads that file into the
evironment, but a value that came from it is ignored for another customer, so
two shops built from one checkout can never share a signing key. To migrate a
shop that was built before per-customer files existed, copy its old `.env`
values into `.env.<slug>` before the first slugged build — otherwise that shop
gets a fresh set and every existing session is invalidated. A weak value in
either place still fails the build loudly.

First-time generation is serialized across processes with a lock file
(`.env.<slug>.lock`) and the file is replaced atomically, so two builds racing
a missing file resolve to one secret set and a reader can never see a
half-written file. Generated files are written 0600, and a pre-existing loose
file is restricted before the secret lands in it.

A slugged build must go through this pipeline (or run `bun run desktop:sidecar`
first). `build.rs` cannot read `.env.<slug>` itself, so when
`DOKAN_CUSTOMER_SLUG` is set it refuses to compile against a staged sidecar
that is not stamped for that same customer — it never silences the mismatch by
inlining a different shop's secrets.

**An inherited value is never an override.** The outer `bun run desktop:*`
process may pre-load a `.env` from the repo root before the script disables
auto-loading, so a slugged build ignores any `DOKAN_*` value that matches the
repo-root `.env`/`.env.local` or, without proof that auto-loading was off, the
customer-less `apps/desktop/.env`. A value inherited that way can therefore
never become a customer's signing or password-reset secret.

**One release at a time per checkout.** `release.ts`, `build.ts` and a
standalone `bun run desktop:sidecar` all hold
`src-tauri/target/.dokan-release.lock` from secret resolution through bundling
(the cargo target dir and the pristine `bundle/nsis` artifact are shared), so
concurrent customer releases and standalone stagings wait for each other
instead of packaging each other's sidecar. The lock is refreshed while held.

```bash
# a specific customer's secrets, for one build, without touching the file
DOKAN_BUILD_SECRET='<unique-per-shop, >=16 chars>' \
DOKAN_AUTH_SECRET='<unique-per-shop, >=32 chars>' \
DOKAN_CUSTOMER_SLUG='shop-slug' \
bun run desktop:installer
```

### Installer facts

- NSIS, `installMode: currentUser` (no admin prompt on a clean PC),
  `webviewInstallMode: embedBootstrapper` (WebView2 runtime installed
  automatically by the installer).
- The portable folder cannot install WebView2, so the target machine needs the
  runtime present (Windows 11 has it; most Windows 10 machines do).
- A packaged binary that somehow boots without a strong signing secret is
  refused at startup (the api's packaged-boot guard); `cargo build` on its own
  produces a secret-less sidecar and says so loudly.
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
