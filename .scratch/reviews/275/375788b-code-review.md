# #275 — code-review lens, round 2, head `375788b`

Separate sub-agent on `zen-proxy/glm-5.3-flash-free` (not the author's model). Read-only, no edits.
Verified itself: lint clean, `tsc --noEmit` clean, 72 unit tests in the four touched files pass,
`lock.integration.test.ts` passed 4 of 5 local runs — the one failure is F2.

Scores as returned: **Spec 9/10, Standards 8/10.**

## Spec compliance

| # | Criterion | Verdict |
|---|---|---|
| 1 | Dead pid reclaimed whichever way the probe reports it | Met |
| 2 | Inconclusive probe with a fresh heartbeat refused | Met — the unknown case is decided only by `heartbeatIsFresh` |
| 3 | Alive answer refused however old the heartbeat | Met |
| 4 | One shared liveness helper for lock and port record | Met — `pid-liveness.test.ts` source-scans both sites for reaching around it |
| 5 | Probe injectable through lock options | Met — `VaultLockOptions.probePid` (`lock.ts:85`) |
| 6 | Loser writes nothing further, refuses instead of exiting | **Partly met — see F1** |
| 7 | No second listener, owner's port record untouched | Met — `onLost` only swaps `activeHandler`; integration test asserts the port file is unchanged and `/health` answers 503 on it |
| 8 | Log names holder on every reclaim and loss | Met |
| 9 | The six named tests exist | Met |
| 10 | Lock record shape, name and location unchanged | Met — asserted byte-exactly |

No dead code, no duplication (`errnoCode` consolidation is single-sourced), no misleading names.

## F1 — the broker's post-bootstrap tail writes into a lost folder (major)

`bootstrapVault` early-returns on `lockLost` (`main.ts:304`), but in broker mode the caller then runs
`vault.finishSetupBootstrap()`, `vault.commitSetup()` — which writes the header at `manager.ts:322` —
and, on the plain-unlock path, the `cleanupLegacyPlaintext` tail that unlinks files
(`main.ts:487-491, 543`; `manager.ts:322, 513`).

So after the lock is lost, writes still reach a folder another copy owns. That is exactly what
ADR-0012 forbids, and it happens outside the `writeGuard` — which is why criterion 6 is only partly
met.

This is wider than the debate lens's finding A. A said the `reset` and `unlock` branches are ungated;
F1 says even the *normal* bootstrap tail runs unchanged. Fix the tail, not just the two branches.

Shape: make `bootstrapVault` refuse (or have the broker check the module-level `lockLost`) before
`commitSetup` and `cleanupLegacyPlaintext`, and answer a typed refusal over the pipe rather than
`process.exit(1)`, so the shell keeps a broker to talk to.

**Constraint from the parent:** reuse the existing `VAULT_LOCKED_BY_OTHER_INSTANCE` code over the
pipe. Do **not** add a new `VaultErrorCode` to `@dokan/contracts` — that package is a separate,
owner-level decision and this change set should not reach into it. If the shell later needs a
distinct branch, that is a follow-up with its own issue.

## F2 — the new integration test is flaky on Windows (major)

`lock.integration.test.ts:203-215`, "a running instance that loses the folder refuses on its own
port": failed 1 of 5 local runs with `ConnectionRefused` from the `fetch` at line 208. That loop has
no `try/catch`, unlike `waitForHealth` at `:51-60`, so a transient refusal fails the test instead of
being retried. Whether the sidecar actually exited is unknowable because the child's stderr is never
captured.

Fix: wrap the fetch in try/catch, and record the child's stderr into the timeout error message so the
next failure names which exit path fired.

Re-run `lock.integration.test.ts` five times in a row before reporting. A test that fails 1 in 5 is a
defect in this change set, not a pre-existing condition.

## F3-F6 — comment and ADR accuracy (minor)

- **F3** `lock.ts:36-38`: "the `onLost` callback fires so the caller can exit rather than run without
  exclusivity" describes pre-ADR behaviour. The caller now refuses instead of exiting. Say "so the
  caller can stop writing and refuse".
- **F4** `main.ts:363`: "same fields the HTTP status route serves" is no longer true — the broker
  payload now carries `lockLost`, which `http.ts:172-190` does not serve and never will, because the
  refusal app owns that route after a loss. Say "the same fields the HTTP status route serves, plus
  `lockLost`".
- **F5** ADR-0012 (Consequences) claims the guard runs "before each attempt and again before
  `persistedVersion` advances". The second half holds only for the async write
  (`encrypted-connection.ts:229`); `checkpoint()` checks once before its sync write. A synchronous
  write cannot be interleaved in-process, so no behaviour change is needed: either add the one
  post-`writeFileAtomicSync` guard line for symmetry, or scope the ADR sentence to the async path.
- **F6** unresolvable citations: `lock.ts:233, 383-386`, five sites in `main.ts`, `lock.test.ts`,
  `port-record.test.ts` cite "critic C2", "code-review S3/S4", "test-audit F1/F2" — none of which
  exist on develop, so a maintainer cannot resolve them. The technical reason is already present in
  every comment. Drop the artifact tag, or name the round in prose the way the ADR's narrative
  already does ("round-5 finding"). Do not add an ADR section listing review artifacts.

## Comment accuracy checked and passing

Everything else that cites ADR-0012, EPERM-on-Windows, or a round checks out against the code it
sits above: the projection prose in `lock.ts:27-31`, the `holderIsLive` doccomment, the `assertHeld`
doccomment, and the write-guard rationale — including the settle-window re-check that the earlier
round's critic note claimed for ADR-0012.

## Maintainer notes, no change requested

- `assertHeld()` is a synchronous lock-file read plus `JSON.parse` on every snapshot write, ~1 ms per
  write. Required for correctness; worth one sentence in the ADR Consequences so the next person
  chasing write latency knows it is there.
- `pid-liveness.ts` changes `port-record.ts` behaviour: previously any thrown errno other than `EPERM`
  read as dead, so `EACCES` or another error let a survivor take over; now unknown stays alive. Safer
  and ADR-aligned; the transition is commented at the re-export (`port-record.ts:126-127`).
- `brokerStatusPayload` reports `state` still `"unlocked"` after a loss while `unlocked: false`. The
  shell distinguishes via `lockLost` (pinned in `broker.test.ts`), but any new consumer reading only
  `state` gets surprised. One line in the broker doccomment.
