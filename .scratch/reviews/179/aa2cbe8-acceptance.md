# #179 — Acceptance evidence (repeated runs)

- **Reviewed HEAD:** `aa2cbe8d553267025d986e749805a1a3c8d4cafc`
- **Base:** `8bf2a817a2d25a58653704f1c4c15542bd822cc2`
- **Runner:** local Windows dev box, 12 CPUs; unique e2e ports
  (`DOKAN_PORT=5417`, `DOKAN_WEB_PORT=6273`) so the run cannot collide with the
  other worktrees. Every invocation wipes `.e2e-data` once at boot
  (`playwright.config.ts` webServer `scripts/wipe-e2e.mjs`).

## 1. Controlled experiment — write latency

Log: `aa2cbe8-latency-experiment-write.log` (run against the write-ack code).

Throwaway copies of the **base** spec and the **new** spec, each with a route
that holds the first write for 10 s:

| Spec under test | Result |
|---|---|
| base `arabic-search` + 10 s `itemsCreate` delay | **FAIL** — `unexpected value "لا توجد نتائج مطابقة"` (populated → cleared flicker), `Timeout: 5000ms` |
| new `arabic-search` + same delay | **PASS** |
| base `receipts` + 10 s `invoicesCreate` delay | **FAIL** — `getByTestId('sale-saved-number')`, `Timeout: 5000ms`, `element(s) not found` (the exact CI symptom) |
| new `receipts` + same delay | **PASS** |

## 2. Controlled experiment — search (read) latency

Log: `aa2cbe8-latency-experiment-read.log` (run at `aa2cbe8`).

| Spec under test | Result |
|---|---|
| base `arabic-search` + 10 s first-`catalogSearch` delay | **FAIL** — empty `<ul>`, `Timeout: 5000ms` |
| new `arabic-search` + same delay | **PASS** |

## 3. Affected specs, three clean runs

Log: `aa2cbe8-full-suite-3x.log` (section order) and the run below.

```
$ DOKAN_PORT=5417 DOKAN_WEB_PORT=6273 bunx playwright test \
    tests/e2e/receipts.spec.ts tests/e2e/arabic-search.spec.ts --repeat-each=3 --reporter=list
```

`6 passed (46.7s)` — each spec green 3× at the shipped `workers: 1`.

## 4. Full suite, three clean runs (shipped config)

Log: `aa2cbe8-full-suite-3x.log`.

```
$ DOKAN_PORT=5417 DOKAN_WEB_PORT=6273 bunx playwright test --reporter=line
```

| Run | Result | Exit |
|---|---|---|
| 1 | `53 passed (4.7m)` | 0 |
| 2 | `53 passed (4.4m)` | 0 |
| 3 | `53 passed (5.3m)` | 0 |

Each invocation is independent (the DB is wiped at boot).

## 5. Contended run — affected specs at `--workers=2`

Log: `aa2cbe8-contended-affected-workers2.log`.

```
$ DOKAN_PORT=5417 DOKAN_WEB_PORT=6273 bunx playwright test \
    tests/e2e/receipts.spec.ts tests/e2e/arabic-search.spec.ts \
    --workers=2 --repeat-each=3 --reporter=list
```

`6 passed (36.7s)`, exit 0 — the two affected specs run two-at-a-time against
the shared DB with no flake.

## 6. Contended run — full suite at `--workers=2` (unsupported mode)

Log: `aa2cbe8-contended-full-suite-workers2.log`.

```
$ DOKAN_PORT=5417 DOKAN_WEB_PORT=6273 bunx playwright test --workers=2 --reporter=list
```

`48 passed, 2 failed, 3 did not run`, exit 1. The two failures are both
first-run setup races, **not** the changed specs:

- `tests/e2e/00-onboarding.spec.ts:104` — `expect(locator).toHaveAttribute` at
  `:107`.
- `tests/e2e/vault.spec.ts:166` — `expect(locator).toBeVisible` (element not
  found).

`playwright.config.ts` ships `workers: 1` with the comment that all spec files
share one SQLite DB and parallel workers would race first-time setup; the issue
scope says not to restructure the suite, so this mode is out of scope. Both
changed specs passed in this run (`arabic-search` ok, `receipts` ok).

## Verdict

The two reported specs are proven robust: every write and the catalog search
read is server-acknowledged, the two controlled delays reproduce the exact
reported symptoms on the base specs, and three clean full-suite runs plus a
`workers=2` contended run of the affected specs are green. The only red
contended result is the suite's documented unsupported parallel mode.
