# #244 test-audit — HEAD `390da2db0d2ddf6600bf5b5c9e5f8462699b2b34`

Base `746ff933753a0b409e96365080c91e3ef6efb5b6`. Three independent test lenses
(edge-case hunter, coverage analyst, quality reviewer), read-only sub-agents, plus
the mutation-proof run. All commands below were run on this HEAD.

## Gate runs (this HEAD)

| gate | command | exit |
|---|---|---|
| web unit suite | `bun run test` in `apps/web` | **0** — 1184 pass / 0 fail |
| repo suite | `bun run test` at root | **0** — web + api/contracts + scripts (73 pass) |
| typecheck | `bun run typecheck` | **0** |
| lint | `bun run lint` | **0** |
| ratchet | `bun test src/lib/blankness-ratchet.test.ts` | **0** (`390da2d-ratchet-green.log`) |
| e2e spec | `DOKAN_PORT=4617 DOKAN_WEB_PORT=5617 bunx playwright test tests/e2e/blankness-mark-only.spec.ts` | **0** (1 passed) |

## Ratchet-first evidence

`390da2d-ratchet-first-red.log`: a deliberately unclassified raw gate added to a
new file in scope reddens the ratchet, exit **1**:
`lib/ratchet-evidence-tmp.ts::draft.trim() === ""` under
"classifies every detected gate". The temp file was deleted; the green run is
`390da2d-ratchet-green.log` (exit 0). So the ratchet is stable on the untouched
tree first, then reddens on an unclassified gate.

## Per-site mutation proof

`390da2d-mutation-proof.sh 7f8f5c2` reverts each converted file to its
pre-conversion raw-`.trim()` form, runs the ratchet, records the exit code, and
restores the file. Full log: `390da2d-mutation-proof.log`. **11/11 files → exit 1.**

| converted file | signature(s) the ratchet named | exit |
|---|---|---|
| `lib/numeric-input.ts` | `trimmed === "" [text.trim()]` | 1 |
| `lib/supplier-opening-draft.ts` | `raw.trim() === ""`, `input.amount.trim() !== ""` | 1 |
| `components/parties/supplier-return-draft.ts` | `trimmed === "" [draft.trim()]` | 1 |
| `components/parties/supplier-return-panel.tsx` | `draft.trim() !== ""` | 1 |
| `components/ui/amount-percentage-input.tsx` | `percentageDraft.trim() !== ""` | 1 |
| `pages/invoice.tsx` | `trimmed === "" [draft.trim()]`, `(drafts[line.id] ?? "").trim() !== ""` | 1 |
| `pages/items.tsx` | `thresholdText === "" [threshold.trim()]`, `thresholdText !== "" [draft.threshold.trim()]` | 1 |
| `pages/stock.tsx` | `unitCost.trim() !== ""` | 1 |
| `components/parties/customer-settle-panel.tsx` | `value.amount.trim() !== ""` | 1 |
| `components/parties/supplier-pay-panel.tsx` | `value.amount.trim() !== ""` | 1 |
| `components/parties/supplier-adjust-panel.tsx` | `amountDraft.trim() === ""` | 1 |

14 distinct converted signatures are covered. The ratchet names each one under
"has every converted gate absent". The tree was restored after each mutation
(`git status` clean at the end of the log).

### e2e discrimination (screen path)

The one e2e spec is itself a mutation proof for the items threshold: with the raw
gate restored it fails (`1 failed`, exit 1 — the threshold error blocks the save);
on the fix it passes. `390da2d-mark-only-{broken,fixed}.png` are the visual pair.

### Honest ablation

`components/ui/amount-percentage-input.tsx`'s conversion is **outcome-neutral**:
`parseLooseNumber("\u200f")` is `0`, never `> 100`, so the raw-trim form returned
the identical value. No black-box assertion can discriminate it; the ratchet's
"converted gate must be absent" check is the discriminator, and the test comment
says so (same honesty as #238's `nextUnitCost` ablation; wisdom
`2026-10-16-latent-shape-mutation-proof.md`).

## Findings and dispositions

### Fixed this round
- **Scanner branches untested (coverage, high).** `INLINE_REV`, `INLINE_LEN` and
  the parenthesised form had no test. Added one synthetic-source assertion per
  form plus `?.trim()` (`blankness-ratchet.test.ts`).
- **`parseSignedWholeNumber` mark-only unpinned (edge).** Added null pins for
  `"\u200f"` and `"-\u200f5"`.
- **Partial mark-only on a multi-line form untested (edge).** Added DOM tests to
  `invoice-returns.test.tsx` and `supplier-return-panel.test.tsx`: a mark-only
  line drops while a valid line on the same form still submits.
- **Threshold boundary `"0"` unpinned (edge).** Added the create-form test that
  `"0"` persists `lowStockThreshold: 0`, distinct from a blank/mark-only default
  of `5` — the two meanings one keystroke apart.
- **Interior mark at a converted panel unpinned (edge).** Added a `party-settle`
  test: `1\u200f2` still shows the error (a refusal, never a blank).

### Dismissed / documented
- **Vacuous `amount-percentage-input` assertion (quality).** Kept, with the
  comment stating the ratchet is the discriminator — deleting it would drop the
  documented outcome. Not mistaken for coverage.
- **`draft-blankness.test.ts` new rows duplicate per-site tests (coverage).**
  Deliberate: the #238 table is the only place that drives the **whole**
  `PASTED_BIDI_MARKS` set at every pure reader, so it adds real coverage the
  per-site one-mark tests do not.
- **Scanner scope hole (coverage).** A numeric gate in a file that parses without
  importing a reader is unscanned. Documented as the scanner's known ceiling.

### Not reproducible
- Per-site isolation for the two collapsed signatures (`invoice.tsx`'s
  `returnQuantityError`+`customCashError`; `supplier-return-draft.ts`'s two
  functions): the signature is file+text, so a whole-file revert proves both at
  once. Recorded in `390da2d-debate.md`.
