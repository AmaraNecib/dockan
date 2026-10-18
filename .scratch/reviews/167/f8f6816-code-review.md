# 167 — Code review (Standards + Spec), review-fix round delta

**HEAD reviewed:** `f8f681623c12db12554a82a84de2c1b7bb101c9d`
**Previous evidence:** `15c39ea-code-review.md` (superseded — source changed)
**Delta reviewed:** `git diff 4271819b5d5ef7d83ff701cc5e68765469f138d0...f8f681623c12db12554a82a84de2c1b7bb101c9d`
**Commits in the delta:**
- `db149d0` fix(web): address #167 review findings in the password eye
- `f8f6816` fix(web): keep the object-ref and void callback-ref detach paths in PasswordInput

Two rounds of read-only sub-agents: round 1 reviewed `db149d0` and found a
regression the two fixes introduced; round 2 reviewed `f8f6816` after it was
fixed. Both axes **PASS** at `f8f6816`. Scope stayed on the two Greptile P2
findings; the only extra change is the detach-path regression those fixes
introduced.

## Round 1 (`db149d0`) — findings

Round 1 returned mixed verdicts: Standards PASS, both Spec and edge-case
reviewers **NEEDS-FIX** on the same defect:

- `attachInput` returned early on the detach (`node === null`) call, so a
  caller's **object ref was never nulled** and a **void callback ref never got
  the legacy `null` call**. Explicitly breaks the brief's
  *"Do not break the object-ref path or React 19 ref-as-prop."*
- Test-level: `attachedNodes[0]?.isConnected === false` was incidental (true for
  any unmount).

## Round 2 (`f8f6816`) — Standards

Verdict: **PASS**. `bunx oxlint` clean; no hard standard violations.

- The detach branch now clears `inputRef`, nulls an object ref, runs a stored
  cleanup, or calls a void callback ref with `null` — matching React 19's
  ref contract.
- The `as (() => void) | undefined` assertion is required (`void` is not
  assignable to `undefined`) and carries the `SAFETY:` comment the anti-slop
  rule demands; `typeof` is banned by the same ruleset, so the assertion is the
  sanctioned route.
- `"current" in ref` is the repo-sanctioned shape check given the `typeof` ban.
- `unmountRoot` filters the root out of `mountedRoots`, so `afterEach` never
  double-unmounts.
- Judgement-call notes only: `detachRef` is a slightly occasion-flavoured name
  (it holds the caller ref's cleanup); the detach branch's braces are
  asymmetric. Both cosmetic.

## Round 2 (`f8f6816`) — Spec

Verdict: **PASS**.

- FIX 1 satisfied: the callback's cleanup is captured and invoked from the
  detach path while `inputRef` is still cleared first; the object-ref and
  ref-as-prop paths are intact.
- FIX 2 satisfied: the test focuses the toggle, asserts it holds focus, then
  clicks and asserts the input regained focus. A programmatic click does not
  move focus, so removing the hand-back now fails the test.
- Round-1 regression fixed and covered by two new assertions.
- No scope creep: only `password-input.tsx` and `password-input.test.tsx`
  changed in this round.
- One clause remains inferable rather than directly asserted: `inputRef` is
  module-private and the subtree unmounts, so "the internal focus ref no longer
  points at the detached node" cannot be observed by public behaviour. The
  cleanup-run and object-ref-null assertions exercise the same detach branch.
  Recorded as a NOTE, not a blocker.

## Gates at `f8f6816`

- `bun run typecheck` — 0
- `bun run lint` — 0
- `bun run test` — 642 pass / 0 fail (49 files)
- `bunx playwright test` — 47 pass / 0 fail (full suite, includes
  `tests/e2e/vault.spec.ts` and `tests/e2e/login.spec.ts`)
- Four read-only delta reviewers (edge hunter, test quality, Standards, Spec):
  all **PASS**

### Environment note (not a code finding)

The first e2e attempt after `db149d0` failed at page load with a Vite error:
`[plugin:vite:react-babel] Cannot find module '@babel/helper-validator-identifier'`,
from a stale/partial `node_modules` (the top-level `@babel` tree was missing).
`bun install` did not repair it; `rm -rf node_modules && bun install` did, and
the full e2e suite then passed 47/47. The failure was environmental and
unrelated to the diff — no source file changed for it.
