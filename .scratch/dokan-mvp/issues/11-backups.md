# 11: Backups (auto daily + manual export)

**What to build:** a copy of the shop's data is made automatically every day and on demand, named by Algerian date, so a dead PC cannot kill the records.

**Blocked by:** 01, 02

**Status:** ready-for-agent

- [ ] Daily automatic backup (WAL checkpoint + copy) created on startup if today's is missing
- [ ] Manual "export backup" button creates a copy the owner can move to a USB stick
- [ ] Files named dokan-YYYY-MM-DD.db in Algeria local time
- [ ] A backup file opens cleanly as a standalone database
- [ ] Backup events appear in the activity log (BACKUP_CREATED)