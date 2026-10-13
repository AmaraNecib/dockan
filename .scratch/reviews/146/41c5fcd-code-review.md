# #146 code review evidence (Standards axis, Spec axis)

- **Issue:** #146, one invoice-draft module behind the sale and purchase screens.
  This file covers the PR #188 review-fix round.
- **Tier:** Standard
- **Base SHA:** `fc951133134a9b0b18b5ae38f9658665c29e73ec` (`origin/develop`, merge-base)
- **Evidence HEAD:** `41c5fcdc39c56f3ca4c5a3369b2ee83cf3fbb06e`
- **Supersedes:** `6e0d153-code-review.md`.

## Provenance

A Standards child and a Spec child ran in parallel against `cdf32c6` (round 3),
and again against `4f1d810` (verification). Their findings are applied in
`41c5fcd`, which is the HEAD this file is named for. The Greptile review that
opened this round is quoted in full below.

## The review finding this round fixes (Greptile, PR #188, 4/5)

> **Quick-add forgets the category** (`apps/web/src/lib/use-invoice-draft.ts` ~179)
> After creating a purchase item, `setFields(spec.empty())` clears `categoryId`.
> The **old** purchase success handler cleared the item fields but kept
> `quickCategoryId`, so an owner could create several items in one sitting
> without re-picking the category. Now they must pick it again every time, or
> creation stops with `itemsChooseCategory`.

Confirmed as a regression this branch introduced, and fixed.

## Spec axis

### The Greptile finding

| requirement | status at `41c5fcd` |
|---|---|
| purchase keeps its category across a successful create | met: `keepOnCreate: ["categoryId"]`, with the reset rebuilding `empty()` plus the declared fields |
| every other purchase field still resets exactly as the old handler did | met: `empty()` reproduces the six cleared fields, including `qty` back to `"1"` |
| a test creates two items in a row from one pick | met at hook and page level |
| that test fails without the fix | met, measured two ways (see the test-audit evidence) |
| sale is checked and the answer stated | met: sale is unaffected, with the reason written in design doc section 4.2 |

### The sale question

The lane brief asked whether sale is silently re-seeding rather than preserving.
Answer: sale is not affected, and it was not preserving anything before this
branch either. The pre-#146 sale handler cleared no field (it closed the form),
and every open went through `openQuick()`, which rebuilt the bag and re-seeded
the first category. The new spec is `resetOnOpen: true` with `keepOnCreate: []`,
and `openForm` rebuilds `empty()` plus the seed, so the next form the owner sees
is identical to before.

One path did change, and it is the path the old code got wrong: a sale quick-add
always lands a line, so the draft is dirty while the cart holds it. If the owner
then removed that line, the stale typed values used to keep the draft marked
dirty and the header's New Sale action warned about work that no longer existed.
Clearing the fields at create time removes that stale warning. An earlier version
of the design doc claimed this as a general fix and was corrected in this round;
the paragraph now states the one path and nothing more.

### Original brief's hard rules

| rule | status |
|---|---|
| visual output and Arabic copy identical | met. This round changes no label, class, test id or copy string. The only user-visible strings involved are the existing placeholder and error message already asserted by tests. |
| money math preserved exactly | met. `invoice-draft.ts` (parser, totals, discount, payment pair) is untouched by this round; `nextBag` only rebuilds the quick-add field bag. |
| no server, contract or schema change | met. The round's delta touches `apps/web/**`, `.agents/wisdom/**` and `.scratch/**`. |
| the four open decisions | unchanged. Decision 3 (share the quick-add form) is still a `decisionRequest`; this round narrows nothing further. |
| out-of-scope files untouched | met (`items.tsx`, `item-picker-dialog.tsx`, `unknown-scan-dialog.tsx`, the router). |

### Scope creep

None found. The delta is the keep policy, its tests, the corrected doc paragraph
and one wisdom note. No behaviour was changed beyond the reported regression and
the invariants the reviews asked to pin.

## Standards axis

Standards sources: `docs/engineering-workflow.md`, `.agents/skills/guard/SKILL.md`,
`.agents/skills/codebase-design/SKILL.md`, `.agents/skills/unslop/SKILL.md`,
`.agents/skills/code-review/SKILL.md`, `CONTEXT.md`,
`apps/web/src/lib/numeric-input.ts`, `apps/web/src/lib/amount-parse.ts`,
`AGENTS.md`, plus the Fowler smell baseline.

### Round 3 and verification findings

| # | finding | class | disposition |
|---|---|---|---|
| 1 | the union duplicated `empty()` and its docstring across both arms, and the code disagreed with the shape the design doc described | baseline smell (Duplicated Code) | fixed in `41c5fcd`: a `QuickAddBag` base type |
| 2 | `nextBag` mutated the object `empty()` returned; the `empty()` docstring never promised a fresh object | judgement call, latent aliasing | fixed: the copy plus a docstring that states the requirement, and the mount state copies too |
| 3 | a non-literal `resetOnOpen: boolean` with an empty keep list still compiles, so the union is not total | judgement call | accepted, written into the design doc: the escape needs an empty keep list, so no self-contradictory spec is reachable |
| 4 | `satisfies QuickAddSpec<...>` at the call sites removed the `as const` the earlier round flagged | improvement | kept |
| 5 | the wisdom file's snippet showed the looser pre-union type | judgement call | fixed: the snippet shows both arms |
| 6 | em dashes in the new prose (a standing finding since round 1) | hard, documented standard (unslop rule 13) | no growth: this round's prose adds none, and the only `—` in the delta is the select placeholder glyph, which is user-visible copy |
| 7 | inference could be widened by a future `onCreated` edit | judgement call, latent | fixed: both call sites pass `F` explicitly |
| 8 | Speculative Generality (is a required keep list over-built?) | baseline smell | not sustained: there are two callers with genuinely different policies, so the seam is real, and the required field is what forces the policy to be stated |

No documented-standard violation remains in this round's delta.

## Verdict

- **Standards:** pass.
- **Spec:** pass. The Greptile finding is resolved with a falsifiable test, the
  sale question is answered and evidenced, and the original hard rules hold.
- **Open decision (unchanged):** the quick-add markup stays per-kind while its
  behaviour is shared. Design doc section 4.1 carries the field-by-field reason,
  and this is escalated to the parent rather than settled here.
- No blocker.
