# Code review — #256 round 3 (STANDARDS + SPEC)

- Repo: `D:/projects/mani-worktrees/fix-256-round3`
- HEAD: `4378574` (`test(returns): pin the v6 migration…`), round-2 base `911ad509`
- Diff reviewed: `git diff 911ad509..4378574` (24 files, +654/−27)
- Brief: `D:/projects/mani-project/.scratch/sessions/crew/briefs/fix-256-round3.md`
- Read first: `.agents/skills/code-review/SKILL.md`, `.agents/wisdom/2026-10-15-live-write-gates-not-captured-render-values.md`,
  `.agents/wisdom/2026-10-15-shared-reset-drops-per-caller-state.md`
- Lens: correctness/standards first, spec closure second. No source file modified.

## Verdict

**Ship-able.** All five Greptile findings are **closed** (none refuted), the money direction is
right, the migration is additive and version-gated, and the two hand-restored files are
complete and contain only the intended changes. Findings below are comment-accuracy, one dead
comment block, and three design/debt items — **no P0/P1 blocker**.

---

## (0) Incident check — `router.ts` and `invoice.tsx` truncated and restored by hand

Verified positively, not by assumption:

| Check | Result |
| --- | --- |
| `apps/api/src/rpc/router.ts` intact | 2324 lines; ends with a complete `requireBarcode()` helper and its doc comment (no dangling code). Diff = **3 hunks only**, all `#256 round 3` (`spreadsAcrossInvoices` decl, `= true` in the derived branch, the `returnsAccept` spread guard). |
| `apps/web/src/pages/invoice.tsx` intact | 1083 lines; ends with a complete `InvoicePage` (`</section>);}`). Diff = **6 hunks only**, all round-3 (settlement doc, `displayedSettlement`/`splitUnknown`, `requestedCash`+`cashIsValid`, `projectionIsValid`, effect deletion, `submit()` guard, banner, `CUSTOM` onChange, submit `disabled`). |
| Duplicated blocks | None. `ReturnsPanel`'s JSX chain is balanced end-to-end (`<div>` → saved/`<form>` conditional → `</form>` → `)}` → `</div>);}`), and `InvoicePage` renders `PaymentPanel` + `ReturnsPanel` exactly once each. |
| No unintended change smuggled in the restore | Nothing outside the round-3 topics appears in either file's diff. |
| Working tree | Clean; only untracked `.scratch/reviews/256/**` (reports/evidence, correctly untracked). |

One residue worth naming (P3, **pre-existing, not from this diff**): `apps/api/src/rpc/router.test.ts:3821`
has `it("applies accepted offsets sequentially, …, async () => {    const item = await …` — the
body starts on the `it(` line. It is a **context** line in this diff (unchanged since `911ad509`),
so it is not a round-3 regression, but it looks exactly like a hand-restore artifact from an
earlier round and is a one-line fix.

---

## (a) SPEC — the five Greptile findings

All five **closed**. **None refuted.**

### 1. Explicit returns spill across invoices — CLOSED
`apps/api/src/rpc/router.ts:1603` declares `let spreadsAcrossInvoices = false`; it is set `true`
at `:1627` **only** inside the `input.cashPaidOut === undefined` (derived-default) branch, and
`:1652` persists it. Acceptance gates the cross-invoice loop on the persisted flag:
`router.ts:1779` `if (left > 0 && existing.spreadsAcrossInvoices)`. The rule is recorded, not
re-derived at accept time — which is the point of the finding. Own-invoice relief at `:1770`
(`own = Math.min(left, acceptedInvoice.remainingAmount)`) is unchanged, so explicit returns now
keep the pre-#256 "excess stays unapplied" behaviour.
Evidence: four tests in `router.test.ts:3719` (explicit + payment-before-accept → `debtApplied 200`,
other invoice untouched), `:3749` (defaulted return still spreads → `debtApplied 300`, other
invoice relieved by 100 — the contrast that stops the guard from silently killing the feature),
`:3779` (explicit whose own invoice is settled → relieves nothing), `:3803` (ALL-CASH `debtOffset 0`
is a no-op).

