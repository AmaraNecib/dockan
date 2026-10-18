# #229 — Code-review evidence (standards + spec)

- Base: `fc439cdf02ec6da112fd25271d839f133578ecd0` (PR #229 head)
- Reviewed HEAD: `c849bd3` (test-only commit)
- Method: two independent axes (Standards, Spec), run as separate sub-agents so
  neither masks the other. The parent reproduced each finding against the code.

## Standards axis

**Documented standards — no hard violations.**

- `.agents/wisdom/2026-10-15-extraction-must-not-tighten-money-readers.md`
  ("port the old predicate literally, including its generous cases, and pin
  those cases"): the zero-value "free line" case is restored via `l1`
  (`unitPrice: 0`) and now also asserts the return is saved.
- `.agents/wisdom/2026-10-15-cost-pin-proves-the-call-not-the-query.md`
  ("the pin must fail against the code it exists to reject"): the three
  mutation experiments show every changed pin failing against the behaviour it
  guards, and the pre-fix shapes passing.
- `docs/engineering-workflow.md` source-only policy: the e2e run's tracked
  `.dokan-port` churn was reverted; only the test file, the design doc and the
  evidence files are staged by name (never `git add -A`).

**Baseline smells — judgement calls, all dispositioned:**

- *Duplicated Code*: `itemId`/`description`/`quantity` repeat across the two
  fixture lines, and the `400000/600` rationale appears in two comments.
  Dismissed: the two lines are deliberately different fixtures and each role is
  named inline.
- *Mysterious Name*: `l1`/`l2` are matched to the `supplier-return-qty-{id}`
  test ids and explained by the comment above the fixture.
- *Stale describe label*: `(findings 3 and 8)` now also carries the #229 pins.
  Cosmetic; left to avoid rewriting an unrelated label.

## Spec axis (#229 brief)

**In-scope requirements: complete.**

- Finding 1 ("keep or restore the Arabic draft before submitting, so one
  assertion covers the same draft previewed and saved"): satisfied — the test
  types `٥`, previews `2000`, submits the same `٥` and asserts `quantity: 5`.
- Finding 2 ("keep a zero-price fixture for that test and use a priced fixture
  for the new preview checks — do not collapse them into one"): satisfied —
  two lines, `l1` zero-price, `l2` priced.

**Scope creep:** none. `git diff fc439cd c849bd3` touches only the test file
and `.scratch/`; no production source, no `#225`/`#227` work.

**Unchanged on purpose:** the `openSelect`/dynamic option driver and the
`await`-wrapped `submit()`/`act` helpers are untouched, as the brief requires.

**Implemented-but-wrong:** none found.

## Mutation discriminability (reviewed as written)

- Finding 1: mutating the submit reader to reject Arabic drops the `l2` draft,
  so `submitted[0]` is `undefined` and `toMatchObject` fails. If instead the
  shared `parseWholeAmount` were mutated, the earlier preview assertion fails —
  the pin holds either way.
- Finding 2: adding `value <= 0` to the INVOICE_LINKED disable condition fails
  `expect(confirmButton()?.disabled).toBe(false)` on the zero-price `l1`; with
  the old `400` fixture it would not fail.
- Refused-draft test: on the priced `l2`, a loose `Number()` revert renders
  `400000`/`600` instead of `0`, so both assertions fail.

## Notes

- The Spec-axis reviewer ran `bun test <file>` from the repo root and hit
  `document is not defined`; the supported invocation is
  `cd apps/web && bun test src/components/parties/supplier-return-panel.test.tsx`
  (the package `bunfig.toml` preloads `setup-happydom.ts`), which the parent ran
  green (9 pass / 0 fail). Environmental, not a delta defect.
