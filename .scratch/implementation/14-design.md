# Ticket 14 — Diagnostics log viewer + stable error codes

Tier: Standard (developer-facing infra, no money math). Base SHA: c1bec84.

## Problem

- Every technical error must carry a **stable** `DKN-XXXXXXXX` code: same error
  site → same code across runs. Today `errorCode()` in `apps/api/src/lib/logger.ts`
  uses `crypto.randomBytes(4)` — every occurrence of the same failure gets a
  fresh random code, so codes are useless as identifiers ("look up DKN-xxxx
  in the source").
- A developer-facing viewer is required: today's tail of the JSONL diagnostics
  log, admin-session-guarded, Arabic RTL, registered in nav.

## What already exists (verify, don't rebuild)

- `AppLogger` persists JSONL per Algeria-local day at `<dataDir>/logs/YYYY-MM-DD.jsonl`
  with `ts` (Algeria local), `level`, `event`, `message`, `code`, `stack`,
  `errorName`, `context` — exactly the fields the issue asks for.
- `localDate()` / `localDateTime()` (Africa/Algiers, no DST).
- Contract seam already wired: `diagnosticsLogsTail` (input `{lines? 1..500}`,
  output `{file, lines}`) — router stub is `notImplemented`.
- `AppLogger.tail(lines)` reads the last N lines of today's file (newest-last,
  i.e. chronological append order).
- `requireSession` guard (single-admin boundary) already wraps the stub.

## Changes

### 1. Stable codes (`lib/logger.ts`)

Replace the random `errorCode()` with a deterministic `errorCodeFor(event, errorName)`:

- Key = `${event}::${errorName ?? "Error"}` → sha256 → first 8 hex chars,
  uppercased → `DKN-XXXXXXXX`. 32 bits, stable across runs, processes, machines.
- `AppLogger.error()` derives the code from the call site's `event` literal +
  `error.name`. Same site + same error class ⇒ same code forever, which is the
  identity the logs/docs/UI reference. Occurrences are distinguished by `ts`.
- Remove the random `errorCode()` export (only used internally; deleting it
  makes accidental randomness impossible). Docstring states the stability rule.

### 2. Wire the procedure (`rpc/router.ts`)

```ts
diagnosticsLogsTail: os.diagnosticsLogsTail.handler(
  guardedInput(async ({ lines }) => deps.logger.tail(lines ?? 100)),
),
```

Already behind `requireSession` (single-admin boundary ⇒ "admin-only" feel,
matches the rest of the app). No contract change — input schema clamps 1..500.

### 3. Viewer page (`apps/web/src/pages/diagnostics.tsx`, `router.tsx`, `lib/i18n.ts`)

- `/diagnostics` ("سجل التشخيص") — reads `orpc.diagnosticsLogsTail.queryOptions({ input: { lines: 200 } })`.
- Render: newest-first rows (reverse the newest-last tail), each parsed from
  JSONL (malformed lines shown raw as a fallback). Columns: ts (dir=ltr),
  DKN code badge (dir=ltr, mono), event, message; `<details>` per row for the
  stack. Empty state, error state + retry (same pattern as activity page).
- The log *file* path returned by the procedure is shown (basename) — the
  documented log location lives in `docs/development-workflow.md`.
- Nav link added to the header; page sits behind the global `RequireSession`
  login gate like every other route (admin-only feel).
- i18n keys added to the `ar` resources block (additive; nothing removed).

### 4. Documentation (`docs/development-workflow.md`)

New short "Diagnostics log" section: location `<dataDir>/logs/YYYY-MM-DD.jsonl`
(Africa/Algiers day), fields, stable-code semantics (event+errorName →
`DKN-XXXXXXXX`), viewer path `/diagnostics`, reading a code in the source.

## Dependencies

None new — `node:crypto` sha256 already available, `AppLogger` and contract in
place. No store/db changes.

## Test plan

- **Unit** `apps/api/src/lib/logger.test.ts` (new):
  - `errorCodeFor` deterministic (same key → same code; different event /
    different errorName → different codes; `/^DKN-[0-9A-F]{8}$/`).
  - Same event+name logged through two fresh `AppLogger` instances (restart
    simulation) lands identical codes in JSONL.
  - JSONL file exists under `<dir>/logs/<today Algeria>.jsonl`; entry shape
    ts/code/message/stack/errorName/context.
  - `tail` bounded (N of M lines, newest-last), empty for missing file,
    invalid lines tolerated.
  - `localDate`/`localDateTime` format locked.
- **Router seam** (`rpc/router.test.ts`, additive describe):
  - unauthenticated `diagnosticsLogsTail` → UNAUTHORIZED.
  - authenticated: a failing RPC (unauthed call on the same app) writes an
    `RPC_ERROR` JSONL row with a code; `diagnosticsLogsTail` returns it with
    `file` under `logs/{today}.jsonl`; the same failing call twice → the SAME
    code in both rows; `lines: 1` clamps the tail to one line.
- **E2E** `tests/e2e/ticket14.spec.ts` (Playwright):
  - login (shared first-time-setup flow) → nav → `/diagnostics` → heading
    visible; file name `YYYY-MM-DD.jsonl` shown; at least one log row rendered
    (boot always logs SERVER_BOOT_DONE / SERVER_STARTED against the wiped
    `.e2e-data` dir).

## Risks

- `sha256` first-8-hex collisions (32 bits) — negligible for a single shop's
  log volume; code uniqueness is per *site*, not per occurrence.
- `tail` reads the whole file per call — logs are small (JSONL, one line per
  event); acceptable for a single-user kiosk app.
- Other lanes own settings/sale/purchase seams — this branch touches only
  logger, router (additive), i18n (additive), router.tsx (additive), docs, tests.