### 2. Next return loses its preview — CLOSED
The mirror is gone: the `useEffect` that called `setSettlement(derivedPreset)` is deleted
(`invoice.tsx` hunk `@@ -542,19 +556,15 @@`) and the displayed value is derived every render:
`invoice.tsx:497` `const displayedSettlement = settlementChosen ? settlement : derivedPreset;`.
Because it is recomputed, clearing the form cannot leave it blank while `derivedPreset` is
unchanged — the exact failure mode. `settlement`'s doc comment (`:377-382`) now states the
new invariant. Covered by `invoice-returns.test.tsx:1004` (save an untouched all-debt return,
re-open, method reads «كله خصم من الدين» and the split preview returns), plus the real-screen
e2e evidence in `.scratch/reviews/256/round3/` (`round3-before-blank-method.png` vs
`round3-after-method-restored.png`).

### 3. Unknown defaults can be saved — CLOSED (both gates, per wisdom 2026-10-12/2026-10-15)
`invoice.tsx:505` `const splitUnknown = !settlementChosen && derivedSplit === null;`
→ button `disabled={create.isPending || splitUnknown}` (`:956`) **and** an in-handler guard
(`:625-629`) that `setError(t("returnsSplitUnknown"))` + `return` before `create.mutate`, i.e.
a raw form submit cannot bypass the disabled control. The owner is told why
(`data-testid="returns-split-unknown"`, `:889`) and an explicit pick clears it, so the block
is not a dead end. Pinned by `invoice-returns.test.tsx:1027` (disabled, `lastCreateInput === null`
after a raw submit, banner present, then explicit `ALL_DEBT` submits with `cashPaidOut: 0`).

### 4. Supplier hint reverses the debt — CLOSED
`apps/web/src/lib/i18n.ts:929` now reads `الافتراضي: يُخصم من الدين الذي علينا للمورّد (لا نقد)`.
Direction is right: the hint appears only when the default is debt, which happens when the shop
owes the supplier, and `علينا` = "on us". The direction itself is pinned by a test (README
"boundary coverage" row 3, `supplier-return-panel.test.tsx` +5), which is the right response to a
copy bug — a string change with no test is the thing that regresses.

### 5. Ordering test misses string sorting — CLOSED
`return-calculations.test.ts:378-390` uses `INV-9998 / INV-9999 / INV-10000` and keeps
`expect(...).toEqual(["b", "c"])`, which a lexical compare fails ("INV-10000" < "INV-9999").
The comment now explains *why* this pair and why the old pair was vacuous. Ablation recorded in
the README (numeric → lexical compare ⇒ red).

---

## (b) STANDARDS

### Money path — correct
- Direction/ownership: nothing in this round touches who-owes-whom; the only direction-sensitive
  copy (`supplierReturnDefaultDebt`) was the bug and is now right.
- Totals (`router.ts:1765-1800`): `left = Math.max(0, debtOffset − debtApplied)`; own invoice first
  (`min(left, remaining)`, `left -= own`); then per other invoice `take = min(left, open.remainingAmount)`
  with `left -= take` and `continue` on `take <= 0`; `debtApplied` is set to
  `debtApplied + Σ relieved` from the *same* `relieved` array that writes the attribution rows.
  So the applied total can never exceed the promise, no invoice can go below zero, and the
  attribution sum equals `debtApplied` by construction. The refused UPDATE still throws and rolls
  the unit back.
- Supply side: `ReturnInsert.spreadsAcrossInvoices` is **required** in `port.ts:118-120`, so no
  call site can silently default it; `toReturn` (`drizzle-store.ts:356`) and both create/accept
  return projections (`:1974`, `:2017`, `:2058`) carry it.
- Not client-spoofable: the flag is derived from *absence* of `cashPaidOut` on the input, and the
  web sends `cashPaidOut: settlementChosen ? requestedCash : undefined` (`invoice.tsx:648`) —
  a request cannot set the flag directly.

