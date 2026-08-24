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
