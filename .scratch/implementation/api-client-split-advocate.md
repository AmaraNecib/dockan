# Advocate: the API/client split, ranked by what it actually costs

Design-debate position for the "serve a client on another machine, and survive the server dying"
question. Every claim below was read out of this tree at `b16dfbb`, not designed from memory.
Where I am guessing I say so in §6.

Short version: **the same-machine split already exists, the remote split is blocked on one
security decision (can a remote client unlock, and over what?), and "the client finishes the work
offline" is not achievable without a weeks-long outbox that I would refuse for v1.** The cheapest
real v1 is a headless serve mode plus the already-specced self-heal ticket (#t3), not a client
rewrite.

---

## 0. What the tree already gives us

This is not greenfield. Five things exist and only need to be pointed at each other:

1. **The API is already a standalone HTTP server.** `apps/api/src/main.ts:645` `startServer()`
   binds `config.host` on an explicit or probed port and publishes `.dokan-port` +
   `.dokan-port.registry` under a directory lock (`lib/port-record.ts`).
2. **The API already serves the whole web UI.** `lib/overlay.ts` `serveStatic({root: webDataDir})`
   plus an SPA fallback whenever `DOKAN_WEB_DIST` is set. The built bundle uses relative asset
   paths (no vite `base` override), so it loads from the API origin unchanged.
3. **The web is already an HTTP client using relative URLs.** `apps/web/src/lib/rpc.ts:15` builds
   `/api/rpc` from `window.location.origin`; `lib/vault-client.ts` fetches `/api/vault/...`
   relatively. If the page comes from the API origin, remote access is **same-origin**: no base
   URL, no CORS, cookies keep working. This is the single biggest thing already in place.
4. **Binding to a specific non-loopback address is supported today.** `config.ts`
   `isWildcardBindHost()` only demands the second `DOKAN_HOST_INTERFACE` opt-in for `0.0.0.0`/`::`.
   A Tailscale address (`100.x.y.z`) or a LAN IP is not a wildcard, so `DOKAN_HOST=100.64.0.5`
   works with no code change.
5. **The desktop client already heals a dead server process.** `apps/desktop/src-tauri/src/desktop.rs`
   `broker_exchange` (line 436) respawns and re-verifies the sidecar (`needs_respawn`, line 443)
   whenever a status/unlock IPC finds it gone. That is a real "client heals its server" for the
   desktop, pre-unlock gate, and it is done.

The same-machine split is therefore **already real twice over**: dev/e2e runs vite on 5173 proxying
`/api` to the API on 4317 (`apps/web/vite.config.ts`), and the packaged app has the API serve the
UI same-origin. "Client on the same machine" needs a runbook, not code.

---

## 1. The minimum delta, ranked by cost

| # | Step | Cost | Touches | What it buys |
|---|---|---|---|---|
| A | Headless serve runbook | **~0.5 day, 0 code** | a docs page | API on a second machine/LAN/tailnet serves the UI; remote browser is same-origin |
| B | `DOKAN_PUBLIC_ORIGIN` | **1–2 h** | `config.ts`, `auth/auth.ts:28`, `auth.test.ts` | correct auth base URL when the public origin ≠ bind host |
| C | Audit the reconnect screen | **0.5–1 day, mostly tests** | `App.tsx`, `vault-gate.tsx` | client retries/refetches instead of a dead end when the server comes back |
| D | Self-heal ticket (#t3) | **2–4 days** | `main.ts` refusal path, `lib/vault/lock.ts`, web tests | a refused second launch takes the folder the moment the holder releases |
| E | Remote unlock decision | **3–5 days** minimum | `lib/vault/http.ts`, new route + tests + copy | a remote browser can actually get in |
| F | TLS without Tailscale | **3–5 days** | server bootstrap, webview cert trust, loopback guard | cleartext LAN deployments stop leaking the passphrase |
| G | Client-side outbox | **3–6 weeks**, refuse | new client store + idempotency across the contract | "finish the work offline" — see §2 |

**A is the answer to "another machine".** Run `bun apps/api/src/main.ts` (or the compiled
`dist/dokan-api`) with:

```
DOKAN_WEB_DIST=<repo>/apps/web/dist
DOKAN_DATA_DIR=<data dir>          DOKAN_PORT_ROOT=<data dir>/run
DOKAN_HOST=100.64.0.5              # the Tailscale address, or a LAN IP
DOKAN_PORT=4317
```

and point a browser at `http://100.64.0.5:4317/`. The vault is encrypted and the snapshot never
leaves the host; the browser only sees JSON. **No code.** (Half a day is writing the runbook and
proving it on a second box, not writing a feature.)

**B is not optional once A is used with `0.0.0.0`.** `createAuth` hardcodes
`baseURL: http://${config.host}:${config.port}` (`auth/auth.ts:28`). With a wildcard host that is
`http://0.0.0.0:4317` — not an origin any client uses. Add a `publicOrigin` config field
(default `http://${probeHostFor(host)}:${port}`) and feed it to `baseURL`. Small, but it is the
one line that makes a non-loopback bind semantically correct rather than merely reachable.

**C** is an audit, not a build: `VaultUnavailable` + retry already exist (`App.tsx:62`), TanStack
Query retries by default, and the refusal code already has translated copy. What is missing is a
regression test that a browser whose server was killed and restarted lands back in the app
(username/passphrase) instead of a stale error.

---

## 2. What "the client heals when the server dies" can honestly mean

**The hard constraint: the master key is memory-only.** `VaultManager.unlocked` is
`masterKey !== undefined` (`lib/vault/manager.ts:405`). Nothing writes it to disk, by design
(ADR-0008: a portable install's trust boundary is the USB stick; a machine-bound secret cannot
exist). So when the server process dies:

- the encrypted snapshot on disk is intact, the lock is released by the exit hook, and
- a restarted server is **locked** until a human re-enters the passphrase or a recovery key.

No client-side feature changes that. Any "heal" that claims to resume committed work without a
re-unlock is really a request to persist key material, which I refuse (§5).

Split what a client may do while the server is gone from what it must never do:

| While the server is gone — allowed | Never — regardless of the feature request |
|---|---|
| Keep the last-rendered TanStack Query cache on screen, read-only | Open, parse or rewrite `dokan.db.enc` (`EncryptedConnection`, `writeGuard`) |
| Retry the status/RPC calls; refetch on reconnect | Write the DB or the snapshot from the client |
| Show "locked / reconnect", not the legacy login (`App.tsx:42–56`) | Run a second writer while a holder exists (ADR-0012 `assertHeld`, `connectionToCloseAtShutdown`) |
| A Tauri shell respawning a dead sidecar and re-verifying it (`desktop.rs:443`) | Extend a session past a lock loss or past process death |
| Payload-free polling of `/health` to detect the server's return | Assume a request that failed was not committed |

That last row is the one worth writing down for whoever touches the client: the API is **fail-stop**
on a snapshot write (`main.ts` `bootstrapVault` `onFatalError`, `SNAPSHOT_PERSIST_FAILED`), so any
business answer the client *received* was committed first, and any retry of a request that failed
with a connection loss may duplicate a sale or a payment. "Retry" is safe for reads; for the money
mutations it is only safe where an idempotency key exists (supplier adjustments have one; sales and
payments do not, in general).

**"The client completes the work offline": achievable in principle, not in v1, and I would say no.**
It means an outbox of intents persisted client-side in encrypted form, replayed on reconnect, with
an idempotency key on every mutation and server-side dedup, plus conflict rules for stock and money
when two clients replay against one vault. That is the multi-writer problem rebuilt on the client
side, it re-opens the at-rest-encryption problem in the browser (where you have no Argon2id and no
safe key storage), and it costs weeks of correctness work on the money path. The honest v1 position:
a client never loses work the server already committed, and it queues nothing.

---

## 3. The remote case's real cost

Today the API trusts **localhost plus a boot token**. Concretely:

- **Authorization:** the better-auth session cookie (`credentials: "include"`) for the owner
  account, plus `x-vault-session` for the unlocked-owner RPC principal
  (`rpc/router.ts:340` `deps.vault.sessionMatches(...)`). Both are bearer credentials with no
  device binding.
- **Credential routes are loopback-only:** `lib/vault/http.ts:101` `requiresLoopback` refuses
  `setup`, `unlock`, `unlock-recovery`, `reset-passphrase`, `change-passphrase`, `logout` and
  `recovery-keys` from any peer that is not `127.0.0.1`/`::1`, and `isLoopbackRequest` fails
  closed when the peer is unobservable.
- **`DOKAN_BOOT_TOKEN` is not an authorization token.** It answers `/health-token` and gates
  first-run `setup` in packaged builds (`vault/http.ts:165` `setupTokenOk`). Once the vault is
  configured it buys nothing, and it grants no data access by itself.
- **The web treats "no session token" as locked even when the server is unlocked**
  (`App.tsx:42–43`). So a remote browser reaching an unlocked API can read `/api/vault/status`
  and then is stuck at the gate, and the gate's unlock POST is refused with
  `VAULT_LOOPBACK_REQUIRED` (`http.ts:147`).

What must exist before a remote client is allowed in:

1. **A public origin.** Step B above. Without it, auth's `baseURL` is wrong on any non-loopback bind.
2. **Transport.** Tailscale already gives WireGuard encryption in transit, so plain HTTP over the
   tailnet is not cleartext on the wire. On a bare LAN it is, and the passphrase, the session
   cookie, and the vault session header are all in the clear. Either use Tailscale and say so, or
   build TLS — and TLS is not a one-liner here: the Tauri webview must trust the cert, and a
   terminating proxy in front of the API breaks `isLoopbackRequest` (it fails closed on an
   unobserved or forwarded peer), so the guard would need a deliberate forwarded-header rule.
3. **Authorization, not just transport.** Tailscale authenticates *devices and the transport*; the
   app never reads a Tailscale identity header, and nothing binds a session to a device. On a
   tailnet, "reachable + holds a session" is the whole authorization, so any device in the ACL with
   a session is the owner. Missing: an app-level decision on whether to consume
   `Tailscale-User-Login` (only present behind `tailscale serve`, which is another hop to deploy),
   an ACL policy, and per-device/per-session binding.
4. **A decision on remote unlock.** Either remote clients never unlock and must be *issued* access
   by the local owner (a pairing code: new route, throttle, copy, tests — the 3–5 day item E), or
   the loopback guard on `/api/vault/unlock|setup|unlock-recovery|reset-passphrase` is relaxed
   behind transport + auth. I would not relax it in v1: the passphrase derives the master key, so a
   captured passphrase unlocks the copyable snapshot on any machine. Sending it over the wire turns
   every TLS terminator, every tailnet peer, and the client box into a vault-key holder.

**What a stolen token buys an attacker with the vault files on that host.** The vault session token
(or the owner cookie carrying the same principal) is full owner RPC at the moment the vault is
unlocked: read every record, create invoices/payments/adjustments, run `createBackup`, **add a
recovery key**, and change the passphrase — i.e. mint durable credentials that outlive the token.
It does **not** decrypt `dokan.db.enc` by itself: no key material is in the token, and the master
key is never serialized. But the host holds the encrypted snapshot and the recovery-key wraps, so
RPC access is one `addRecoveryKey` call from permanent compromise. A stolen boot token alone buys
almost nothing on a configured vault (first-run already happened) — it must not be treated as the
remote authorization story.

---

## 4. Single-instance handoff: a second launch joining instead of refusing

**What happens today.** A second launch on the same folder fails `acquireVaultLock`
(`main.ts:67`), catches `VaultAlreadyLockedError` (`main.ts:81`) and calls `serveLockRefusal`
(`main.ts:889`): it serves the Arabic refusal page plus `/health-token` so the shell's identity
probe still passes, answers `/api/vault/status` with `503 VAULT_LOCKED_BY_OTHER_INSTANCE`, never
publishes the port record, and never returns. The liveness fix (#275) landed. The self-heal retry
(`.scratch/issues/t3-self-heal.md`) has **not** landed: the refused instance never tries the folder
again.

**Joining is a different design from self-heal, and it is not a day's work.** The costs, in order:

1. **The boot handshake is the wall.** The desktop shell's whole identity proof is the per-launch
   `DOKAN_BOOT_TOKEN` echo plus the child's pid-keyed registry entry
   (`desktop.rs:705` `wait_for_verified_health`). A joining shell has no token for a child another
   shell spawned; the token lives only in the running shell's process. Joining needs a new
   machine-local handshake (an owner-ACL'd token file, or a named pipe) — design plus a security
   review, not a patch. Dropping the check instead re-opens the exact TOCTOU/hijack hole PR #51
   finding 1 closed.
2. **The session model is the second wall.** The vault session is in-memory and per-unlock
   (`manager.mintSession` overwrites `sessionToken`, so a second unlock revokes the first), the RPC
   principal is that token, and the web shows the gate when it lacks one (`App.tsx:42`). In broker
   mode the HTTP unlock routes are refused outright (`requiresBroker`, `http.ts:133/146`), and the
   Tauri broker refuses a second unlock ("the vault is already unlocked"). So a second window on the
   same running API cannot get a session without a token-handoff feature.
3. **Lifecycle.** The shell owns and kills its child (`install_sidecar`, `kill_sidecar`); a joining
   shell must not kill an API it did not spawn, and every shutdown path assumes ownership.
4. **The port record is mostly fine.** The canonical `.dokan-port` already points at the live
   holder and a joiner publishes nothing new; the registry and the vite proxy already resolve
   "newest live survivor" (`recomputeCanonical`). The record is not the problem — the handshake and
   the session are.
5. **The refusal path when the holder is alive but not serving.** With the pid alive and the
   heartbeat fresh, no reclaim can fire (ADR-0012 clause two). A client pointed at that port gets a
   dead listener, and the only honest screen is the refusal naming the holder. If a join feature
   replaces the refusal, that screen disappears and the client is back to "server unreachable" —
   the wrong diagnosis #283's copy exists to prevent. So the refusal must survive any join design
   as the fallback when the join handshake fails.

**Estimate.** A real join: **1–2 weeks** (handshake + session handoff + lifecycle + tests + security
review). The already-specced self-heal (`t3`): **2–4 days**, and it delivers what an owner actually
wants — "I don't have to quit and reopen the app". Ship t3; defer join.

---

## 5. The v1 line

**Ship**

1. **Headless/remote serve mode (A + B).** Config + runbook + a correct `publicOrigin`. Client =
   any browser on the same machine, the LAN, or the tailnet. 0.5–1 day.
2. **Self-heal (D, the existing #t3).** The refused launch retries and takes the folder on release.
   2–4 days. This is the achievable "client heals when the server dies" for one machine, and it is
   already specified and reviewed.
3. **Reconnect audit (C).** Prove the client comes back cleanly when the server returns. 0.5–1 day.

**Defer, with the reason written down**

- **Remote unlock (E).** 3–5 days for a pairing-code design that keeps the passphrase on the host.
  Deferred because it is a security-model change and needs the owner's decision on who may hold a
  session, not because it is technically hard.
- **TLS for a bare LAN (F).** 3–5 days and it drags in webview cert trust and the loopback guard's
  forwarded-peer rule. Deferred: for v1, "remote" means Tailscale, and a bare-LAN deploy stays
  loopback-bound until F is done.
- **Join/handoff (§4).** 1–2 weeks and a boot-handshake rework for a case most shops do not have.
  Deferred in favour of t3.
- **Explicitly leaving `DOKAN_HOST` wildcard requires `DOKAN_HOST_INTERFACE`** is correct and stays
  a guard, not a gap.

**Refuse outright**

- **Persisting the master key** (OS keychain, a wrapped file, anything) so a restarted server heals
  without the passphrase. It breaks ADR-0008's portable trust boundary and turns any host compromise
  into permanent vault compromise. The re-unlock is the feature.
- **Any second writer** on one snapshot, from a client or a second server. `vault.lock` and
  `assertHeld` exist precisely because two in-memory images last-writer-win the snapshot.
- **A client that opens `dokan.db.enc`.** Same reason as the second writer.
- **Treating `DOKAN_BOOT_TOKEN` as remote authorization.** It is a same-machine identity probe, and
  using it as an access token would be a security regression dressed as a feature.

---

## 6. Where I am guessing

- **better-auth's exact failure with `baseURL = http://0.0.0.0:4317`.** I verified the hardcoded
  value (`auth/auth.ts:28`); I did not run a non-loopback bind. My read: origin/cookie behaviour is
  at least semantically wrong, possibly outright broken. Step B is cheap either way.
- **`tailscale serve` identity headers.** I did not evaluate whether to consume
  `Tailscale-User-Login`; that is a decision for the remote-unlock design, not measured here.
- **The t3 2–4 day estimate** is my read of `.scratch/issues/t3-self-heal.md`, not measured.
- **The pairing-code sketch (E)** is a direction, not costed to the hour.
- **No client-side TLS story was prototyped.** The webview cert-trust cost in F is an estimate.

## 7. What I would tell the owner in one line

Point `DOKAN_HOST` at the Tailscale address, run the existing API with `DOKAN_WEB_DIST`, and open
the API's origin from the other machine — that is your split today. The one thing still missing is
**who is allowed to unlock remotely**, and that is a decision, not a backlog item; until it is made,
keep the unlock on the host machine and ship t3 so a dead server costs a retry instead of a
reinstall.