### Schema version 5→6 (ADR-0008)
- Bump is justified and the doc block (`schema-version.ts:36-44`) is accurate about the *mechanism*:
  a v5 build does not name the column, so its INSERT succeeds via `NOT NULL DEFAULT 0` and every
  new return is silently written own-invoice-only — a silent behavioural downgrade, not an SQL
  error, which is precisely the class the bump exists to stop; the existing "refuse a newer
  database" path then refuses it. Good.
- **P2 Note (comment accuracy):** the claim "`DEFAULT 0` is exactly right for every existing row
  (all of them predate the tab-wide rule)" (`drizzle-store.ts:1039-1041`, repeated in
  `schema.ts:156-159` and `packages/contracts/src/core.ts:624-626`) is false for one real case: a
  **schema-v5 database written by the round-2 build** (`7020666`) can already hold *pending*
  returns recorded under the tab-wide rule with no flag; the 0 backfill silently demotes them to
  own-invoice-only, so their leftover will no longer spread. That build never shipped (it lives
  only on this branch), so the blast radius is dev/demo databases — but the comment should say
  "every row written by a *released* build", and the round-3 note should record the accepted
  limitation. Minimal fix: one sentence in `drizzle-store.ts` + the two doc comments.
- Naming/default/backfill: `spreads_across_invoices INTEGER NOT NULL DEFAULT 0`, Drizzle
  `{ mode: "boolean" }`, DDL and `ALTER` agree, `ALTER` is idempotent via `PRAGMA table_info`.
  Name reads as the permission it encodes; no rename needed.
- **P2 Note (inherited migration hole, now higher-blast-radius):** `drizzle-store.ts:1044` gates the
  `ALTER` on `rows.length > 0`, using "no `PRAGMA table_info(returns)` rows" as "table absent". A
  database created by an old build whose `returns` table is **empty** is indistinguishable from an
  absent table, so the `ALTER` is skipped while every Drizzle select now names
  `spreads_across_invoices` → `no such column` on the first returns read. This is the *same* gate
  the pre-existing `cash_paid_out` / `debt_offset` / `debt_applied` migrations use (so the pattern,
  not the bug, is new here), and the new column enlarges the blast radius because it is in the
  table's default projection. Minimal fix: gate on
  `SELECT name FROM sqlite_master WHERE type='table' AND name='returns'`, or add a test that
  migrates a v5 DB whose `returns` table exists and is empty (the current new test only covers a
  table with a pre-existing row). Verify first that `SCHEMA_DDL` runs before
  `ensureReturnsSettlementColumns`; if it does, the exposure is limited to pre-DDL databases.

### Wire contract — `spreadsAcrossInvoices` on `returnSchema`
Justified in principle (it is a persisted money-relevant fact and the only way a client can ever
explain why an accepted return shows `debtApplied < debtOffset`), but **P3 Note: it currently has no
consumer.** No web code reads `record.spreadsAcrossInvoices` in this diff; the cost so far is
fixture churn in five test files (`returns.test.tsx`, `return-voucher.test.ts`,
`return-voucher-view.test.tsx`, `supplier-return-panel.test.tsx`, `pagination-store.test.ts`) plus
`invoice-returns.test.tsx`. `returnSchema` is the read model, so an unread field is speculative
generality by the smell baseline. Cheapest resolution that pays for itself: consume it — on the
accepted-return card next to `debtOffsetDisplay(savedReturn.status, savedReturn.debtOffset, savedReturn.debtApplied)`
(`invoice.tsx:441`), explain a shortfall ("سُدِّد من هذه الفاتورة فقط…"), which is exactly the
"why didn't my tab-wide return spread?" support question this flag exists to answer. Otherwise keep
it off the wire and read it store-side.

