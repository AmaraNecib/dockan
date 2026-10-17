# #253 — evidence (HEAD 2d91024)

Base: `d843566` (merge-base with `origin/develop`). Commits: `c1c9e25`
(implementation), `2d91024` (test-audit/code-review hardenings).

## Failing-first: ablation proofs

Every new guard was re-run with the entry removed, on this tree. A test that
never failed proves nothing.

| # | Ablation (the fix/entry removed) | Result |
|---|---|---|
| A | `SUPPLIER_OPENING_BALANCE` branch → `if (tag === "__ABLATION__" …)` | 3 failures. Named: `expect(rendered).not.toContain("SUPPLIER_OPENING_BALANCE")`, Received `"SUPPLIER_OPENING_BALANCE THEY_OWE 100000 محمد بن علي"`. 44 pass / 3 fail. |
| B | add `"BRAND_NEW_TAG"` to `activitySummaryTags` | `covers exactly the server's summary-tag vocabulary` fails on the inserted tag. 46 pass / 1 fail. |
| C1 | add `summary: \`ABLATION_TAG payload\`` under `apps/api/src` | **Activity scan only:** `emits no tag outside activitySummaryTags` fails (`ABLATION_TAG`); the log-event scan has **0 matches** for this mutation and passes. Removed after the proof. |
| C2 | add `logger.info("ABLATION_LOG_TAG", "probe")` under `apps/api/src` | **Log-event scan only:** `emits no log event outside logEvents` fails (`ABLATION_LOG_TAG`); the activity scan passes. Removed after the proof. |
| D | reword `"database and auth ready"` → `"database and auth are ready"` in `apps/api/src/main.ts` | `still logs the exact startup sentences the web translates` fails on `SERVER_BOOT_DONE: database and auth ready`. 2 pass / 1 fail. Restored. |

> **Correction (round 2, finding r4302432183).** This table originally recorded
> one row C and claimed that a single `summary: \`ABLATION_TAG payload\`` mutation
> reddened **both** scans. It does not: `EMIT_SITES` in
> `apps/api/src/lib/log-events.test.ts` matches `logger.*` and
> `recordFailure("CODE")` / `rotateSession("CODE")`, never `summary:`, so that
> mutation produced 1 activity match and 0 log-event matches. C is now split into
> C1 (activity scan) and C2 (log-event scan), each run and observed separately
> (`bun test src/rpc/activity-tags.test.ts src/lib/log-events.test.ts`).
> Round-2 evidence for 25ff75a: `25ff75a-evidence.md`.

D closes the audit finding that the web message map and the web test shared one
hardcoded pair (a reworded api sentence reverted to raw English with every test
green).

## Before/after (visual)

`.scratch/reviews/253/before-*.png`, `after-*.png`, plus a real-pace video of the
same walkthrough (`before-video.webm`, `after-video.webm`). The "before" run is
the same app with `activitySummaryText` / `logEventCopy` / `logMessageCopy`
returning the stored string (the develop behaviour).

- `before-activity.png`: `SUPPLIER_OPENING_BALANCE WE_OWE 100000 إثبات-افتتاحي-…`,
  `STORE_SETUP متجر الاختبار`, `DAILY_BACKUP dokan-2026-10-17.db` — and the ref
  column is a bare `9b7c2262`.
- `after-activity.png`: `رصيد افتتاحي — نسالوه: 100000 (إثبات-افتتاحي-…)` with the
  ref underlined (a link), type badge `تسوية حساب مورّد`.
- `before-diagnostics.png`: `FIRST_TIME_SETUP / owner account created`,
  `SERVER_STARTED / Dokan API booted`, `SERVER_BOOT_DONE / database and auth
  ready`, `VAULT_DISABLED`.
- `after-diagnostics.png`: `أول تشغيل / أُنشئ حساب المالك`,
  `بدأ تشغيل الخادم / أُقلع خادم دكان`,
  `اكتمل تشغيل الخادم / قاعدة البيانات والمصادقة جاهزتان`, `الخزنة معطّلة`.

## Gates (this HEAD)

| Gate | Command | Result |
|---|---|---|
| Typecheck | `bun run typecheck` | 4/4 packages, exit 0 |
| Lint | `bun run lint` (oxlint) | clean, exit 0 |
| Unit | `bun run test` | 4/4 packages, `Failed: 0` — log: `2d91024-guard1-test.log` |
| E2E (full) | `bun run test:e2e` | **94 passed / 0 failed** (11.6m) — log: `2d91024-e2e-full.log` |

## Decisions

- **Direction word via the shared keys.** The activity sentence reuses
  `supplierAdjustDirectionWeOwe` / `supplierAdjustDirectionTheyOwe`, so the log
  follows #252's label swap automatically and can never disagree with the
  supplier-account screen. See the code-review evidence for the spec-example
  divergence this creates.
- **Unknown direction token renders raw**, not a defaulted direction word — a
  raw row is a visible bug; a wrong direction is a silent "who owes whom" bug.
- **Amounts stay raw digits**, matching every other activity sentence.
- **Diagnostics is a bounded vocabulary with a raw fallback.** Badges for every
  `logEvents` member; messages only for the startup sentences. The raw code stays
  on the row (`data-event`, `title`).
