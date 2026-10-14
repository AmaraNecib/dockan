# #146 code review evidence (Standards axis, Spec axis)

- **Issue:** #146, one invoice-draft module behind the sale and purchase screens.
  This file covers the PR #188 review-fix round 2.
- **Tier:** Standard
- **Base SHA:** `fc951133134a9b0b18b5ae38f9658665c29e73ec` (`origin/develop`, merge-base)
- **Evidence HEAD:** `c2fc0cf926bf57602715660ca9d264ba238b3e3c`
- **Supersedes:** `41c5fcd-code-review.md`

## Provenance

A Standards child and a Spec child ran in parallel against the round-2 delta
`dfe1ed8..a28acf2`, reading `AGENTS.md`, `CONTEXT.md`,
`docs/engineering-workflow.md`, `docs/development-workflow.md`,
`docs/branch-workflow.md`, the `codebase-design` skill, the brief, and design
doc section 8. The standards axis flagged the ordering invariant as a mild
Duplicated Code smell and deferred it; the spec axis passed every brief item. The
critic's discount finding was then fixed in `c2fc0cf`, which is the HEAD this
file is named for.

## The Greptile finding this round answers (PR #188, 4/5)

> **Quick-add forgets the category** (`apps/web/src/lib/use-invoice-draft.ts` ~179)
> After creating a purchase item, `setFields(spec.empty())` clears `categoryId`.
> The **old** purchase success handler cleared the item fields but kept
> `quickCategoryId`, so an owner could create several items in one sitting
> without re-picking the category.

**Verified stale.** The fix is already in the tree: `QuickAddSpec` requires
`keepOnCreate` (`use-invoice-draft.ts:143` at the PR head `dfe1ed8`), the reset
applies it (`:158`), and purchase declares `keepOnCreate: ["categoryId"]`
(`purchase.tsx:53`). No re-implementation. Closed on the PR with those
references — comment:
<https://github.com/AmaraNecib/dockan/pull/188#issuecomment-6157781564>.

## Spec axis

The brief's four asks, checked against `c2fc0cf`:

| requirement | status |
|---|---|
| purchase blames an unusable quantity before the payment, pinned by a test that fails without the fix | **met** — `purchase.tsx:128-141`; `purchase.test.tsx:809`, measured red at `dfe1ed8` |
| sale's order verified, changed only if wrong | **met** — old order was `resolveInitialPaid → discount → firstLineError`, the identical mask; now lines → discount → payment, pinned at `sale.test.tsx:1119` and `:1141` |
| the duplicated `QuickAddSpec` comment removed, one copy left above the type | **met** — survivor sits directly above `export type QuickAddSpec` |
| the stale category finding not re-implemented, closed with evidence | **met** — no code touched beyond the comment region; PR comment cites the three lines |

No requirement is missing or partial, no scope creep beyond the sale reorder the
brief explicitly authorized, and no implemented-but-wrong item was found.

## Standards axis

### Documented-standard breaches

None. No rule in `AGENTS.md`, `CONTEXT.md`, `docs/engineering-workflow.md` or
the `codebase-design` skill is violated by the delta. The comment deletion is
correct and behaviour-free.

### Baseline smell — Duplicated Code (judgement call, deferred)

`purchase.tsx:128-141` and `sale.tsx:254-285` both encode the invariant "raw
drafts first, then the values derived from them" and restate it in an `ORDER:`
comment. `firstLineError` and `resolveInitialPaid` are already shared; only their
*composition order* is copied. A single helper in `invoice-draft.ts` would put
the order beside the two rules it orders and collapse the comments.

**Decision: defer.** The screens differ enough (sale's discount and override
arms, purchase's supplier path) that a helper risks a shallow pass-through, and
the current order is correct and pinned per screen by tests. This is a
follow-up, not a blocker. Recorded in the debate evidence and the handoff.

## Verdict

Standards: no hard violation, one deferred judgement-call smell. Spec: all four
brief items met. No blocker at `c2fc0cf`.