### React state design in `ReturnsPanel`
- Right direction: displayed value **derived** (`displayedSettlement`), state holds only the owner's
  choice. The `CUSTOM` editor correctly records its own choice (`invoice.tsx:904` `setSettlement("CUSTOM")`)
  because the visible value is derived while untouched — without that line an edit would be
  attributed to the wrong preset. Good catch in the implementation.
- Reset path is coherent: `onSuccess` clears `drafts`/`reason`/cash pair/`cashSource`/
  `settlementChosen`/`settlement` (`:588-596`), and nothing needs to re-seed because nothing is
  mirrored. This is the wisdom-2026-10-15-shared-reset class done correctly — the reset declares
  everything the form owns.
- **P3 Note (`settlement` + `settlementChosen` is one fact in two states):** `settlement` may hold a
  stale non-null value while `settlementChosen` is `false` (the `returns-debt-confirm` button,
  `:876-884`, only flips the flag), so correctness rests on an invariant that lives in a comment.
  Two states encoding "the owner's explicit preset, if any" is the same divergence shape that
  produced finding 2. Minimal simplification: drop `settlementChosen` and use
  `const [explicitSettlement, setExplicitSettlement] = useState<ReturnSettlementPreset | null>(null)`
  with `displayedSettlement = explicitSettlement ?? derivedPreset`, `splitUnknown = explicitSettlement === null && derivedSplit === null`,
  `cashPaidOut: explicitSettlement === null ? undefined : requestedCash`, and
  `null` (not `false`) as the reset. Net −1 state, invariant unrepresentable.
