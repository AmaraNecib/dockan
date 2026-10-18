# #227 — Debate evidence (critic + defender)

- Base: `origin/develop` @ `6708324`.
- Reviewed HEAD: `e472d5b`.
- Method: two opposing sub-agents (harsh critic, charitable defender) on a
  read-only checkout, plus a real-browser (headless Chromium) bidi probe and an
  invariant sweep. The parent reproduced every load-bearing claim.

## Why the debate gate ran

The brief recorded **Standard**; the workflow's failure-mode table
(`docs/engineering-workflow.md`, #228) puts "a total is computed wrongly" under
High-assurance, and this diff sits on the invoice-total path. Round 1 of this
lane proved the tier mattered: a mark-only sale override went from *refused* to
*billed free* — a moved total. The High-assurance gates (debate, test-audit,
code-review) were run; the record keeps the brief's Standard label visible so the
parent can confirm or re-label.

## Critic findings and dispositions

The critic found **no must-fix (no finding ≥ 8)**. Dispositions:

| Finding | Sev | Disposition |
|---|---|---|
| LRO/RLO inclusion in the safety claim was wrong for the overrides (an override renders forced order) | 5 | **Fixed** — LRO/RLO are excluded from the strip and refused edge and interior; a boundary pin asserts it. Measured: edge `\u202e123` renders `321`. |
| Mark-only override billed the line free (round-1 regression) | 🔴 | **Fixed** in an earlier round — `draftBlank` makes mark-only «nothing chosen» (invalid + default price) for both AMOUNT and PERCENTAGE. |
| Carrying the review-evidence files | 5 | **Fixed** — this file and the two sibling evidence files land at the reviewed SHA. |
| The mark class is spelled twice (`PASTED_BIDI_MARKS` / `DRAFT_CONTENT`) | 3 | **Accepted** — the `g` flag must differ for `.replace` vs `.test`; documented. |
| `name` drift on `normalizeArabicIndicDigits` | 4 | **Accepted, tracked** — doc comment states the widened contract; rename deferred to avoid churn in the readers #225 edits. |
| Interior LRE/RLE/PDF do not reorder adjacent digits | 3 | **Fixed wording** — the design now says the rule is positional and refuses them as a lost acceptance, never a lost value. |
| `nextUnitCost` mark-only moves from `previous` to `0` | 2 | **Disclosed + pinned + documented** as the one value-changing reader, consistent with the field's cleared-field-zero contract. |
| LRO is a no-op for a digit run (only RLO reverses) | 3 | **Fixed wording** — the design says RLO reverses and LRO is excluded conservatively with it. |
| `draft[index] ?? ""` dead defensive code | 1 | **Accepted** — cosmetic. |

## Defender's position

The defender rated the core defences 9–10/10: the single choke point; the exact
edge rule; the LRO/RLO exclusion; `draftBlank` closing the free-line hole
(additive — differs from the old `.trim()` on only the mark-only shapes); the
clean rebase with zero duplication of #210/#229/#225; and the pins. The two
honest limits it names — positional over-refusal of display-safe interior marks,
and the uncentralised "blank" concept — are disclosed in the design and cannot
bill a different number.

## The decisive evidence

- **Invariant sweep:** 17 bases × 10 marks × every insertion position × 4 readers
  — `reader(marked) ∈ {reader(bare), refusal}` in every case, 0 violations. The
  strip can turn a refusal into the intended read; it cannot turn one number into
  another.
- **Browser measurement (`dir="rtl"`):** edge marks leave the digit run intact;
  interior ALM/RLM/RTL-isolates reorder it (`1\u200f2` → `21`); LRO/RLO force
  display order (`\u202e123` → `321`). Hence: edge-only strip, interior refusal,
  override refusal.
- **Pre-fix reproduction:** `parseWholeAmount("\u200f٥")` = `null`,
  `parseWholePercentage("\u200f١٠٠")` = `null`, `parseLooseNumber("\u200f")` =
  `NaN` on the base; the mark-only override billed `0` at the strip-only
  intermediate.
- **Gates at `e472d5b`:** typecheck exit 0, lint exit 0, `bun run test` exit 0
  (web 1133 pass / 0 fail), sale-checkout e2e exit 0 (5 passed).
