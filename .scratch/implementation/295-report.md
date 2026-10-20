# #295 — Client freshness: a sale in one window must show in the other

**Branch:** `t3/295-client-freshness-1` · **Base:** `bff7a1a`, merged with
`origin/develop` (`223d54a1`, #308) before the final commit
**Commits:** `f4856e0` (the change) → `6f39a41` (the debate fixes) → `97c9612`
(the evidence) → `f16890d` (the test-audit and code-review fixes) → `5a87f93`
(the refreshed report) → `61ba809` (the round-2 lens fixes: the 10s window, its
real edge, the checklist's background flag, the tick-bound test) → `99c7b7c7`
(the reader's real visibility flips) → `80d5084c` (the nine test-audit findings
and the schema index) → `ac797411` (the develop merge) → `b3f133fd` (the round-3
commit: Greptile's four findings, the lens round-3 findings, the mechanism
correction) → the round-4 commit (the away row made live, the e2e refusal's
body, the blank reason re-verified)
**Tier:** Standard. **Status:** lane done — committed, not pushed, no PR, no merge.

## The two questions, answered first

### 1. Does TanStack Query's focus refetch already satisfy criterion 1?

**No — and the reason is narrower than "it listens to the wrong event".** In
`@tanstack/query-core@5.101.4`
(`node_modules/@tanstack/query-core/build/modern/focusManager.js:55-60`)
`isFocused()` falls back to `document.visibilityState !== "hidden"`; the manager
registers `visibilitychange` and nothing else (`:12-15`), and nothing the
browser emits ever sets `#focused`. So:

- **Visible but unfocused** — two windows side by side, the ticket's case.
  `isFocused()` is already `true`, the interval fires with or without
  `refetchIntervalInBackground`, and no `visibilitychange` ever arrives, so
  `refetchOnWindowFocus` has nothing to fire on. The bounded tick is the only
  refetch trigger left.
- **Hidden or minimized.** `isFocused()` is `false` and only
  `refetchIntervalInBackground: true` keeps the interval running. Chromium
  throttles a hidden tab's timers (about 1/s, about 1/min under intensive
  throttling), so a minimized window converges on that pace, not on 5 s.

Measured in `tests/e2e/client-freshness.spec.ts` at the head, two tests, run
with `--repeat-each=2` (4 passed):

```
#295 measurement [visible-unfocused]: converged in 4004ms; reader visible and unfocused (browser says visible), focus events=0, visibility events=0, visible flips=0
#295 measurement [hidden]: converged in 3971ms; reader hidden to the app (browser says visible), focus events=0, visibility events=0, visible flips=0
```

The visible-unfocused test patches nothing: the reader really is an on-screen
window that never took the keyboard, which is the ticket. The hidden test is the
same pair with the reader's document pretending to be hidden, and it is the only
test where `refetchIntervalInBackground` is load-bearing. Both specs assert that
no `focus` and no `visibilitychange` event reached the reader, and both read the
browser's own visibility from `Document.prototype` so the counters can
contradict the page. The elapsed time is reported as a measurement, not asserted
as a bound: the tick's phase against the sale is arbitrary.

Ablations, each run at the head:

| Change | Result |
|---|---|
| `hotCounterRefresh`'s `refetchInterval` set to `false` | **both** e2e tests red (the count stayed at 0, no focus refetch) |
| `refetchIntervalInBackground` deleted | the visible-unfocused test stays **green**, the hidden one goes **red** |

The second row is the mechanism stated as a fact: the flag covers the hidden
window and nothing else.

### 2. What is the smallest honest change for criterion 3?

**A repeat-window guard on the existing append-only ledger.** The ledger never
overwrites a movement, so two windows posting the same adjustment do not
overwrite each other — they append twice, and the stock moves twice for one
intention. `stockAddManual` now refuses the second post inside a 10-second
window with `ORPCError("CONFLICT", { message: "STOCK_ADJUSTMENT_DUPLICATE" })`;
the first write stands.

The guard compares the incoming request against every movement **recorded**
inside the window, using the identity the request **expressed**: the item, the
kind, the signed quantity, the reason, the row's origin `ref`, plus a
caller-supplied business date and a caller-supplied cost when there is one.
Three fields stay out on purpose or join conditionally:

- a **server-stamped** date — two identical requests carry different stamps, so
  a stamp in the identity would make the guard dead on arrival (the trap #177
  closed for supplier adjustments with its `serverStamped` rule);
- a **derived** cost — an inflow that said no cost means "at the item's cost",
  and the server derives that at posting time. The first posting moves the
  average, so a derived cost in the identity would let the retry of a no-cost
  adjustment slip past;
- `ref` is in the identity unconditionally: an owner's typed adjustment has
  none, and the rows the SERVER posts carry theirs, so a purchase correction,
  supplier return or scrap can never be mistaken for the owner's own repeat.

A blank reason is `null` before the check and before the write: the contract
trims, so a field holding spaces arrives as `""` while an untouched field
arrives as `undefined`, and the two used to be different identities — which
moved the stock twice for one intention (Greptile round 3, P1).

**No schema column, no `packages/contracts` change, no new procedure, no
package, no port beyond loopback.** The `#181`-style `idempotencyKey` on the
input schema is exactly the contracts change criterion 4 forbids.

**One index is added**, `idx_stock_movements_item` on
`stock_movements(item_id, created_at)` (`apps/api/src/db/schema.ts:478`). The
guard's window read runs while the adjustment holds the write lock, and without
the index every adjustment full-scans the ledger. It is additive and idempotent
like every line in `SCHEMA_DDL`: no column, no `CURRENT_SCHEMA_VERSION` bump
(stays 6), no backfill, no row rewrite — it is built on the next boot from the
same array.

## What changed

**API**

- `apps/api/src/lib/stock-adjustment.ts` (new) — the identity of one stock
  adjustment, the 10s window, the cutoff, and the comparison.
- `apps/api/src/rpc/router.ts` — `stockAddManual` posts inside
  `withTransactionImmediate` (the guard reads and then writes, so the write
  lock comes first) and refuses a repeat with `CONFLICT` /
  `STOCK_ADJUSTMENT_DUPLICATE`.
- `apps/api/src/store/port.ts` + `drizzle-store.ts` — one new read,
  `listStockMovementsSince(itemId, recordedAfter)`: the movements recorded
  after a local stamp, in insertion order, with the window applied in sql.
- `apps/api/src/db/schema.ts` — the index above.

**Web**

- `apps/web/src/lib/freshness.ts` (new) — `HOT_COUNTER_REFETCH_MS = 5_000` and
  `hotCounterRefresh(refreshMs)`: the tick plus `refetchIntervalInBackground`,
  which is what keeps a hidden window's interval alive. The module's header
  states which lever carries which case.
- `apps/web/src/pages/items.tsx` — the items table (stock on hand) polls on
  that tick. It had no interval at all before. An open edit draft keeps its row
  on screen when a poll pushes it off the page, so Save and Cancel do not
  disappear while `draftDirty` blocks every other row (Greptile round 3, P1),
  and that row is read LIVE — the page window while it holds the row, the
  `itemsAll` catalog read on the same tick while it does not (Greptile round 4,
  P1). The draft's own snapshot is the last resort (a deleted row, or a failed
  catalog read), never the source of a number that is supposed to move.