- **P3 Note (write gate reads render state):** `splitUnknown` is a render value read in the
  submit handler. Today that is sound — `submit()` has **no `await`** before `create.mutate`, and
  React dispatches the current handler, so wisdom 2026-10-15 ("a live write gate, never a captured
  render value") does not bite. Record it: if a resolver is ever introduced between the click and
  the mutate (the #204 shape), this gate must move to a ref. No money risk either way, since the
  server re-derives the split and is authoritative.
- **P3 Note (degraded read blocks more than it must):** when the party-tab read *fails*,
  `partyDebtQuery.data` stays `undefined` → `partyDebt === null` → nothing derived, so the untouched
  save is blocked until the owner picks a method. Conservative and explained on screen, but if
  `derivedRefundSplit` also returns `null` when the return fits entirely inside this invoice's debt
  (no cross-invoice choice exists there), the block is broader than the risk it covers and the copy
  ("دين الزبون غير معروف") overstates the problem. Worth confirming against
  `returnSettlementDefault`/`derivedRefundSplit` in `@dokan/contracts`.

### Dead code / comment accuracy
- **P2 — orphan comment block survives the effect deletion.** `apps/web/src/pages/invoice.tsx:565-567`
  now holds three free-floating lines with no statement under them:
  ```ts
  // the derived default stays visible until the owner picks: no mirror state,
  // so it cannot outlive the form it belonged to
  // collected-so-far on this invoice vs the settled cash portion: soft warning, never a block
  ```
  The first two describe a mechanism that no longer exists (the deleted mirror), and they read as
  documentation for `cashExceedsCollected`, which they are not. Minimal fix: delete those two lines
  (keep the `cashExceedsCollected` one). This is the textbook residue of an effect deletion; a
  reviewer should not have to diff against `911ad509` to know it is stale.
- Otherwise comment accuracy is high and unusually good: the accept-path comment (`router.ts:1610-1613`,
  `:1773-1778`) states the rule, the failure mode and why legacy rows are safe; the contracts block
  explains why the numbers alone cannot distinguish the two rules.

### RTL / Arabic copy
- `returnsSplitUnknown` (`i18n.ts:612`) reads correctly and is RTL-safe (plain Arabic, no LTR
  tokens embedded, so no bidi isolation needed); the hint `supplierReturnDefaultDebt` is fixed as
  above. The new banner uses `border-warning/40 bg-warning/10 text-warning` matching the existing
  warning pattern in the same panel (`returns-debt-cap-note`, `returns-cash-warning`), and carries a
  `data-testid`. The select's placeholder («اختر طريقة التسوية») is now the only "unknown" state
  the owner can see, which is consistent.
- Nit (no action): the same sentence renders twice if the owner submits blind (banner + error
  paragraph). Correct belt-and-braces, just worth knowing when reading the screen.

---

## Ranked findings

| # | Pri | Location | Why | Minimal fix |
| --- | --- | --- | --- | --- |
| 1 | **P2** | `apps/web/src/pages/invoice.tsx:565-567` | Two orphan comment lines left where the deleted mirror effect was; describe removed behaviour and read as docs for the next statement. | Delete the two lines. |
| 2 | **P2** | `apps/api/src/store/drizzle-store.ts:1039-1041` (+ `db/schema.ts:156-159`, `packages/contracts/src/core.ts:624-626`) | "every existing row predates the tab-wide rule" is false for a v5 DB written by the round-2 build (`7020666`): its pending returns were promised tab-wide and the 0 backfill demotes them silently. Unreleased build ⇒ dev DBs only. | Reword to "every row written by a released build", and record the accepted limitation. |
| 3 | **P2** | `apps/api/src/store/drizzle-store.ts:1044` | `rows.length > 0` treats an *existing but empty* `returns` table as absent → `ALTER` skipped, while every Drizzle select now names the column. Inherited pattern (same gate as `cash_paid_out`/`debt_applied`), larger blast radius. | Gate on `sqlite_master` table presence; add a test migrating a v5 DB with an empty `returns` table. |
| 4 | P3 | `apps/web/src/pages/invoice.tsx:378-386` | `settlement` + `settlementChosen` encode one fact in two states; `settlement` can be stale non-null while the flag is false. Same divergence shape that caused finding 2. | Collapse to `explicitSettlement: Preset \| null`. |
| 5 | P3 | `packages/contracts/src/core.ts:650` | Required wire field with no consumer; fixture churn across five test files. | Consume it on the accepted-return card to explain `debtApplied < debtOffset`, or keep it store-side. |
| 6 | P3 | `apps/web/src/pages/invoice.tsx:505`, `:625-629` | Gate reads a render value; sound today (no `await` before `mutate`) but fragile if a resolver is added. | Note in the comment; move to a ref if an await ever appears. |
| 7 | P3 | `apps/web/src/pages/invoice.tsx:505` + `i18n.ts:612` | A failed party-tab read blocks *every* untouched save, even when the return fits inside this invoice's debt (verify `derivedRefundSplit`). | Narrow the gate to the case that actually needs the tab, or soften the copy. |
| 8 | P3 | `apps/api/src/rpc/router.test.ts:3821` | `it(... async () => {    const item = …` — body on the header line. **Pre-existing** (context line since `911ad509`), not a round-3 regression, but looks like an earlier hand-restore artifact. | Split the line. |

## What is already good (evidence)
- Finding 1 closed *behaviourally*, with the contrast test that proves the guard did not kill the
  approved default (`router.test.ts:3749`).
- Finding 3 closed with **both** gates and a test that a raw submit is refused — wisdom-aligned.
- Finding 2 closed by *removing* state, not by adding another effect to patch the effect.
- Migration is a single idempotent `ALTER` with a version bump, honest doc block, and a test that
  a pre-existing row reads own-invoice-only.
- `ReturnInsert.spreadsAcrossInvoices` required ⇒ the compiler forces every future insert site to
  answer the question.

## Limits of this review
I read the diff, both restored files end-to-end, `returnsCreate`/`returnsAccept`, the migration
block, the contracts/schema/i18n changes and the two new test blocks. I did **not** execute
`bun run typecheck`, `bun run lint` or the test suites in this lane (tool budget), and I did not
re-derive `returnSettlementDefault`/`derivedRefundSplit` from `packages/contracts` — the two P3
notes that depend on them are marked as needing confirmation. The red→green and e2e evidence is
taken from `.scratch/reviews/256/round3/README.md` + `e2e-full.log`, not re-run here.
