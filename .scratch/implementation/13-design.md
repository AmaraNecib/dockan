# Ticket 13 — Backups (auto daily + manual export)

## Data model

No schema change. A backup is a consistent copy of the SQLite file:

- Directory: `<DOKAN_DATA_DIR>/backups/` (same root as the live db and logs/).
- File name: `dokan-YYYY-MM-DD.db`, Algeria local date (`localDate()` from
  `lib/logger.ts`). One file per day; a rerun on the same day overwrites the
  same name (idempotent), matching "created on startup if today's is missing".

## API surface

New pure module `apps/api/src/lib/backups.ts` (no store/driver knowledge beyond
StorePort's existing `copyDatabaseTo`):

- `backupFilePath(dataDir, date)` → absolute dest path for a local date string.
- `createBackup({ store, dataDir })` → checkpoint+copy via
  `store.copyDatabaseTo`, returns `{ path, createdAt }` (matches the existing
  `backupManualOutputSchema` contract — no contract change needed).
- `ensureDailyBackup({ store, dataDir, today })` → creates today's file only
  when missing; returns `{ path, created }`.

## RPC

`backupManual` (guarded stub already wired in the contract):
checkpoint+copy through the seam, then `insertActivity(BACKUP_CREATED,
"نسخة احتياطية dokan-YYYY-MM-DD.db")`. Returns `{ path, createdAt }`.

## Startup hook

`main.ts` calls `ensureDailyBackup` after `store.setup()`; failures are logged
(`SERVER_ERROR`) but do NOT block boot — a full disk must not stop sales.
The auto-backup also records BACKUP_CREATED activity.

## UI

Small Arabic page `/backups` ("النسخ الاحتياطي") with one primary button
(export now) and a status line showing the last backup path + time. Nav link
added to the header.

## Test plan

- Unit (`lib/backups.test.ts`): file naming; manual copy opens standalone via
  bun:sqlite and contains expected rows; daily idempotency (two calls → one
  file, second returns created:false); backup reflects committed data.
- Router seam (`rpc/router.test.ts`): authenticated `backupManual` writes the
  file under dataDir/backups and logs BACKUP_CREATED; unauthenticated call is
  rejected UNAUTHORIZED.
- e2e (`tests/e2e/ticket13.spec.ts`): login → /backups → click export →
  success text + the file actually exists under `.e2e-data/backups/`.
