# Test audit — issue #215

Tier: **Standard**. Base `4bf10be`. Reviewed HEAD `9735d2a`.
Reviewer: independent `reviewer` sub-agent (read-only), two rounds
(`3a73b51` round 1, `9735d2a` round 2). Lens: `.agents/skills/test-audit`.

## Key question

> Does the cross-page test actually span two pages, or does it just re-run the
> single-page comparison?

**Yes — both tests place the correction in a different response than the badged
row.**

- API/router `resolves a superseded row whose correction is on a prior page`
  (`apps/api/src/rpc/router.test.ts`): `page1 = itemsHistory(limit 2, offset 0)`
  holds `[ordinary, correction]`; `page2 = itemsHistory(limit 2, offset 2)`
  holds only `[future]`. The correction row is read from **page 1**; the field
  asserted (`supersededBySeq === correction.seq`) is on a **page-2** row whose
  own response contains no correction. A page-local rule returns `null` here,
  so the test cannot pass on the old logic.
- Playwright `a superseded row is badged even when its correction is on a prior
  page` (`tests/e2e/stock-ledger.spec.ts`): sets `ui.pageSize=2`, opens
  `/items/<id>/history` directly, asserts page 1 has 2 rows and **no** badge,
  clicks `history-pager-page-2` (a second `itemsHistory` request, `limit 2,
  offset 2` containing only the future row), and asserts the badge is visible.
  The badged row's response has no correction row in it.

## Round-1 findings and disposition

| Severity | Finding | Disposition |
| --- | --- | --- |
| 🟡 | Router cross-page test under-asserted page length / page-1 nulls | **Fixed** — added `toHaveLength(1)`, `ordinary.supersededBySeq` null |
| 🟡 | Old-client additivity asserted but untested | **Fixed** — new test parses a real new payload with the pre-215 `stockMovementWithBalanceSchema` and asserts the unknown keys are dropped |
| 🟡 | Bundled unit test (`empty` + `no mutation`) | **Fixed** — split into two `it`s |
| 🟡 | E2E set `ui.pageSize=2` before paging the items list | **Fixed** — full suite had shown this hid the seeded item; now opens the history route directly |

## Round-2 residual notes (non-blocking)

- Same-second tie proof is unit-level (`stock-ledger.test.ts`) rather than
  wire-level; the API resolves it structurally (`seq > seq`, distinct rowids).
  Proof gap, not a behaviour gap.
- `recordedAfter`'s `seq` branch is unreachable for a payload that lacks the
  annotation entirely; documented as a defensive hedge.
- Router cross-page `it` is a bundle of ~10 expects for one scenario; each has a
  distinct failure mode.
- Page-1 length is implicit (`page1.movements[0]!/[1]!`).

## Verdict

**No red or orange findings.** Acceptance (a)–(f) each have a passing,
proportionately strong test. Reviewer re-ran the unit/router suites itself
(70 pass incl. all 14 #151 web cases + 3 router #215 tests) and verified the
Playwright mechanism by inspection; it did **not** re-run Playwright (needs the
slot harness) — the parent ran it (74 passed, see code-review evidence).

## Commands (parent, exit codes)

| Command | Result |
| --- | --- |
| `bun test apps/api/src/lib/stock-ledger.test.ts` | 50 pass, 0 fail — exit 0 |
| `bun test apps/api/src/rpc/router.test.ts -t "item history recording order"` | 3 pass, 0 fail — exit 0 |
| `bun test apps/web/src/pages/stock.test.tsx` | 20 pass, 0 fail — exit 0 |
| `bunx playwright test` (slot1, ports 4700/5700/4701/5701) | 74 passed, 0 failed — exit 0 |
