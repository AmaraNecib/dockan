# #204 — Code-review evidence (two axes)

Head reviewed: `aae4a7f` (code identical to `e4d1e73`; the delta since is the
`.agents/wisdom/2026-10-15-live-write-gates-not-captured-render-values.md` lesson
only — a reviewable docs file, no code). Full findings retained in
`superseded/e4d1e73-code-review.md`.
Base: `8a7a7fa35de501efee15a802430193003926633d`
Method: independent Standards and Spec `reviewer` agents.

## Standards

Sources: `docs/engineering-workflow.md`, `CONTEXT.md`, `AGENTS.md`, `.agents/wisdom/*`,
`.agents/skills/*`.

| Finding | Disposition |
|---|---|
| No documented-standard violations. Pure seam beside `openingRowStatus`; no mirrored tie-break (server stays the resolver, #184); i18n keys only; tests assert via `i18n.t`. | clean |
| Duplicated guard body in `save`/`submit`. | **Fixed**: one live helper `removalBlocksSave()`. |
| Divergent change (state + effect + guards + disabled wiring). | Accepted; each site named and commented. |
| Naming drift `dropped`/`removed`. | Accepted; consistent in context. |
| Feature envy / data clumps (`setRow` stamps name; lib input shape ≠ `RowDraft`). | Accepted; mirrors #184's identity snapshot, minimal structural shape. |
| Primitive `string` ids. | Accepted; matches the existing page/RPC seam. |
| `name ?? ""` blank-name fallback. | Pinned by a pure test; unreachable today. |
| `role="alert"` containing a button. | **Fixed**; button moved outside the live region. |
| Dirty tracked runtime artifact `.dokan-port`. | Restored before the final commit; never staged. |

## Spec (GitHub issue #204)

| Requirement | Status |
|---|---|
| Filled draft whose supplier vanishes refused on save or clearly surfaced | covered — named notice + Save disabled and refused in both write paths |
| A test drives fill → refresh-remove → owner told / save blocked | covered — pure, component, and Playwright e2e (`visibilitychange` drives the real refetch-on-focus path) |
| Assert on i18n keys, not hardcoded Arabic | covered |
| Empty/unfilled rows may drop silently | covered — three-level negatives |
| "never silent" vs "only a filled row": invalid amounts (`0`/`abc`) drop silently | **Deferred**, documented (issue scopes to a filled amount) |

Scope creep: none behavioural. Implemented-but-wrong: none after the round-1 fixes.

## One-line summary

Standards: 0 hard violations (3 judgement-call smells accepted, 3 fixed); Spec: all
acceptance items covered, 1 documented deferral, 0 blockers.
