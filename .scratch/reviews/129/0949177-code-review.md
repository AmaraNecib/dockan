# Code-review evidence — issue #129 (round 2 review-fix)

**Base:** `21dbc13f13d1889646f4466e610decf5a077253b` (`origin/develop`).
**Reviewed/worktree SHA:** `0949177bf07b12d59876049203cc55f105ca1f52`.
**Round-2 commits:** `f8151fa`, `42bee2c`, `0949177`.
**Product code unchanged since `0631081c1a30ac6e0df37b046f95064407985e9d`;
round-2 delta is `tests/e2e` and `.agents/wisdom` only.**

Two read-only review agents (Standards, Spec) ran on `f8151fa`, then again on
`42bee2c`; the parent applied the second round's recommendations. Findings below
are the resolved state. No open blocker.

## Standards

Documented standards: `docs/engineering-workflow.md`,
`docs/development-workflow.md` (Definition of Done), `AGENTS.md`,
`oxlint.config.ts`, `.agents/skills/guard/SKILL.md`.

**Verdict: PASS.**

- **The deferred-read anti-pattern is gone.** `rpcOutput` and `expectRpcOk` are
  deleted; `actAndAck` returns the acked output and reads the body eagerly
  (`rpc-helpers.ts:33-68`). Repo-wide grep finds no remaining reference.
- **Every retained type assertion has a `SAFETY` comment that matches the code**
  (`rpc-helpers.ts:36-38`, `104-107`). The earlier comment that claimed a
  runtime shape check which did not exist was corrected; at `0949177` the check
  exists (`hasOwnProperty`), so the comment is true.
- **Anti-slop rules are satisfied without evasion.** `no-runtime-typeof` forbids
  a `typeof` envelope guard; `zod` is not importable from `tests/e2e` (it is a
  dependency of `apps/web`/`packages/contracts`, not the test lane). The guard
  uses `Object.prototype.hasOwnProperty.call`, and the rationale is recorded in
  the wisdom entry. `bun run lint` is clean.
- **Shared-helper change handled across all callers.** Every `actAndAck` site
  awaits the new return; the two navigating reads were converted. No floating
  rejection.
- **Cleanup/isolation discipline intact.** `afterEach` resets its tracked names,
  takes presence from the server payload, awaits each delete's ack, and re-reads
  to prove the end state. No `.only`/`.skip`/`.todo`, no missing `await`.
- **`tests/e2e` is a reviewable path.** The guard's reviewable enumeration
  (`apps/, packages/, .github/workflows/, .agents/skills/, docs/`) omits
  `tests/`, but `docs/engineering-workflow.md`'s tier table puts tests in the
  Standard tier and the guard exempts only `.gitignore/.gitattributes/LICENSE/
  scratch`. Conservative reading: a `tests/`-only delta invalidates evidence,
  which is why this file set exists at the new SHA. (Follow-up: add `tests/` to
  the guard enumeration.)

Nits (non-blocking):
- `waitForRpc` is exported but unused externally; demoting it to module-private
  would make the `actAndAck`/`readRpc` contract the only public surface.
- The `dokan.vault.session` literal is duplicated from `vault-client.ts`
  (unavoidable inside `page.evaluate`, which cannot import the browser module).
- `readCustomers` + `CustomerListPayload` are duplicated across two specs; a
  shared helper would remove drift.

## Spec

Issue #129 acceptance remains met by the unchanged product code. Round 2 only
changes how the e2e reads the server list and acks writes.

| Requirement | Verdict |
|-------------|---------|
| Reject non-numeric phone text at the boundary | Met — store + router + form + picker unchanged; e2e reads the refusal back from the server. |
| Accept Arabic-Indic digits, normalise to `+213` canonical | Met — asserted from the raw payload, not the folded render. |
| Refuse in picker and edit forms with clear Arabic copy | Met — unchanged. |
| i18n copy, no display text from API | Met — unchanged. |
| Test-only round does not alter product behaviour | Met — diff touches `tests/e2e` and `.agents/wisdom` only. |

Spec instructions from the review-fix brief:

| Instruction | Verdict |
|-------------|---------|
| Read the acked body eagerly in the helper | Met — `rpc-helpers.ts:33-45`. |
| Remove the class, not the call site | Met — deferred read deleted; one shared seam. |
| Do not arm an ack around a navigation | Met — both `readCustomers` use navigate-then-`readRpc`. |
| Walk existing callers and report safe sites | Met — see test-audit caller table. |
| Prove real suite order + full e2e, isolated ports | Met — see gates below. |
| Regenerate evidence at the new SHA | Met — this file set at `0949177`. |
| Do not push | Met — three commits ahead of origin, unpushed. |

## Gates

```
bun run typecheck                          exit 0
bun run lint                               exit 0
bun run test                               exit 0 (977 web pass / 0 fail)
bun run test:e2e (isolated ports)          exit 0 (58 passed)
```

An earlier full run flaked only on `vault.spec.ts:196` under host contention;
that spec passed 3/3 in isolation and the rerun passed 58/58. No reviewable
product file changed in round 2.
