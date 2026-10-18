# 167 — Test audit (review-fix round, delta)

**HEAD reviewed:** `f8f681623c12db12554a82a84de2c1b7bb101c9d`
**Previous evidence:** `15c39ea-test-audit.md` (superseded — source changed)
**Delta from:** `4271819b5d5ef7d83ff701cc5e68765469f138d0` (previous HEAD)
**Tier:** Standard
**Method:** read-only sub-agents over the delta, plus mutation checks run locally.

## Scope of this round

Two Greptile P2 findings on PR #168 plus one regression the delta review itself
caught.

### Fix 1 — callback-ref cleanup was dropped

`attachInput` called `ref(node)` for a callback ref and ignored its return
value, so a React 19 cleanup function was lost.

Now: the returned cleanup is held in `detachRef` and run from the detach path,
`inputRef` is nulled on that path, and `attachInput` returns `undefined` so React
always takes the null-detach path (returning the cleanup would make React skip
it).

### Fix 2 — the focus hand-back test was non-vacuous

The test focused the input and then called `.click()` on the toggle; a
programmatic click does not move focus, so the assertion passed even with the
hand-back removed.

Now: focus the toggle, assert it holds focus, click, assert the input regained
focus.

### Regression caught by the delta review (fixed in `f8f6816`)

The first attempt at Fix 1 returned early on `node === null`, so a caller's
**object ref was never nulled** on detach and a **void callback ref never
received its legacy `null` call** — a break of Fix 1's explicit "do not break
the object-ref path" clause. Three independent reviewers flagged it. The detach
branch now branches on the ref shape and on whether a cleanup was stored.

## Tests added / changed

| Test | Contract pinned |
|---|---|
| `"forwards the ref and the native input props to the input element"` (extended) | object ref is set on mount and `null` after unmount |
| `"calls a void callback ref with null on detach"` (new) | a callback ref that returns nothing keeps the legacy `null` notification |
| `"runs a callback ref's cleanup on unmount"` (new, renamed) | a callback ref that returns a cleanup has it run exactly once on unmount |
| `"returns focus to the input after a toggle"` (fixed) | focus is on the toggle before the click, so the hand-back is required |

## Mutation checks (run locally, then reverted)

| Mutation | Expected failure | Result |
|---|---|---|
| remove `inputRef.current?.focus()` | focus hand-back test | FAIL as expected |
| remove `detachRef.current?.()` | cleanup test | FAIL as expected |
| remove `ref.current = node` (object-ref set) | object-ref test | FAIL as expected |
| remove `ref(null)` on detach | void-callback test | FAIL as expected |

## Review findings and dispositions

**Fixed**

1. *Object-ref detach regression* (HIGH, three reviewers) — covered above.
2. *Incidental `isConnected` assertion* — the test name was corrected to
   `"runs a callback ref's cleanup on unmount"`; the cleanup counter is the real
   assertion. The `isConnected` line is retained only as a
   disconnected-node sanity check.

**Dismissed / deferred (non-blocking, all with reasons)**

- *`detachRef.current === undefined` would throw for a JS callback returning a
  non-function falsy.* Compile-guarded for TS callers and an invalid React ref
  contract; `typeof` is banned by the repo's anti-slop rule, so a runtime guard
  would need `instanceof Function` — not worth code for an unreachable caller.
- *A throwing cleanup leaves `detachRef.current` set.* React re-attaches and
  overwrites; hygiene only.
- *Ref-identity change across re-renders is correct but untested.* Probed
  read-only: the old cleanup runs exactly once and the node is released. Left
  untested to keep this round scoped to the two findings.
- *The "internal focus ref no longer points at the detached node" clause is
  inferable, not directly asserted.* `inputRef` is module-private and the whole
  subtree unmounts, so no public behaviour can observe it; the cleanup-run
  assertion and the object-ref-null assertion exercise the same detach branch.
- *"inner `null` call absent when a cleanup exists" is not asserted.* A one-line
  counter would pin it; deferred as a cosmetic test nit rather than a new commit
  that would invalidate this reviewed SHA.

## Result

`bun test src/components/ui/password-input.test.tsx`: 9 pass / 0 fail.
`bun run test`: 642 pass / 0 fail (49 files).
`bunx playwright test`: 47 pass / 0 fail (full suite, includes the vault and
login specs).
Four read-only delta reviewers (edge hunter, test quality, Standards, Spec):
all **PASS**.
