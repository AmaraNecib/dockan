# Test Audit — Dokan Ticket #14 (stable DKN codes + diagnostics log)

- Base `c1bec84`, branch `feat/14-diagnostics-log`.
- Reviewed HEAD: `4249cff` (three parallel voices: edge-case hunter, coverage
  analyst, quality reviewer — raw reports folded in below).
- Final HEAD: `7787b65` — the `f22d3e6` state plus the PR #45 finding
  addendum: the hour-24-midnight delimiter-order fix in `localDateTime` and
  its synthetic string tests (see the code-review addendum below). Prior
  baseline: rebased onto `origin/develop` af0c7a3 after sale checkout #42 +
  settings #44 merged; every other ticket-14 source file stays byte-identical
  to the reviewed `653a4bb`/`96fddf2` states (verified via `git diff`).
- Process: `.agents/skills/test-audit/SKILL.md`; review-only runs (no source
  modified by reviewers). Validation on the FINAL head:
  - `bun run lint` → clean (oxlint)
  - `bun run typecheck` → 3 turbo tasks successful
  - `bun run test` → 173 api tests + web suite, 0 fail (487 expects in api)
  - `DOKAN_PORT=4324 DOKAN_WEB_PORT=5180 bun run test:e2e -- --workers=1` → 10 passed
  - `.dokan-port` restored byte-exact after e2e

## 1. Edge-case hunter (folded)

Covered and genuinely asserted (not vacuous): code format `DKN-[0-9A-F]{8}`,
determinism identity, event/class differentiation, fs-seam restart stability,
JSONL shape (level/event/message/code/ts/errorName/stack/context), tail bounds
+ newest-last + missing-file, router stability (codes collapse to one over real
UNAUTHORIZED rows), zod clamp, web newest-first/badge/malformed/empty, e2e guard
+ nav + live badge.

Findings and dispositions:

| # | Finding | Risk | Disposition |
|---|---|---|---|
| A | `localDateTime` bare `s/24:/00:/` rewrote every real `:24` minute (verified `12:24:05` → `12:00:05`) | 🟠 | **FIXED** — anchored to hour field (`", 24:"` → `", 00:"`, no-op on this runtime where midnight already renders `00:00:00`); pinned-instant unit tests added |
| B | `tail(0)` → `slice(-0)` returned the whole file | 🟠 | **FIXED** — non-positive bound returns `[]`; unit test added |
| C | Two clock reads in `write()` could straddle Algeria midnight (row in wrong day file) | 🟡 | **FIXED** — one `now` per write; tail uses a single read too |
| D | No UTC→Algeria-day boundary pin | 🟡 | **FIXED** — `localDate` pinned at 22:59:59Z/23:00:00Z; minute-24 pinned |
| E | Viewer error state + retry untested | 🟡 | **FIXED** — web test: reject-once then retry recovers |
| F | `warn` level never exercised | 🟡 | **FIXED** — logger warn persistence test; warn row in web fixture |
| G | zod-invalid JSON (`{"event":5}`) fallback untested | 🟡 | **FIXED** — web fixture covers valid-JSON-wrong-shape raw render |
| H | zod probes only at 0/501 | 🟡 | **FIXED** — added `-1`, `1.5`, `"50"` |
| I | Web fixture wrote invalid `08:00:018` seconds | 🟡 | **FIXED** — valid distinct seconds |
| J | Clamp test order-reliant, misleading "ensure the file exists" comment, `<= 500` never asserted | 🟡 | **FIXED** — seeds its own row; writes 510 rows and asserts exactly 500 kept, newest preserved |
| K | Midnight flake in timestamps consistency spec | 🟡 | **FIXED** — single-instant assertion |
| L | Stability assertion fragile across future error kinds | 🟡 | **FIXED** — narrowed to the last two rows (exactly the seeded pair) |
| M | Concurrency on append; unbounded file growth | 🟡 | Accepted — append is synchronous per request (single process); retention + manual cleanup documented in `docs/development-workflow.md` §5 |

## 2. Coverage analyst (folded)

Every acceptance criterion maps to tests at ≥2 layers (unit/fs-seam/wire-seam/
web-unit/e2e): deterministic codes (pure fn, restart, seam, render, live badge);
per-day JSONL shape (fs test, seam basename, e2e independently-computed
Algeria date); guarded bounded RPC (UNAUTHORIZED seam, zod clamps both sides,
page requests exactly `{lines:200}`); Arabic RTL page + nav (e2e nav-click from
home, Arabic empty state via real i18next); docs location (verified against
`config.ts` default `./data` and contract 1..500). Test diversity: five distinct
patterns across four layers; no duplicate coverage worth removing.

Residual risks accepted (documented, not in scope): `FORBIDDEN` (non-admin)
branch of `requireSession` untestable today (signup HTTP-blocked — defensive);
`AppLogger` has no injectable clock (midnight rollover probability ≈ 0; the
same class was already defused in `backups.test.ts`); viewer `warn` style and
`<details>` disclosure are cosmetic.

## 3. Quality reviewer (folded)

Grades: `logger.test.ts` A; router ticket-14 describe B→A after fixes (seeding
removed the shared-log dependency, `<= 500` now asserted); `diagnostics.test.tsx`
B→A after afterEach teardown + per-row assertions + error/retry branch; e2e B
(newest-first invariant now commented); `backups.test.ts` flake fix C→fixed by
sweeping ALL fixture dates to 2035-06-0x (the 2026-08-29 `partial` and 2026-08-30
greptile-P1 tests were the same real-clock collision, scheduled to break within
days — now eliminated for the whole describe).

No missed awaits; no timer/sleep flakiness found; test isolation is per-test
tmpdir / fresh QueryClient / sequential-run conventions as elsewhere.