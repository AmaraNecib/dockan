# #206 — guard verification (head 502dfdd)

Branch `test-206-vault-port-coverage`. Review-fix round 1 (Greptile 4/5): the
`docs/ci.md` negative control overstated what it proves, and the same claim in
`.agents/wisdom/2026-10-15-vault-concurrent-runs-are-kdf-bound.md` repeated it.
Prose-only: no app, package, test, or config file changed.

Two commits on top of 7caa6b6:
- `7ad8219` — the correction itself;
- `502dfdd` — drops the two em dashes the correction added (mandatory `unslop`;
  the prior round removed them from new prose too). Claim unchanged.

Base: merge-base with `origin/develop` is still `3c3abcf`. `origin/develop` has
since advanced to `8a7a7fa`; this round did not rebase (brief: no
amend/rebase/force-push).

## What changed

`docs/ci.md` now calls the negative control timing-dependent and says plainly
that it does not prove isolation: test 1 never creates a vault, and `waitForOk`
only checks HTTP success, not server ownership, so two runs sharing one fresh
API can both pass the create-vault heading. It states what would prove isolation
(each run completing its own vault flow on disjoint pairs, or a server ownership
check) and only attributes a late timeout to KDF contention after that proof.
The wisdom note carries the same correction. The KDF-bound signature and the
"not automated" decision are untouched.

## Guard 1 — pre-commit (502dfdd)

| Check | Command | Exit | Log |
|---|---|---|---|
| Typecheck | `bun run typecheck` | 0 | `502dfdd-guard1-typecheck.log` |
| Lint | `bun run lint` | 0 | `502dfdd-guard1-lint.log` |
| Unit (turbo) | `bun run test` | 0 | `502dfdd-guard1-test.log` |
| Skills mirror | `bun scripts/sync-claude-skills.ts --check` | 0 | `502dfdd-guard1-skills-check.log` |

Unit: 986 pass / 0 fail (70 files, 157.8s). `skills:check` is not defined on this
branch; it exists only on `chore-workflow-docs-and-tanstack-skills`. I ran that
branch's `scripts/sync-claude-skills.ts --check` against this tree, which is the
same check: `29 skills in .claude/skills == .agents/skills`, exit 0.

## Guard 2 — pre-push (502dfdd)

Full Playwright on four isolated ports (sibling lane held 4629 while these ran):

```
DOKAN_PORT=4881 DOKAN_WEB_PORT=5881 \
DOKAN_VAULT_PORT=4882 DOKAN_VAULT_WEB_PORT=5882 \
bun run test:e2e
```

`69 passed (7.4m)`, exit 0. Log: `502dfdd-guard2-e2e-full.log`. Includes vault
3/3. No retries (`retries: 0`), no timeout changes. `.dokan-port` restored to
4317 after the run.

### Flake note

An earlier full run while writing this round (intermediate head 7ad8219, ports
4871/5871 + vault 4872/5872) failed 3 specs: two `page.pdf: Protocol error
(IO.read): Read failed` in `invoice-print-a4.spec.ts`, and a `vault.spec.ts`
`beforeAll` timeout waiting for `127.0.0.1:4872/api/vault/status`. Both are host
contention, not the change: the same specs passed 6/6 on an isolated rerun, then
the full suite passed 69/69 on 4876/5876 + vault 4877/5877, then again 69/69 at
the final head above. Logs for that history are not kept as current evidence;
the clean 502dfdd run is.

## Review

Prose-only, so no test-audit was regenerated: no test file changed since
7caa6b6, and the prior test-audit's conclusions stand. The delta review of this
edit is `502dfdd-code-review.md` (standards + spec axes).

## Not run / deferred

- No push, PR update, or merge (lane authority boundary).
- `origin/develop` advanced to `8a7a7fa`; rebasing is out of scope this round.
