# #204 — Code-review evidence (two axes)

Head reviewed: `e4d1e73`
Base: `8a7a7fa35de501efee15a802430193003926633d`
Diff: `git diff 8a7a7fa35de501efee15a802430193003926633d...e4d1e73`
Method: independent Standards and Spec `reviewer` agents in one fan-out.

## Standards

Documented sources: `docs/engineering-workflow.md`, `CONTEXT.md`, `AGENTS.md`,
`.agents/wisdom/*`, `.agents/skills/*`.

| Finding | Disposition |
|---|---|
| No documented-standard violations. Pure seam beside `openingRowStatus`; no mirrored tie-break (server stays the resolver, #184); i18n keys only, tests assert via `i18n.t`. | n/a — clean |
| Duplicated guard body `if (hasRemovedFilled) …` in `save`/`submit`. | **Fixed**: one live helper `removalBlocksSave()`, called from both. |
| Divergent change (five touch points for one behaviour). | Accepted: inherent to a state + effect + guards + disabled wiring; each site is named and commented. |
| Mysterious naming drift (`dropped`/`removed`). | Accepted: `droppedFilledDrafts` (pure seam) vs `removedFilled` (page state) read consistently in context. |
| Feature envy / data clumps: `setRow` stamps the name with `suppliers.find`, and the lib input shape diverges from `RowDraft`. | Accepted: the draft records the identity it was typed against (mirrors #184's snapshot); the lib input is intentionally the minimal structural shape. |
| Primitive `string` ids. | Accepted: matches the existing page/RPC seam; no new domain type introduced for one screen. |
| `name ?? ""` could render a blank name. | Pinned by a pure test; unreachable today (every `setRow` seeds a name). Deferred copy decision documented. |
| `role="alert"` containing a button; no focus handoff. | **Fixed** (button moved outside the live region); focus intentionally not stolen. |
| Dirty tracked runtime artifact `.dokan-port`. | Restored before the final commit; not staged. |

## Spec (GitHub issue #204)

| Requirement | Status |
|---|---|
| Filled draft whose supplier vanishes refused on save or clearly surfaced | covered — named notice (`supplierOpeningRemovedRow{{name}}` + `<Amount>`) and Save disabled + refused in both write paths |
| A test drives fill → refresh-remove → owner told / save blocked | covered — pure, component, and Playwright e2e (`visibilitychange` drives the real refetch-on-focus path) |
| Assert on i18n keys, not hardcoded Arabic | covered — `i18n.t(...)` in unit/component tests |
| Empty/unfilled rows may drop silently | covered — pure + page + e2e negatives |
| "never silent" vs "only a filled row" — invalid typed amounts (`0`, `abc`) drop silently | **Deferred**, documented: the issue scopes to a filled amount; invalid rows are already save-blocked while they exist |

Scope creep: none behavioural. The dismiss affordance and the identity snapshot are
the minimum machinery for the requested block/flag.

Implemented-but-wrong: none found after the round-1 fixes.

## One-line summary

Standards: 0 hard violations (3 judgement-call smells accepted, 3 fixed); Spec: all
acceptance items covered, 1 documented deferral, 0 blockers.
