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
| `area:auth` | Admin login, session management, recovery |
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
     │  one universal build: no secret is baked into the sidecar; the
     │         session-signing secret is generated at first run and stored in
     │         the database (ADR-0008)
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

### The unified vault in development (ADR-0008 §4.6)

The api boots in **vault mode by default**: the first request shows the vault
gate (create the vault, show the recovery key once, unlock). The gate is served
by the locked sidecar itself, so `bun run dev:api` + `bun run dev:web` shows the
real first-run flow in the browser. `DOKAN_VAULT=disabled` is the dev/e2e-only
escape hatch that keeps the legacy plaintext database and password/login path;
the packaged desktop shell never sets it. The desktop shell can drive the same
manager over stdin with `DOKAN_VAULT_STDIN=1` (one JSON request, one JSON
reply; the passphrase never touches argv or the environment).

### Commands

```bash
# one universal release: no secrets, one artifact per release
bun run --filter @dokan/desktop portable
# → apps/desktop/src-tauri/target/release/bundle/portable/Dokan-portable/
#   and Dokan-portable.zip

# pieces separately
bun run --filter @dokan/desktop sidecar   # compile → src-tauri/binaries/
bun run --filter @dokan/desktop build     # sidecar + tauri build (release)
```

The sidecar binary and `target/` are generated artifacts (gitignored); the
source of the icon master is `tools/generate-icon.py` (PIL) — regenerate the
icon set with `bunx tauri icon ./src-tauri/icons/dokan-master.png`.

### Installer facts

- NSIS, `installMode: currentUser` (no admin prompt on a clean PC),
  `webviewInstallMode: embedBootstrapper` (WebView2 runtime installed
  automatically by the installer).
- **One universal build** (ADR-0008): every shop gets the same installer and
  the same portable zip; an update is a single artifact, never a per-shop
  rebuild. No secret is passed at build time or baked into the sidecar. The
  session-signing secret is generated at first run and stored in the portable
  database (`settings.auth_secret`), so copying/restoring the data folder
  preserves sessions. The build-time sidecar freshness check (API/contract
  sources plus the binary hash) stays: a stale sidecar is a separate bug class.
