# E2E stale dev servers, the port fallback, and a pre-existing checksum flake

**Date:** 2026-10-13 · **Ticket:** 174 · **Area:** tests/e2e, apps/api port probe, apps/web vite proxy, apps/api/src/lib/vault/format.test.ts

Two traps that cost real time on this ticket.

## 1. Isolated-pass / full-fail e2e is a stale-server smell, not a test bug

`bun run test:e2e` runs every spec against **one** dev server pair. On Windows,
Playwright does not always kill the process tree it started, so each run can
leave the API (4317) and Vite (5173) alive. The next run then hits a cascade:

- The API probes for a free port when 4317 is busy and falls back, writing the
  actual port to `.dokan-port`, while Vite's proxy still resolves the base from
  `DOKAN_PORT` / `.dokan-port`. A stale server can answer Playwright's health
  check, so Playwright believes *its* server is up.
- Symptoms seen: a **404 for a newly added RPC** (`supplierEntries`), a
  `preferencesSet` write that a later `preferencesGet` does not see (page size
  500 instead of 10), spurious login redirects, and unrelated specs failing in a
  different set on each run.
- Crucially, the same spec **passes in isolation** and fails in the full suite.

**Always**: before a full e2e run, kill every listener on the e2e ports *with
its process tree* and delete the port files:

```bash
for p in $(netstat -ano | grep -E ":4317|:5173" | grep LISTENING | awk '{print $5}' | sort -u); do
  taskkill //PID $p //T //F
done
rm -rf .dokan-port .dokan-port.registry
```

Treat "isolated pass / full-suite fail" as a stale-server symptom first; verify
by starting the API once on a throwaway port and probing the new route (a valid
route returns 400/401, an unknown one 404). Do not "fix" a spec that only fails
under a contaminated server.

## 2. The recovery-code test is a known ~1/1000 flake (pre-existing)

`apps/api/src/lib/vault/format.test.ts` "rejects a transcription typo in a KEY
character" flips one base32 char and expects the checksum to reject. The code
uses a **2-char (10-bit) checksum**, so a single-character typo collides with
probability ≈ 1/970. Measured: 206 non-"checksum" outcomes in 200 000 flips.

**Always**: if the full unit suite fails on that test alone, it is the
checksum-collision flake, not a regression from your change — re-run or treat it
as a pre-existing flake and report it. A durable fix would re-roll the code
until the typo is rejected or assert the weaker "rejected" contract; both are
separate from any feature lane.

## 3. The vault spec's own pair uses fixed ports 4399/5174 (same trap, 2026-10-14)

`tests/e2e/vault.spec.ts` spawns its dedicated API+web pair on **hard-coded**
ports (4399/5174), so the `DOKAN_PORT`/`DOKAN_WEB_PORT` isolation that protects
the shared pair does not cover it. Its teardown kills the spawn with
`taskkill /T /F`, which on Windows does not always take the process tree down:
a stale vault API then answers the *next* run's `waitForOk(4399)`, the run talks
to a database where a vault already exists, and the "first run: create the vault"
test fails deterministically on `vault-recovery-key` — while the previous run
passed. Observed on #130 (PR #189) across two consecutive runs.

**Always**: before a full e2e run, also clear 4399/5174, not just 4317/5173:

```bash
for p in $(netstat -ano | grep -E ":4399|:5174" | grep LISTENING | awk '{print $5}' | sort -u); do
  taskkill //PID $p //T //F
done
```
