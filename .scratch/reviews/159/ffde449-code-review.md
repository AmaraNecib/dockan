# Code review — #159 + #160 + #166

**Tier:** Standard
**Base:** `0b4ec68` (`origin/develop`)
**Reviewed code:** `79ccbf4` (round 1 at `fc10dc8`)
**Gate artifact for HEAD:** `ffde449` (diff `79ccbf4..ffde449` = one wisdom doc)

Two axes, run as independent sub-agents, then a round-2 verification after the
fixes. The axes are reported separately and not reranked.

## Standards

Sources: `docs/engineering-workflow.md`, `docs/development-workflow.md`,
`AGENTS.md`, `oxlint.config.ts` (incl. `shadcn/no-raw-colors`,
`anti-slop/no-known-value-widening`, `require-safety-comment-for-type-assertion`),
plus the Fowler smell baseline.

Round-1 findings:

| Finding | Severity | Disposition |
| --- | --- | --- |
| Missing `.scratch/reviews/159/*` gate evidence | hard | **Fixed** — this file + `ffde449-test-audit.md` |
| Purchase card had no Playwright coverage (DoD §3) | hard-ish | **Fixed** — `purchase-intake.spec.ts` now opens the saved purchase by id |
| Router `Link` stub duplicated across four page tests | smell (Duplicated Code) | **Fixed** — shared `src/tests/router-mock.tsx` |
| `inputClass` and `<Input>` carry divergent token sets | smell (Duplicated Code / two sources of truth) | **Accepted, documented** — `<Input>` is the shadcn base for standalone fields (`h-8 w-full bg-transparent`); `inputClass` themes raw inline fields without changing their size, matching the existing raw inputs it replaced. A full unification is a separate restyle, not this lane. |
| `{id, invoiceNumber, remainingAmount, counterpartyName}` redeclared three times | smell (Data Clumps / Primitive Obsession) | **Fixed** — sale/purchase now hold the server's `InvoiceDetail` |
| `remaining > 0 ? detail : undefined` repeated in sale + purchase | smell (Duplicated Code) | **Accepted** — two call sites with different copy (customer debt vs supplier remaining); extracting now would be speculative |
| `variables.method ?? "CASH"` called dead defensiveness | smell (Speculative Generality) | **Rejected** — `invoicePayInputSchema.method` is optional, so the fallback is required by the type |
| `receipt-view` isolation assertion weakened | judgement | **Fixed** — additionally pins `cell-ltr` on the `<td>` whose CSS is pinned |
| import-group drift in the #160 sweep | non-issue | no documented import-order rule; oxlint does not enforce one |

Round-2: no remaining or new Standards violations; lint clean (0 errors).

## Spec

Spec sources: issues #159, #160, #166 and the crew brief.

Verified correct in the diff:

- Direct-by-id navigation: `savedSale.id`, `savedInvoice.id`, `savedReturn.id`
  — never a lookup by number.
- `LinkProposalPanel` is the card's following sibling (below the action row).
- `SuccessCardSpacer` precedes the "new / again" action → trailing edge in RTL.
- Currency: every new amount renders «دج» via `suffix={t("dzd")}`; no `DA`
  appears in the diff.
- All six audited cells use `.cell-ltr`; inline `<span dir="ltr">` runs are
  untouched.
- `.cell-ltr` is appended at the end of `index.css`; `vault/*` and `App.tsx`
  are untouched (#167's boundary).

Round-1 findings:

| Finding | Disposition |
| --- | --- |
| #160 "every input" not fully met — vault inputs still bare | **Deferred** — brief excludes `components/vault/*`; lane #167 owns them |
| #160 returns cash + quick-add/notes inputs keep one-off token strings | **Accepted** — they already carry `border-input` + focus ring (the issue's "or the token classes"); unifying with `inputClass` is a restyle |
| Purchase debt detail line was not explicitly requested | **Accepted** — the approved prototype shows it ("الباقي للمورّد 12,000 دج") |
| Payment card needs an extra «دفعة أخرى» click for a second instalment | **Accepted** — design-consistent with the return card; `invoice-payments.spec.ts` updated |
| `savedPrint` routes untested e2e | **Accepted** — the brief's required e2e is sale→open-invoice + return→voucher; the print route pre-exists (#121) |

Round-2: all round-1 findings verified resolved at `79ccbf4`; no missing
requirement and no unrequested scope beyond the prototype.

## Gates

```
git diff 0b4ec68...79ccbf4   # reviewed code
bun run typecheck            # 3 successful
bun run lint                 # 0 errors
bun run test                 # 642 pass / 0 fail
bun run test:e2e             # 47 passed
```

**Summary:** Standards — 1 hard (evidence, fixed) + 8 judgement (5 fixed, 2
accepted, 1 rejected). Spec — 5 findings, all accepted/deferred with rationale;
no missing requirement.