- **Verified sidecar discovery** (PR #51 finding 1): the shell binds a
  listener on `127.0.0.1:0` — the kernel assigns a free port and the socket
  reserves it while the child is spawned, so no local process can race a
  probe (PR #51 TOCTOU fix: no probe at all anymore). The exact port is
  passed explicitly (`DOKAN_PORT`, authoritative) and navigation happens only
  after BOTH the one-time token echo at `/health-token` AND the child-pid
  registry entry for that port confirm identity — a stale, tampered, decoyed
  or race-hijacked record or port can never redirect the webview.
- **First run** (ADR-0008 §4.1): the setup flow creates the owner account on
  an empty database; it no longer types a secret. A database with shop records
  but no owner refuses provisioning (the app shows the refusal instead of a
  login form). Phase 1 intentionally has NO password-reset path — a forgotten
  password is permanent until the recovery lane — and `auth_secret` is
  plaintext in the database and every backup until the vault lands.
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

## 7. Local verification tiers

Five **verification tiers**, cheapest first. The full suite is the last one, not
the first.

"Tier" is overloaded in this repo: `engineering-workflow.md` owns the *review*
tiers (Standard, High-assurance), which decide how much scrutiny a change gets,
while these decide what a lane runs and when. A lane brief that says "tier 1"
means this section, and when the meaning matters write "verification tier".

A fresh worktree has no `node_modules`, so run `bun install --frozen-lockfile`
before any of these. Otherwise the first failure reads as a broken script.

| Verification tier | What runs | When | Cost |
|-------------------|-----------|------|------|
| 0 | `bun run typecheck`, `bun run lint` | after every edit | seconds, no queue |
| 1 | `bun run test:affected` | per iteration, not per edit | ~2-4 minutes cold, queued |
| 2 | `bun run test:e2e:changed` | before every push | the mapped specs, ~1-3 minutes, queued |
| 3 | the PR's CI head | after the push | free; it also runs red-on-parent |
| 4 | `bun run test:e2e` | **once per PR**, right before the lane reports | all 35 specs, ~9 minutes, queued |

Only tier 0 is free, and the queue's rule is a **string match on the command**, not
on what the command runs. `bun run test:affected`, `bun run test:e2e:changed` and
`bun run test:e2e` all contain the words the bash heavy-work guard looks for, so
they are refused inline and you call `heavy_run` (or take the guard's redirect).
The `--dry-run` flag does not change that: `bun run test:affected --dry-run` is
refused too, because the guard reads the argv and a dry run is not a different
argv to it.

The unqueued spelling is the direct one — `bun scripts/test-affected.ts` and
`bun scripts/e2e-changed.ts` match no guard rule. Use those for the **decide and
run nothing** shapes, which are the cheap ones:

```bash
bun scripts/test-affected.ts --dry-run        # scope= + reason= + one step= line per command
bun scripts/e2e-changed.ts --dry-run --files apps/web/src/pages/backups.tsx
```

And be careful with the same spelling when it DOES run: `bun scripts/test-affected.ts`
spawns turbo and `bun scripts/e2e-changed.ts` spawns the Playwright suite, and
neither is queued under that spelling. Run them through `heavy_run` when the
queue matters, or you have taken the slot yourself.

Tier 1 is also not "seconds": the scripts step alone measured about two minutes
here (445 pass, 1 skip, 8 files — the count moves with every suite that touches
`scripts/`), and `turbo.json` gives `test` a `dependsOn: ["^build"]`, so a cold
run builds every package first.

Tier 1 is `bun run test:affected`: turbo's impacted filter **and** the scripts
suite that carries the e2e map's drift guard, started together. They cannot reach
each other, so one pass carries both verdicts: a red package suite is no longer
masked by a green scripts run, and the script's own exit code is the first failure
in plan order so it does not depend on which child finished first. Both suites
write to inherited stdio, so their output **interleaves and cannot be attributed**
to a step from the transcript; the per-step `→ exit N` lines are printed after
both finish and are the only place that says which one failed. The speed claim is
gone on purpose: the measured difference against the serial shape was 178 s to
173 s warm, which is noise on a three-minute tier. The gain is the shared verdict,
not time.

The filter follows the diff, and that is load-bearing rather than tidy. turbo's
root `//` package declares no `test` task, so a filter that selects only `//` runs
zero tasks and **exits 0** ("WARNING No tasks were executed as part of this run").
A diff entirely inside `apps/<name>/` or `packages/<name>/` therefore gets
`--filter=...[<merge-base>]` (the changed packages **and the packages that depend
on them**), while any path outside those trees — `package.json`, `turbo.json`,
`bun.lock`, `tsconfig.base.json`, `scripts/`, `docs/` — drops the filter so every
package runs, naming the path that caused it.

That filter is not trusted on its own. Before committing to it the script asks
turbo what the filter would select (`--dry-run=json`, about half a second, no
suite), and widens — naming the cause — when the answer is empty, is only `//`, or
cannot be read. Same rule as the other two fallbacks, and for the same reason: the
expensive answer is allowed to be wrong, the silent one is not. The unfiltered
fallback therefore has **three** causes now — a path outside every workspace
package, a base git cannot resolve, and a filter that selects nothing — and a
moved base is no longer one of them: the diff and the filter both use
`git merge-base <base> HEAD`, the commit the branch forked from. Diffing the base's
TIP against the working tree picked up everything merged since the fork; measured
on one stale branch, the tip diff was 27 paths and the merge-base diff 12, and 16
`apps/web` paths appeared only because another PR merged after the fork.

One slot now holds two concurrent suites — turbo at `--concurrency=2` plus
`bun test ./scripts/` — so the queue undercounts this box by two or three times
for the length of a tier-1 run. The scripts step is also unconditional: a one-line
`apps/api` change still pays for the gate's own suite, because that suite is where
the e2e map's drift guard lives.

```bash
bun run test:affected --dry-run   # refused by the guard: the argv matches "a bun test run"
bun scripts/test-affected.ts --dry-run   # the cheap spelling: decide, run nothing
```

Tier 3 is the one that runs `scripts/red-on-parent.ts`. That gate judges every
test file the change **adds** under `apps/`, `packages/` and `scripts/`, on the
parent of the change — and it writes stand-ins for the modules the change brings:
a hollow module for one the parent does not have, and a copy of the parent's own
module with only the new names appended for one it does. A test that pins nothing
then passes on the parent (and is rejected) while a real one fails for its own
reason. A module a faithful stand-in cannot reproduce — an `export default`, a
re-export, an enum, a namespace, a decorated or destructured export, or an
appended declaration that would redeclare a name the parent's scope already binds
— is the verdict CANNOT_HOLLOW, which fails closed and is cleared only by
`// red-on-parent-waive: "whole file" — <why the parent cannot run this file>` in
the added test file, spelled exactly that way.

The waiver grammar is the same in all three places that describe it: this
section, `docs/verification-and-merge-gate.md` and `VERDICT_GUIDE` in
`scripts/red-on-parent.ts`. Four verdicts can be waived and no others —
`GREEN_ON_PARENT`, `WRONG_REASON_RED`, `NOT_ON_PARENT` and `CANNOT_HOLLOW` — and
only `CANNOT_HOLLOW` takes the whole-file spelling.

What the gate proves is narrower than "this test asserts a behaviour": it proves
the file **reaches** the change and **fails there**, and the report's `STAND-IN`
column says which fake a row was judged against. On a **hollow** (the change adds
the module) a TypeError is the gate's own fake being dereferenced, so the row is
wrong-reason red, not the test's own red (#348); an assertion that only reads a
const stand-in is still accepted there, and labelled. On an **appended** stand-in
(the parent has the module) the parent's real code still runs, so a TypeError has
a cause the gate cannot see and stays accepted. Both remaining acceptances are
pinned as fixtures in `scripts/red-on-parent.test.ts`.
`docs/verification-and-merge-gate.md` has the full statement; the grammar it
documents, this section and `VERDICT_GUIDE` in `scripts/red-on-parent.ts` name the
same four waivable verdicts and the same waiver spelling.

Tier 2 is `bun run test:e2e:changed`, the queued spelling;
`bun scripts/e2e-changed.ts` is the same program and is not queued. It imports
`selectSpecs` and the checked-in map from `scripts/e2e-selection.ts`, so there is
one map and one set of precedence rules. What differs is the range and the
overrides: this driver diffs `<merge-base with origin/develop>..HEAD`, while CI
diffs `base.sha..head.sha` — on a stacked PR that is the parent branch, not
`origin/develop` — and replaces the decision outright for `push`,
`workflow_dispatch` and the `e2e:full` label. The local run is a cheaper early
warning, never a substitute for the PR's head. `--files` and `--base` cannot be
combined: `--files` decides from the list you give it and never reads git, so the
pair exits 2 rather than quietly ignoring one of them.

```bash
bun run test:e2e:changed --dry-run                                        # decide, run nothing
bun run test:e2e:changed --dry-run --files apps/web/src/pages/backups.tsx # decide for a path list
DOKAN_PORT=5417 DOKAN_WEB_PORT=6273 bun run test:e2e:changed              # decide and run, on a lane's own ports
```

`--dry-run` prints `mode=` / `specs=` / `reason=` — the three lines `ci.yml`
parses — plus a fourth, `source=git|files|dirty`. Read the fourth line before
quoting the other three in a report: `--files` produces a contract byte-shaped
exactly like a git decision and can overrule an `always_full` verdict, so
`source=files` says "this is about the paths I listed, not about my branch".
`source=dirty` means tracked files have uncommitted edits; the decision describes
`HEAD` only, so commit or pass `--files`, and the reason carries the same caveat.

Three outcomes widen the run on purpose. A critical path (the router, shared web
code, a spec, `package.json`, the harness itself). Any path the map does not
know. And **a diff git cannot produce at all** — an unresolvable base, or a
`merge-base` that returns nothing: a worktree cut before `origin/develop` was
fetched answers `mode=full` for a git reason, which reads as a map problem and is
not one. `git fetch origin` and ask again. Do not hand-write the spec list to get
around any of them: either the map is missing a row, or the change really can
move every screen.

Tier 2 and tier 4 start the api and the web dev server, and both default to the
same pair — `DOKAN_PORT=4317` and `DOKAN_WEB_PORT=5173` in
`playwright.config.ts`, with `reuseExistingServer: false` and an explicitly
configured port taken as authoritative. Two lanes on those defaults do not fail
loudly: the second lane's API cannot bind, Playwright's `/health` wait is
satisfied by the **first** lane's API, and the second lane's specs then run
against the first lane's server and sqlite store. That is the "a different set of
specs fails each run" failure recorded in
`.agents/wisdom/process/concurrent-lane-e2e-ports.md`. In a lane, always set
both, to a pair no sibling is using:

```bash
DOKAN_PORT=5417 DOKAN_WEB_PORT=6273 bun run test:e2e:changed
```

The shared 4317/5173 pair belongs to whoever is not in a lane.

The queue is measured, not a fixed count: capacity is recomputed from free RAM
and CPU load on every acquire, so it narrows when the box is busy and widens when
it is idle. `HEAVY_SLOT_MAX` (default 5) is a ceiling, not the number anyone gets
— "at most 2 at once" is not a mechanism this repo has.

**The policy for tier 4:** a lane runs the full suite at most once per PR, right
before it reports. Everything between the first push and the last fix iterates on
tier 2, and a `--dry-run` at either tier answers the cheap questions first. The
full run is what makes the narrowed runs safe, so it is not optional — it is just
not repeated.
