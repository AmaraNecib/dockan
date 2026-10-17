# #256 round 3 — evidence

Greptile scored PR #269 4/5 at `911ad509` and named five findings. This round
closes all five on the branch `fix-256-round2`.

## 1 + 3 + 5 — measurements (not visual)

| Finding | Red (before) | Green (after) |
| --- | --- | --- |
| 1 explicit return spills | `bun test src/rpc/router.test.ts -t 'own invoice after a payment'` → `expect(accepted.debtApplied).toBe(200)` — Received: **300** (100 spilled onto the other invoice) | same command → 2 pass |
| 3 unknown split savable | `bun test src/pages/invoice-returns.test.tsx -t 'split is unknown'` → `expect(submit.disabled).toBe(true)` — Received: **false** | same → 1 pass |
| 5 vacuous ordering test | the old pair (`INV-0009`/`INV-0010`) agreed under a lexical compare too; the new pair (`INV-9999`/`INV-10000`) fails under it (see the ablation below) | 40 pass in `return-calculations.test.ts` |
| v6 column migration | `drizzle-store.test.ts` "migrates a v5 returns table" asserts the ALTER ran and a pre-existing row reads own-invoice-only | 1 pass |

### Ablations (does each new guard actually bite?)

| Mutation | Test | Result |
| --- | --- | --- |
| `compareInvoicesOldestFirst`: numeric sequence → lexical string compare | `return-calculations.test.ts -t 'numeric sequence'` | **FAIL** — the assertion `toEqual(["b","c"])` breaks |
| `returnsAccept`: `if (left > 0 && existing.spreadsAcrossInvoices)` → `if (left > 0)` | `router.test.ts -t 'own invoice after a payment'` | **FAIL** — Expected 200, Received 300 |
| `submit()`: `if (splitUnknown)` → `if (false)` (the disabled button left in place) | `invoice-returns.test.tsx -t 'split is unknown'` | **FAIL** — a raw form submit reaches `returnsCreate` (`lastCreateInput` not null) |
| drop the `ALTER TABLE returns ADD COLUMN spreads_across_invoices` | `drizzle-store.test.ts -t 'v5 returns table'` | **FAIL** — `toContain("spreads_across_invoices")` on `PRAGMA table_info` |

The third ablation is the one that matters for wisdom 2026-10-12 ("a disabled
button is not the guard"): with only the button removed the red run failed at the
`disabled` assertion, so both the button and the handler are pinned.

## 2 — visual (before/after images + video at real user pace)

`tests/e2e/returns.spec.ts` → "the derived settlement method and its preview come
back for the next return after a save (#256 round 3)" — the real screen: an
unpaid 2 × 900 sale, a 1-unit debt-defaulted return, save, then "تسجيل مرجوع"
for the next one.

| Artifact | What it shows |
| --- | --- |
| `round3-before-blank-method.png` / `round3-before.webm` | on `911ad509`, the post-save assertion fails at line 418: the method reads the placeholder **«اختر طريقة التسوية»** |
| `round3-after-method-restored.png` / `round3-after.webm` | on this round, the same step reads **«كله خصم من الدين»** and the split preview returns |

The videos were recorded with the shared `playwright.config.ts` wrapped by a
throwaway config that only turns `video: "on"` (the repo records no video on
purpose); that wrapper is not part of the commit.

## Boundary coverage added after the test-audit lens

* explicit return whose own invoice is settled before acceptance (own = 0) — nothing is relieved;
* explicit all-cash return accepted (debtOffset 0) — no invoice moves;
* the supplier hint's DIRECTION is pinned (`علينا للمورّد`, and not `لنا عند المورّد`).

| Command | Result |
| --- | --- |
| `bun run typecheck` | 4/4 tasks |
| `bun run lint` | clean |
| `apps/api: bun run test` | 961 pass / 0 fail |
| `apps/web: bun run test` | 1288 pass / 0 fail |
| `bun run test:e2e` (ports 4700/5700/4701/5701) | 96 pass / 0 fail — `e2e-full.log` |

## Review findings — the lane's responses

The independent code-review lens at `4378574` ranked three P2 must-fixes. Two
were taken; one is REFUTED with line evidence.

1. **Orphan comments (`invoice.tsx:565`)** — taken: the two lines left where the
   removed mirror effect used to be are deleted.
2. **"every existing row predates the tab-wide rule"** — taken: the comment on
   `spreads_across_invoices` (`schema.ts`, `core.ts`, `drizzle-store.ts`) now
   states what the DEFAULT 0 does to the only other source of such rows, a v5
   database from this PR's own round-2 build — the promise reads
   own-invoice-only, so its excess stays owed instead of being relieved on an
   invoice the owner never named (conservative, never misdirected). Evidence that
   v5 has never shipped: `git merge-base --is-ancestor 7020666 origin/develop`
   exits non-zero.
3. **"`rows.length > 0` treats an existing-but-empty `returns` table as absent"**
   — REFUTED. `rows` is `PRAGMA table_info(returns)`, which returns ONE ROW PER
   COLUMN, never a row count: an existing table with zero rows still yields its
   column descriptors, so the ALTER runs. Only a table that does not exist yet
   skips it — and there `SCHEMA_DDL` creates it with the column. The same gate
   already guards `cash_paid_out`, `debt_offset` and `debt_applied` above it.

Not taken from the nice-to-have list: collapsing `settlement` + `settlementChosen`
(that is a wider refactor of a form with three writers, out of this round's
scope), and dropping `spreadsAcrossInvoices` from the wire contract (it IS
consumed — `returnsAccept` reads it through `getReturnDetail`, the store's
`ReturnDetail` being the contract type; the five fixture updates are the explicit
cost of a required field on a shared type).
