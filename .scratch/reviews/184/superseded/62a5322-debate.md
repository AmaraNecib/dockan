# Debate evidence — #184 review-fix round 4 (PR #190)

- Fixed point `c25b66a`; review head `9705b23`; final code head `732ce7c`;
  latest commit `62a5322` (this evidence's header SHA, the wisdom/evidence docs
  commit).
- Tier: **High-assurance** (opening-balance money math). One critic + one
  defender (`reviewer`), focused on the round-4 implementation (the predicate and
  its single guard), not test quality.

## Critic findings

| # | Score | Finding | Disposition |
|---|-------|---------|-------------|
| C1 | 5 | The predicate is a **weaker copy of TanStack's own link guard** (`link.js` tests `!defaultPrevented && target` too). It ignored `target`, so adding `target="_blank"` to the back link later would reintroduce the exact round-4 bug: a plain click would abandon in a tab the owner never left. | **Fixed at `732ce7c`**: the predicate now reads `event.currentTarget.getAttribute("target")` and requires it to be absent/empty/`_self`. Pinned by a new test (`keeps the dialog open when the back link targets a new tab …`) that fails on `1329f69` and passes on `732ce7c`. `defaultPrevented` omitted on purpose: our handler runs first in `composeHandlers([onClick, handleClick])` (critic-verified), so it cannot be set yet; `disabled` does not exist on anchors. |
| C2 | 4 | `event.button === 0` is dead — React's `onClick` binds the native `click`, which only fires for the primary button. | **Accepted, kept**: the brief explicitly asks to ignore `button !== 0`, and it matches the router guard. The test comment records that real middle-click emits `auxclick`. |
| C3 | 3 | YAGNI seam — module-level `navigatesCurrentTab` has one call site. | **Dismissed**: the brief asks for a class fix, one predicate is that fix, and the standards axis explicitly endorsed the module-level placement (pure, matches the `asDirection` precedent). |
| C4 | 2 | Comments cite "(Greptile round 4)" — review-bot provenance noise. | **Dismissed**: the file already annotates review provenance throughout (`review round 1 F1`, `review round 3`, `Greptile round 3`); removing one instance would be inconsistent. |
| C5 | 2 | `ReactMouseEvent` drops anchor specificity. | **Dismissed (conflict)**: the standards axis flagged `ReactMouseEvent<HTMLAnchorElement>` as over-narrow because the predicate ignores the element. The predicate now reads `currentTarget.getAttribute` (an `Element` method), so the generic-free type is the honest one. |

Critic also verified: no double-handling with TanStack's `handleClick` (ours
never calls `preventDefault`), touch/pen synthesises `button === 0` (no false
negative), and no residual new-tab abandonment window from the unmount /
`resolveKey` / `leave()` paths.

## Defender (confidence)

- Predicate correctly sized, mirrors HTML activation flags — 9/10.
- Placement right (module scope, pure, one divergent place) — 8/10.
- Guarding only the back link is sufficient (other triggers are buttons /
  keyboard / programmatic) — 8/10.
- `dismissalRef` generation is the correct mechanism (`attemptRef` cannot serve
  it: an existing-row edit must not suppress the refresh) — 9/10.
- The activation table is the right test (one case per predicate term, plus the
  plain-click polarity control, plus `resolveCalls === 2`) — 8/10.

Defender's honest caveat (agreed): the `button: 1` case is synthetic because real
browsers emit `auxclick`, which React's `onClick` never sees; the term is pinned
synthetically.

## Synthesis

One in-scope major (C1) → **fixed at `732ce7c`**. C2 accepted because the brief
requires it; C3–C5 dismissed with the reasons above. No deferred work, no
follow-up issue needed.