- `apps/web/src/pages/dashboard.tsx` — the landing summary polls on the same
  tick, shortened from 60s.
- `apps/web/src/pages/stock.tsx` — an item's history (the running stock
  column) polls too.
- `apps/web/src/lib/pending-returns.ts` — the shared count keeps its 60s
  cadence and gains the background flag, so a hidden window's badge converges.
- `apps/web/src/lib/i18n.ts` — the refusal reads
  "نفس تعديل المخزون مسجّل قبل لحظات — لم يُطبَّق مرتين. أعد المحاولة بعد قليل." — the
  raw code never reaches the owner, and the message does not tell them to type a
  different reason to get past the guard (that advice was removed on purpose:
  the way past is time, not a reason written into the ledger).

**Tests**

- `apps/api/src/lib/stock-adjustment.test.ts` — 9 tests: the identity
  separates the actions that move the stock differently; a cost the request did
  not express is not compared; a server-stamped date is not compared and a
  caller-supplied one is; the cutoff lands on the window's edge in the server's
  own format.
- `apps/api/src/store/stock-ledger-store.test.ts` — the window in sql, and the
  index by name in `EXPLAIN QUERY PLAN`.
- `apps/api/src/rpc/router.test.ts` — 13 tests: two clients, one refusal, the
  first write survives; a different adjustment right after still records; an
  intervening movement does not hide the repeat; a no-cost repeat after the
  average moved is still refused; a repeat carrying the re-derived cost is
  refused; a repeat removal and two dated adjustments each get their own
  identity; two posts at the same time leave one movement; the window on the
  injected clock; a server row and the opening row must not refuse the owner;
  the window's boundary second; a blank reason and no reason are one identity;
  the guard opens the write lock rather than a deferred unit.
- `apps/web/src/pages/items.test.tsx` — the list polls, the query carries the
  background flag, an open draft survives its row leaving the page, the away
  row's stock number and low-stock badge keep moving while it is off the page,
  and the refusal is actionable.
- `apps/web/src/pages/dashboard.test.tsx` — the pending-return notice's NUMBER
  moves on the tick, not merely the fetch count.
