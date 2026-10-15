# The concurrent vault-run procedure is KDF-bound, not port-bound

**Date:** 2026-10-15 · **Ticket:** 206 · **Area:** tests/e2e/vault.spec.ts, docs/ci.md

Two concurrent `playwright test tests/e2e/vault.spec.ts` runs on disjoint shared
pairs (`DOKAN_PORT`/`DOKAN_WEB_PORT`) **and** disjoint vault pairs
(`DOKAN_VAULT_PORT`/`DOKAN_VAULT_WEB_PORT`) both failed, but at the *same late
test*, not at the gate:

- test 1 (passphrase reveal / gate) passed in both,
- test 2 (first run → recovery key) passed in both,
- test 3 (restart → recovery → reset passphrase) failed in both at
  `await expect(page.getByTestId("vault-settings-saved")).toBeVisible()`
  (Playwright's 5 s default).

The trace says why. `POST /api/vault/reset-passphrase` never completed
(`"time":-1`), while the earlier `unlock` took 3.2 s and `unlock-recovery` 2.1 s.
The vault KDF is pure-TS Argon2id at 32 MiB × 3 iterations
(`apps/api/src/lib/vault/crypto.ts`), i.e. CPU-bound. Two concurrent runs boot
the config's shared pair *and* the vault pair each, eight servers, and perform
two KDFs at once; on a 12-core host that was already running other lanes, the
post-KDF request exceeded 5 s.

## Always

**Prove vault port isolation by each run completing its own vault flow, not by
the gate.** Test 1 only checks the create-vault heading (`إنشاء الخزنة`) and
never creates a vault; `waitForOk` only checks that the status route answers. On
one fresh shared API both runs can pass test 1, so a green gate proves nothing.
A shared pair does fail eventually, but only once one run has initialized the
vault and the other then sees `فتح الخزنة`/login, so it is timing-dependent, not
a guarantee. What proves isolation is two runs on disjoint pairs that each pass
test 2 and test 3 on their own server, so that each run's own recovery key
unlocks its own restarted server. An explicit server ownership check would prove
it too. Only then does a later timeout at
`vault-recovery-key`/`vault-settings-saved` read as KDF contention; a timeout on
its own does not establish which it is. Attribute it before suspecting the
ports, and prove isolation before attributing it to CPU.

**Run the concurrent procedure on an otherwise-idle host**, and say which host
state it was run in. The brief for #206 forbids raising timeouts, which is
right: the 5 s post-KDF asserts are load-sensitive, and the honest fix is to
state the contention signature (docs/ci.md § Vault-port isolation) rather than a
test that races. Do not "fix" a red concurrent run by bumping `expect` timeouts.
