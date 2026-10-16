# #229 — Test-audit evidence

- Base: `fc439cdf02ec6da112fd25271d839f133578ecd0` (PR #229 head)
- Reviewed HEAD: `c849bd3` (the test-only commit; this file is committed after it)
- Method: 3 independent auditors (edge-case hunter, coverage analyst, quality
  reviewer), run as separate sub-agents in parallel, then the parent reproduced
  every finding against the code before acting.

## Final grades

| Test file | Grade | Note |
|---|---|---|
| `apps/web/src/components/parties/supplier-return-panel.test.tsx` | A− → A | both #229 pins now discriminate; zero-value pin now covers the save, not only the enabled predicate |

## Findings actioned

1. **Blocker (both Greptile findings) — confirmed and closed.**
   - Finding 1: the Arabic test previewed `٥`/saved ASCII `5`. Now it types `٥`
     on the priced line, asserts preview `2000`, submits the *same* `٥` draft and
     asserts `quantity: 5`. An ASCII-only submit reader leaves `submitted` empty.
   - Finding 2: the shared `unitPrice: 400` fixture had erased the zero-value
     case. Now `l1` is `unitPrice: 0` for the "free line" pin and `l2` is
     `unitPrice: 400` for the #210 preview pins — two fixtures, not one.
2. **Gap (coverage) — the zero-value test pinned only `disabled === false`.**
   The submit handler could still have refused a zero-value return. **Fixed**:
   the test now also `await submit()`s and asserts the saved `l1` line. Mutation
   3 below proves the new assertion fails against a submit-side zero-value block.
3. **Gap — the refused-draft preview test was inert on a zero-price line.**
   On `l1` (`unitPrice: 0`) every draft previews `0`, so it passed against the
   loose `Number()` reader it exists to reject. **Fixed** by moving it to the
   priced `l2`, where the loose reader renders `400000` (`1e3`) / `600` (`1.5`).

## Accepted / not fixed

- Base UI `SelectPositioner` `act()` warnings: pre-existing test noise from the
  `openSelect` helper, unchanged by this delta.
- `previewAmount()` reads the last digit run and assumes ungrouped `Amount`
  output. The helper's docstring already states that assumption; a future
  locale-grouping change to `Amount` would silently weaken it.
- Multi-line, zero, negative and non-numeric drafts are already unit-pinned in
  `supplier-return-draft.test.ts`; not re-pinned at panel level.
- `l1`/`l2` names and the small fixture duplication are intentional; each line's
  role is stated in the comment above it.

## Mutation evidence (parent-run, source reverted immediately)

Each mutation was applied to the production source locally, the pin was run, and
the source was reverted (`git diff --quiet` confirmed the production files
pristine before the commit).

1. **Finding 1 pin** — `parseReturnQuantities` reverted to an ASCII-only reader
   (`/^\d+$/u.test(trimmed) ? Number(trimmed) : null`), preview reader untouched:
   - old shape (ASCII `5` before submit): **pass** (false negative)
   - new shape (submit the `٥` draft): **fail** — `submitted[0]` was `undefined`
     because the draft was rejected as invalid.
2. **Finding 2 pin** — INVOICE_LINKED confirm gate changed to
   `!invoiceReady || value <= 0` (wrongly disabling zero-value returns):
   - new zero-value pin on `l1`: **fail** (`Expected: false, Received: true`)
   - old shape (collapsed `unitPrice: 400` fixture, no zero-preview assertion):
     **pass** (false negative)
3. **Zero-value save assertion** — submit handler changed to
   `... || value <= 0` (block the zero-value save while the button stays
   enabled):
   - strengthened zero-value pin: **fail** (`submitted[0]` undefined).

## Verification (at `c849bd3`)

- `bun run typecheck` — exit 0 (4/4 turbo tasks).
- `bun run lint` — exit 0.
- `bun run test` — exit 0; `@dokan/web` 1070 pass / 0 fail, scripts 38 pass /
  0 fail.
- `bun run test:e2e tests/e2e/sale-checkout.spec.ts` — exit 0, 4 passed
  (includes the #210 Arabic-Indic flow). Run on lane-isolated ports
  `DOKAN_PORT=4417 DOKAN_WEB_PORT=5273`; `.dokan-port` reverted afterwards.
- Touched file: 9 pass / 0 fail, 25 assertions.