- `apps/web/src/components/app/app-shell.test.tsx` (new) — the shell badge
  passes `SLOW_REFETCH_MS`, observed on the query observer that builds the
  browser's timer.
- `tests/e2e/client-freshness.spec.ts` — two windows, one sale, no reload: the
  visible-unfocused case and the hidden case, and a category seeded when the
  reset left the shop with none (so `--repeat-each` cannot fail on suite order).
- `tests/e2e-selection.map.json` — the new spec is reachable from the feature
  rules (the selection test failed without it).

## The commands, and what they said

| Command | Result |
|---|---|
| `bun run test` (full unit suite, heavy queue) | api **1088**, web **1442**, scripts **97** — **0 fail** |
| `bun run test:e2e -- client-freshness --repeat-each=2` (heavy queue) | **4 passed (52.5s)** |
| `bun run test:e2e` (full suite, heavy queue, lane ports 4481/5281) | **98 passed, 1 failed, 6 did not run (9.2m)** — the failure is `vault.spec.ts` timing out on the DEFAULT vault port 4399, which a sibling lane held; it passes on this lane's own pair |
| `bun run test:e2e -- vault` with `DOKAN_VAULT_PORT=4499 DOKAN_VAULT_WEB_PORT=5294` | **7 passed (25.3s)** |
| `bun run lint` | 0 errors |
| `bun run typecheck` | 4 tasks successful |
| `bun run skills:check` | 32 skills in sync |

**Ablations — each new test is red without its fix:**

- the API guard disabled → `router.test.ts:477` fails (exit 1);
- the web tick removed (`refetchInterval: false`) → both e2e tests fail;
- `refetchIntervalInBackground` deleted → the hidden-reader e2e test fails
  while the visible-unfocused one passes;
- the guard narrowed back to "the newest movement only" → the two new router
  tests fail;
- dropping the derived-cost rule → the re-derived-cost test fails;
- `withTransactionImmediate` → `withTransaction` → the write-lock pin fails;
- the shell badge handed `HOT_COUNTER_REFETCH_MS` → `app-shell.test.tsx` fails;
- the pending-return count frozen at its first read → the dashboard
  convergence test fails;
- the reason normalized in only one of the two places → the blank-reason test
  fails (either order kills its own half);
- the editor rendered from the page's rows alone → the off-page draft test
  fails;
- the away row rendered from the draft's snapshot (`liveDraftRow` narrowed to
the page) → the away-row stock test times out with the cell still reading the
  edit-time value;
- `postRpcInPage` throwing the status without the body → the refusal test fails
  on `Received: "itemsCreateWithStock failed with HTTP 400"`;
- `seedItem` reading `categories.items[0]` without the fallback → the second
  `--repeat-each` run fails on `undefined.id`.

## Deliberately left alone

- **No push, no PR, no merge** — parent-only work.
- **No schema column, no migration, no `packages/contracts` change** — criterion
  4. The one index is additive DDL: no version bump, no backfill.
- **No package added, no `bun add` / `bunx` / `npx`** — only
  `bun install --frozen-lockfile`.
- **No push channel, no outbox, no offline queue** — out of scope by the
  ticket; the tick is the honest v1 answer.
- **The 60s midnight day-lag** on the dashboard is now ≤5s. It was documented
  as deliberate; the read is cheap enough that the shorter tick is the point.
- **The item's ledger is not hashed** — the guard is a repeat-window, not a
  content hash over the whole history.
- **The `refreshMs` prop on the two pages** is test surface area. The dashboard
  shipped it before this change; the alternative (a context or an env knob) is
  worse.
- **A second identical adjustment inside 10s is refused.** The window covers
  the two threats and nothing more: a double-clicked save and a lost response
  re-sent as the same action. A typed second batch takes a few seconds too, so
  it is refused as well; the way past that is a moment later, not a different
  reason typed into the ledger.
- **The read-cost numbers are one measurement, not a promise** — 0.65 ms per
  `dashboardSummary` and 0.27 ms per `itemsList` (50 rows), sql only, on a shop
  of 20 items and 500 movements. There is no committed benchmark.

## Round 4 — Greptile's six findings at `b3f133fd`

**The two P1s were one defect, and they got one fix.** The round-3 commit made
an open draft keep its row visible when a poll pushed it off the page, by
rendering `draft.row` — a snapshot. The snapshot fixed the lost Save/Cancel and
created the freeze: a row the page no longer holds is a row the poll never
touches, so the stock number and the low-stock badge sat at their edit-time
values for as long as the edit stayed open. Patching the stock in a second
place would have left two owners of one row's truth. Instead the row is read
like every other row, from one value:

```ts
draft === null
  ? null
  : (pageItems.find((item) => item.id === draft.id) ??
    awayRow.data?.items.find((item) => item.id === draft.id) ??
    draft.row);
```

