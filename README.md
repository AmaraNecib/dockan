# Dokan (دكان)

Desktop stock & invoicing app for a car-accessories shop in Algeria.

- **Desk**: shop owner records purchases and sales, prints invoices, tracks debts (who owes us / we owe), gets low-stock warnings, and sees an activity log. Local-first: all data lives in one SQLite file on the shop's PC.
- **Dev**: Arabic-first, amounts in whole Algerian Dinars, timestamps in Algeria local time (UTC+1).

## Stack

Bun workspace monorepo (Bun 1.3+, no build step. workspace packages resolve straight from `src/`):

| package             | role                                                     |
| ------------------- | -------------------------------------------------------- |
| `packages/contracts`| Zod schemas + oRPC contract, source of truth             |
| `apps/api`          | Hono + oRPC + Drizzle + bun:sqlite (built into Bun)      |
| `apps/web`          | React + TanStack Router/Query + oRPC client + shadcn/ui  |
| `apps/desktop`      | Tauri shell; the API becomes a single `.exe` via `bun build --compile` |

Patterns borrowed from the proven `tuari_react_hono` ERP monorepo in `D:\projects`.

## Run (dev)

```bash
bun install
bun run dev:api        # API on http://127.0.0.1:4317
bun run dev:web        # UI on http://localhost:5173
bun run dev:desktop    # Tauri window (needs Rust toolchain. installed)
```

Production distribution: `bun run --filter @dokan/api compile` → `dokan-api` binary, shipped as the Tauri sidecar; web builds to static files the Tauri webview serves.

Decisions are recorded in `docs/adr/`. Domain terms in `CONTEXT.md`.