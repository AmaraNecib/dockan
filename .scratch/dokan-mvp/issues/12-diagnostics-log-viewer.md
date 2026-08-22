# 12: Diagnostics log viewer + error codes

**What to build:** developer-facing traceability: every technical error gets a stable DKN-XXXXXXXX code and is written with a stack to a daily JSONL log in Algeria local time; a small viewer shows today's tail.

**Blocked by:** 02

**Status:** ready-for-agent

- [ ] Errors are logged with code + stack + local timestamp; codes are stable identifiers
- [ ] Daily file per day, human-auditable JSONL
- [ ] Viewer (admin-side) shows today's tail; log location is documented