`awayRow` is the `itemsAll` read the stock form already mounts on this page,
put on the hot tick only while the row is away (`enabled`), so nothing extra is
read when no row is off-page and no new RPC exists. `draft.row` became the last
resort (a deleted row, or a failed catalog read). The editor keeps its buttons
because the same value renders it; the stock keeps moving because the same
value feeds it.

Red before green (ablation: `liveDraftRow` narrowed to the page):

```
(fail) items list hot counter (#295) > keeps the away row's stock live instead of freezing its snapshot (#295 round 4)
error: condition not met within timeout
  at waitFor (items.test.tsx:330:13)
  at async <anonymous> (items.test.tsx:513:11)
```

Line 513 is the assertion that the cell reads the number the other window wrote
(`3`, under the threshold, so the badge must appear with it). At the head the
cell still reads `7` and has no badge — one `expect()` ran, the second never
did.

**The four P2s.**

| Finding | Disposition |
|---|---|
| `packages/e2e-support/src/rpc-request.ts` dropped the refusal body | **Fixed.** The thrown error appends `: <response text>`, so a refused seed says which field or precondition the api wanted. Red: `Expected to contain: "CATEGORY_REQUIRED"` / `Received: "itemsCreateWithStock failed with HTTP 400"`. `tests/e2e/rpc-helpers.spec.ts` asserts the status prefix by substring, so it still matches. |
| `.scratch/reviews/295/*` is stale (newest reports cover `7998a8d`) | **Stated, not fabricated.** The paid lens rounds cannot be run from this lane. The free/local gates were run and are listed below; the three lenses (plus a fresh author review) must be re-run by the parent on this head. |
| `stockAddManual`: a space-only reason vs an untouched one | **Already fixed at `b3f133fd`**, re-verified: the normalization is one `const reason` used by both the guard and the write, and `router.test.ts` "treats a blank reason as no reason" covers both orders. Ablation re-run at this head (`const reason = input.reason ?? null`): `expect(refusedBlankFirst).not.toBeNull()` → `Received: null`, i.e. the repeat was admitted. |
| `client-freshness.spec.ts` dies on `--repeat-each=2` after its own reset | **Already fixed at `b3f133fd`**: `seedCategoryId` moved into `rpc-helpers.ts` and creates a category when the list is empty. Its red is an e2e run, which this lane does not own — the parent's `--repeat-each=2` is the proof. |

**The commands this round, run free and local:**

| Command | Result |
|---|---|
| `bun test src/pages/items.test.tsx src/lib/freshness.test.ts` (in `apps/web`) | **62 pass, 0 fail**, 164 expect calls |
| `bun test src/rpc/router.test.ts` (in `apps/api`) | **270 pass, 0 fail**, 1209 expect calls |
| `bun test src/rpc-request.test.ts` (in `packages/e2e-support`) | **5 pass, 0 fail** |
| `bun run lint` | 0 errors |
| `bun run typecheck` (`apps/web`, `apps/api`, `packages/e2e-support`) | clean |

The full unit suite and `test:e2e` were NOT run this round: both are heavy and
the parent owns them.

## The lenses

- **Debate** — round 1 on `zen-proxy/glm-5.3-flash-free`; its blockers are in
  `6f39a41`. Round 3 at `80d5084c` corrected this report: the background flag
  was described as covering the visible-unfocused case, which the dependency
  source contradicts (see question 1).
- **Test-audit** — round 1's five fixes are in `f16890d`; round 3's P2s are in
  the round-3 commit (the write-lock pin, the shell badge's calm bound, the
  pending-return number instead of a fetch count).
- **Code-review** — round 1's gaps are in `f16890d`; round 3 found the branch
  carried review evidence develop had deleted (#308) and that this report
  described a superseded head — both fixed in the round-3 commit.
- **Greptile** — round 3 at `80d5084c` returned 3/5 with four findings. Three
  were code (the off-page editor, the blank reason, the e2e's category seed)
  and are fixed with a mutant each; the fourth (stale review evidence) was the
  report itself.
- **The gate still needs the three lenses at the FINAL head.** `guard`
  compares each `<sha>-<lens>.md` with HEAD and calls the evidence stale when
  reviewable files changed since — and every lens fix moved the head.
- **Round 4: the saved reports are stale and were NOT re-run.** The newest
  files under `.scratch/reviews/295/` read `7998a8d`, which is three commits and
  three behaviour changes behind this head (the API's repeat guard, the polling
  wiring, the e2e spec). The paid lens routes are not available to a lane, so
  no new report was written and none was invented: the free gates above are
  what this round actually measured. The parent owes a fresh author review plus
  a full `debate` → `test-audit` → `code-review` round on the round-4 head
  before the branch is mergeable.
