# #227 — Code-review evidence (standards + spec)

- Base: `origin/develop` @ `6708324` (PR #229/#210 and #225 merged).
- Reviewed HEAD: `e472d5b`.
- Method: two independent axes (Standards, Spec) as separate sub-agents, so
  neither masks the other. The parent reproduced each finding against the code.
  The change was rebased onto current `develop` before this round; no #210/#229/
  #225 work is duplicated (`git grep PASTED_BIDI_MARKS|stripEdgeBidiMarks|draftBlank`
  on `origin/develop` → none).

## Standards axis

**Documented standards — no hard violations.**

- `docs/engineering-workflow.md` (Review tiers, #228): the tier is recorded as
  **High-assurance** with a one-line failure-mode justification next to the
  verdict — "a total is computed wrongly" (a line override feeds the invoice
  total), and the brief's Standard label is kept visible. The tier follows the
  failure mode, not the diff size.
- `AGENTS.md` / `.agents/wisdom/2026-10-01-rtl-dates-bidi-and-align.md`: the RTL
  claim is *measured in Chromium*, not reasoned (`1\u200f2` renders `21`,
  `1,\u200f000` renders `000,1`, `-\u200f5` renders `5-`), which is exactly the
  wisdom rule ("verify bidi in a real browser; `textContent` returns the logical
  string").
- `.agents/wisdom/2026-10-15-extraction-must-not-tighten-money-readers.md`: the
  ASCII path is byte-identical (`normalizeArabicIndicDigits("123") === "123"`) and
  `draftBlank` differs from the old raw `.trim()` on only the mark-only shapes,
  so no pre-existing input changes resolution.
- Policy #235: the branch contains **no `.agents/wisdom/**` change**; the lesson
  is in this lane's `crew_report`.
- `docs/engineering-workflow.md` source-only policy: only the six source/test
  files and `.scratch/` evidence are committed; `.dokan-port` churn and
  `test-results/` were reverted, never staged with `git add -A`.

**Baseline smells — judgement calls, all dispositioned:**

- *Duplicated Code (mild)*: the ten-code-point class is spelled twice
  (`PASTED_BIDI_MARKS` and `DRAFT_CONTENT`). Accepted: the flags must differ
  (`replace` wants `g`; `test` must **not** have `g` or `lastIndex` makes it
  stateful), and a shared class string would hide that. Documented in the design.
- *Mysterious Name (mild, accepted)*: `normalizeArabicIndicDigits` now maps digits
  *and* drops edge marks. The doc comment states the widened contract; the rename
  was considered and deferred to avoid churn in the readers #225 edits.
- *Dead defensive code (nit)*: `draft[index] ?? ""` — cosmetic, left to keep the
  diff minimal.
- *Speculative Generality (rejected)*: stripping the embeddings/isolates beyond
  the brief's named three is the same character class, produced by the same paste
  path, and both boundaries are pinned; not scope creep.

## Spec axis (#227 issue + brief)

**In-scope requirements: complete.**

- Strip location: the one normalisation step (`normalizeArabicIndicDigits`) every
  reader shares — one private helper, one call, no second site.
- Which marks + exclusions: the ten edge marks are named in the code comment and
  the design, with reasons; LRO/RLO excluded and refused; ZWSP/WJ/BOM and the
  legitimate separators documented as not dropped.
- Safety argument: a money draft is digits/sign/grouping/decimal only, all
  visible; a mark renders as nothing, so at the draft's edge dropping it can only
  turn a refusal into the read the owner intended. Interior marks are refused
  because they reorder the run in the RTL page.
- ASCII identity: `"\u200f123"` → 123 and plain `123` unchanged, pinned both ways.
- Each affected reader pinned, including the #225-routed `parseWholeNumber` /
  `parseSignedWholeNumber` / `resolveOpeningStock` and `nextUnitCost`.
- Paste-shaped test: marks are *built* from `"\uXXXX"` escapes (never an invisible
  literal), in unit tests and in the e2e `.fill()` + `toHaveValue` pin.
- Pre-fix failure: reproduced and recorded (see the test-audit evidence).
- Tier + justification: recorded (High-assurance).

**Scope creep:** none beyond the `draftBlank` predicate, which exists solely to
close the free-line regression the strip itself introduced (round 1 proved a
mark-only override billed `0`).

**Implemented-but-wrong:** none found.

**Unchanged on purpose / deferred:**

- `nextUnitCost(" \u200f", x)` now returns the cleared-field `0` where pre-#227 it
  kept the previous cost — the one reader whose *read value* moves. Consistent
  with that field's documented "a cleared field is an explicit zero" contract;
  pinned and documented.
- `percentageDraftInvalid` and `resolveInitialPaid` still refuse a mark-only draft
  via raw `.trim()`; unifying "blank" behind one predicate is a payment-path
  behaviour change deferred to its own ticket, with `draftBlank` as the seed and
  the current refusals pinned so the deferral is visible.

## Commands at `e472d5b`

`bun run typecheck` exit 0; `bun run lint` exit 0; `bun run test` exit 0 (web
1133 pass / 0 fail); `bun run test:e2e tests/e2e/sale-checkout.spec.ts` exit 0,
5 passed. Full breakdown in `e472d5b-test-audit.md`.
