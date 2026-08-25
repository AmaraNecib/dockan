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

## 5. Diagnostics log (developer-facing)

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
