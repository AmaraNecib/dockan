# Critic — api/client split (design debate, critic side)

Role: critic. Every claim below was checked against the tree at `b16dfbb`
(`apps/api/src/main.ts`, `apps/api/src/lib/vault/lock.ts`, `apps/api/src/db/encrypted-connection.ts`,
`apps/api/src/store/drizzle-store.ts`, `apps/api/src/lib/vault/http.ts`, `apps/api/src/config.ts`,
`apps/web/src/lib/rpc.ts`, `apps/web/src/lib/vault-client.ts`, `apps/desktop/src-tauri/src/desktop.rs`,
ADR-0012). Line references are to current `develop`.

Verdict first, then the five attacks in order.

## Verdict

The advocate's smallest correct path — a standalone API the web talks to over a URL it did not
invent from `window.location.origin` — is buildable and the substrate is genuinely there. What
the path cannot inherit is the *credential story and the durability story*, because both are
currently guaranteed by **same-machine physics**, and each one is pinned by an ADR that a remote
refuses to satisfy. The dangerous part is narrower than the expensive part: one machine's server
serving a folder shared over the network to another machine's server. That I would refuse
outright. Client-server on one machine, and one server with several UI clients, are merely
expensive and gated on TLS-plus-a-decision — not v1 work for the users this app actually has.

---

## 1. Single writer

**The advocate will say**: "the lock already handles everything — O_EXCL is atomic even on SMB,
the heartbeat covers foreign hosts, nothing changes for the writer." Half of that is true and it
is the dangerous half.

**What the lock actually guarantees, read from the code.** It bounds *processes that open the
same folder path on the same filesystem*. It has never bounded *clients*, and does not need to:
the API process is the only writer today, and the web/anything calls it over HTTP. A second UI
on the same server is visible to the lock as nothing at all. So for the plain "one server, many
clients" split, **the single-writer guarantee survives intact** — the advocate is right about
that case, and I will say so, because it is also the case where their other claims fail.

**Where the guarantee is actually earned — and what a network-shared folder does to each layer:**

1. **PID liveness is host-scoped and the "other host" branch is a clock guess.** `holderIsLive`
   (`lock.ts:163-176`): same host → the pid probe answers; different host → `heartbeatIsFresh`
   only. Two servers on two machines sharing `DOKAN_DATA_DIR` over SMB means the pid recorded in
   `vault.lock` is meaningless to the other side by construction, and "the holder is gone"
   reduces to *its 10-second heartbeat is older than 60 seconds on my clock*. A machine that
   sleeps, a stalled SMB connection, a clock skew — and the second server steals the folder while
   the first believes it holds it. The steal itself is careful (settle, rename, token compare),
   but the *decision to steal* is now a guess about a network peer, which is a strictly weaker
   position than the EPERM heartbeat the ADR already calls the "unknowable case".
2. **The ADR's own residual hole is the one that fires here.** ADR-0012 "Consequences": an
   in-flight write that passed `assertHeld()` before the theft can still land, so the new owner
   can briefly *believe in a version it does not hold on disk* (#280). The writeGuard is a local
   syscall away from perfect; over a network this race stops being microseconds and becomes a
   converged-in-practice window. #292 records that theft detection is lazy — the corrupted
   snapshot sits on disk until the next open refuses it. Locally, that window is rare enough to
   have been consciously deferred. Cross-host, it is the ordinary failure of a first server that
   died mid-write with a queue behind it.
3. **The refusal copy is not just unhelpful over a network, it instructs the wrong action.**
   `vaultLockRefusalPageHtml` names `{host}` and `{pid}` and the hint says "أغلق النسخة الأخرى".
   For two machines sharing a folder, the copy being shown may live on a machine nobody at the
   shop can touch. The spec-stale-vault-lock issue list (US-3, US-13: "name the other copy so I
   can tell which window to close") was written for windows on one desk.

**The divergent-view sequence the brief asked me to name.** Two UIs on one server *cannot* create
two writers, but they can create a worse UX failure that will get filed as "data loss":

1. Client A edits an item while its server is unreachable; it queues the edit (the advocated
   self-heal queue).
2. Client B, still connected, sold that item's remaining stock and the server persisted it.
3. A's server returns. A replays its queue blind. The edit overwrites-smashes on top of B's
   sale — not two writers, but *one writer serving two divergent views*, and the replayed call's
   ordering (batched stock movements, provisional return ledger) is no longer the order in which
   the user made them.

The queue is the failure, not the lock. A per-call retry bit with identity (the #115 lesson:
refusals must record the ask; "a second request while one is pending is the same request") does
not compose into "replay five minutes of UI from localStorage". Whether the writer is on a
different machine is irrelevant to this failure — it exists as soon as a UI keeps work offline at
all.

**Is the existing lock the right control?** For machines sharing one folder *over a filesystem*,
a file lock plus clocks is the wrong class of control; the right control is that only one server
process ever opens the folder, enforced by deployment, with a single identity token in the lock
file as the *audited tripwire* rather than the *gate*. For one server with remote UI clients, the
lock is untouched and sufficient. **Recommendation the parent should carry: keep the lock's
folder semantics exactly as they are, and make "the data folder is reachable over a network drive"
a boot-time refusal** (`DOKAN_DATA_DIR` on a UNC/synced path), because every layer above it was
built on one-host physics.

---

## 2. "The client heals when the server dies"

**The advocate will say**: "the client keeps its work, reconnects, submits, done — off-queue
first-class apps do this everywhere." The phrase hides three separable problems, and the second
is where the existing vault earns more than the advocate is crediting.

**(a) "Durable" means something specific here and it is stronger than typical.** I verified the
ack path rather than assuming. `drizzle-store.ts:794-801`: every committed unit runs
`conn.markDirty(); await persistOrFail();` **before** `runTransaction` resolves, so the RPC
response is only sent after the encrypted snapshot itself was sealed and renamed over
`dokan.db.enc` (writeGuard asked again before `persistedVersion` advances). Fail-stop: no
transaction is reported failed after commit. This is an unusually honest system: *every
acknowledged call was on disk before the ack*. So the truthful promise is "what the server told
you is durable". This is the vault working correctly and the advocate gets to keep it — but only
by keeping the server as the sole storage point.

**(b) What dies with the server is everything the client cannot verify.** The ambiguous call is
the honest enemy: a request whose response the client never received. The client cannot know
whether the unit committed. "Heals and completes" for that request means either:
- **Replay**: duplicates every path that lacks idempotency keys. The tree has exactly one such
  dedup identity, deliberately built (supplier adjustments, `data/adjustment-dedup-key-and-index.md`,
  plus the opening-balance lost-response retry in `opening-balance-resolver.ts:35`, which exists
  *because someone already knew* about lost responses). Sales, payments, invoices, stock
  movements have none, and money paths use `BEGIN IMMEDIATE` — a replayed sale double-counts
  stock and cash. A queue replayed blind prints money twice or holes stock.
- **Ask**: "sync state before replay" — but there is no client-side revision vector, no
  mutation log, nothing for the server to answer "have you seen version V?" with. The whole
  reconciliation protocol the phrase smuggles in does not exist anywhere in the tree.

**(c) Does a remote client widen the #280/#292 window?** No — and I will *correct the brief's
insinuation* to say so out loud, because a critique that exaggerates gets discounted wholesale.
The zombie-rename race is entirely local to the vault process and its lock file; UI clients never
touch the snapshot. A remote UI neither widens nor narrows it. #280 is *the server's* risk, and
the split changes it only if a second *server* gains access to the folder (attack 1). What a
remote client *does* widen is the **ambiguity window**: a LAN client against a local server has
same-machine latency and the shell's broker telling it the child died; a client over a phone
network can sit ambiguous for minutes, in that state queueing user actions it cannot admit are
ambiguous.

**What the client must honestly say.** A v1 client can promise exactly this:

- Reconnect detection auto-refusing the screen (this already exists — `App.tsx`'s
  VaultUnavailable with bounded retry, plus the t3-self-heal reclaim behavior on the server).
- Per-user-action retry, composed like the #115 bit: the action that was refused, remembered *as
  that action*, not as a tape of wire contents.
- On reconnect: fresh reads before writing; the UI reconciles against what the server persisted,
  then asks the user about the refused action.

What it **cannot** say: "your work while offline was saved once you're back on". The sentence to
put into the UI, translated for the owner's copy rules, is closer to: "While the server is
unreachable, changes can't be made. The app will reconnect by itself." — an honest refusal, not a
false recovery. Anything stronger requires a server-side outbox and idempotency keys or an
application-level reconciliation protocol, which is the *second* project hiding inside this one.

---

## 3. Remote means the vault is reachable

**The attacker on the same private network (Wi-Fi shop LAN, hotspot, café, tailnet):
verified inventory of what they get from an exposed API:**

1. **The unlock path over cleartext HTTP.** There is no TLS anywhere in the serve path; the
   server speaks plain HTTP (`serve(...)` in `main.ts`, no cert plumbing, none in deps). An on-path
   listener sees the passphrase, the session token, every sale. Worse: "brute-force the owner's
   passphrase" becomes *online cracking against the real gate*. The attempt throttle in the gate
   (lockedForMs) turns from a nuisance into an emergency lockout (denial) *and still does not
   stop an attacker from extracting the encrypted snapshot another way*: with KDF work per
   attempt bound to be the deliberate cost, an online attack is slow but is being attempted by
   someone physically near the register.
2. **Every credential route, and its refusal pages.** Caught something important the brief
   understates: *this was already fought and lost once.* `http.ts:92-100` +
   `isLoopbackRequest` (:102-119, FAIL-CLOSED with a comment recording the round-7 regression
   where the absent peer address was trusted instead) — credential routes are **loopback-only**,
   deliberately, for exactly this. The ADR-0012-style round-7 note in the code (`"the round-7
   guard trusted an absent address and let LAN clients send passphrases over cleartext HTTP"`)
   is a regression someone already shipped and patched; a remote design re-opens a hole someone
   already fell into.
3. **Broker mode exists specifically so the passphrase never touches the network.**
   `config.ts:53-59`: `DOKAN_VAULT_STDIN=1` makes HTTP credential routes refused *on principle*
   ("the passphrase can only arrive over stdin and never crosses the network stack"), and
   `desktop.rs:96-108` frames the shell→child protocol for it. A remote client **forces the
   credential onto the network by construction** — this is not a hardened edge the advocate
   extends; it is a guarantee the split *removes*. In broker mode an HTTP unlock is *refused*,
   so the remote client cannot even log in today.
4. **The one-time boot token stops being one-time-secret to the shell.** `desktop.rs:338` puts
   `#setup_token=` in the initial URL; `router.ts:410-413` gates firstTimeSetup on it "only the
   shell's own webview holds it". A remote web origin needs to *learn* that token by some new
   mechanism, which is a new credential-issuance design the tree does not have.
5. **Status codes, refusal pages, pids, paths.** Cross-origin per-op error text keyed at stable
   codes (fine), but the refusal page names `{host}` `{pid}` and the hint instructs actions; VAULT
   health endpoints answer state (`http.ts:391`, the /api/vault/* JSON shape, 503 with internal
   codes); the port record is shared on disk so a co-located client can learn topology the design
   intends to keep on `127.0.0.1`. None of this is remotely a shell-side secret *today* precisely
   because today nothing offloopback can ask.
6. **CSRF, re-opened.** Requiring `application/json` on pre-auth vault routes (`http.ts:86-90`)
   works because the server sends **no CORS headers at all**, so a visited page can do a
   no-cors text/plain POST and be refused. The web is same-origin through the vite proxy
   (`rpc.ts:12-13` — `window.location.origin`, deliberate). Allow a remote web origin and
   preflight starts being *expected*, so CORS headers appear, so the application/json CSRF-closer
   is no longer a sufficient defense and every route needs a re-derived model. This is a
   security regression nobody will notice in review, sitting inside a "just make the URL
   configurable" diff.

**Does Tailscale fix it?** Partially, and the advocate will overstate it. Tailscale does give
WireGuard encryption end-to-end between devices, which handles attack vector 1 (cleartext) and
keeps strangers out of the mesh. What it does **not** fix:
- A device lost or enrolled by a family member *on the tailnet* reaches the API with the network
  path fully open — no per-route auth exists beyond the single unlocked-owner session token and
  the loopback check that Tailscale renders moot (the client is no longer on loopback, so
  `isLoopbackRequest` fails everything: present behavior for remote clients is *the credential
  routes refuse* — the split cannot even log in without re-architecting that check).
- The tailnet's identity is not the shop's trust boundary; nothing in the current threat model
  says "devices enrolled in my tailnet may hold/shop-write my ledger".
- Tailscale is an install step a Dokan owner in Algeria with one laptop and a register cannot be
  assumed to run; it is the *advocate's* convenience answer, not the *user's* environment.

**Before exposure is even defensible — the gate list I would hold the parent to:**

1. The credential routes' loopback rule (`isLoopbackRequest` + requiresBroker) replaced by an
   explicit, tested, TLS-or-bust transport decision.
2. TLS or mTLS termination somewhere on the path. Loopback+local-only was the substitute for
  TLS; with it gone, the substitute cannot be "well, Tailscale encrypts, mostly".
3. The app/api session model deliberately re-derived for a network peer (token issuance,
   revocation, what survives the server process restarting — the token is in-memory on the
   manager, `manager.ts:391-402`, and rotation on credential change is already principled —
   mintSession sets `sessionGeneration += 1` — so a remote client needs re-unlock against a
   server restarted, which is fine but must be *designed and tested*, not discovered in field
   support).
4. A per-boot client provisioning story for the boot token.
5. A written threat-model decision from the owner (this is a decision-only-the-owner-can-make
   class of change, per the merge gate list — not a cheap diff).

---

## 4. The cost the advocate will understate

Enumerated against the tree, with where each one bites:

1. **rpc.ts's whole shape.** `url: () => new URL("/api/rpc", window.location.origin)` and
   `credentials: "include"` are both same-origin assumptions. The moment base URL is a setting,
   cookies become credentialed cross-site requests needing `SameSite=None; Secure` — which
   cannot work over plain HTTP on a LAN. The vault token is a header already (good), but an
   employee (legacy, non-packaged path) uses a cookie session — that path is broken by a remote
   client entirely.
2. **CORS, all of it.** The server sends no CORS headers, and that identity is *load-bearing*
   for the CSRF argument. Enabling a remote origin re-derives every route's origin posture.
3. **Version skew, currently impossible.** Packaged builds ship one binary where Tauri spawns
   one webview loading the API's own origin, `desktop.rs:256`; web+api cannot disagree today.
   Split clients on private networks typically get *no* coordinated upgrades, so a newer web
   against an older api is the *normal* state of a year of field installs. Nothing in the
   contract layer (`@dokan/contracts`) currently refuses a mismatched peer near the start of the
   conversation — needs an explicit protocol-version exchange, tests for it, and a refusal UI.
4. **Timeouts on a hostile network.** Localhost requests do not time out against a phone. A
   laptop-as-server and a tablet-as-client over Wi-Fi have 30-second stalls as *normal*, against
   money paths whose persistOrFail can genuinely take that long on a bad disk. Retries need
   request identities across the whole ORPC surface, not the two spots that have them now.
5. **Redaction for a remote surface.** Logs and refusal pages name pids/hosts/paths
   (`lock.ts:365-370`, `main.ts:604-608`, `port-record.ts` comments) — appropriate at localhost,
   all of it is topology disclosure over a network route. `locale-neutral.test.ts`'s
   discipline and the vault page's host sanitizing were built for the local page; a remote
   surface needs its own copy of "what must never leave the machine".
6. **Testing.** The e2e harness (`e2e/port-collisions-vault-spec.md` in wisdom, per-lane
   DOKAN_PORT/DOKAN_VAULT_PORT) boots API and web as co-located children and assumes `localhost`
   semantics. A remote pair is a *different topology*, needing: server process, client origin:
   port on a separately-bound address, cross-origin preflight, kill-server-mid-transaction
   fault injection, and cases the harness cannot produce today (network partitions, multiple
   client identities sharing one server session generation rotation). None of the existing e2e
   infra has a seam for "the other half is not me". This alone is days, not the afternoon the
   "it's already a separate process, just point the URL" pitch implies.
7. **The self-heal queue.** Section 2's (b) — a client-side durable queue with per-action
   identity, or the same energy spent teaching the owner it does not exist. Whichever way the
   parent goes on healing, this shows up as real designed work before the promise can appear in
   the UI.

---

## 5. The v1 line from the other side

Real users of this app today: one owner, one machine, occasionally a stuck install that took a
day of support to recover (#292's story). Nothing in the tree, the issues, or the wisdom suggests
anyone is blocked by "I need to be in the next room". The split is an *architecture appetite*,
and its two halves have very different risk profiles:

**Actively dangerous — I would refuse these outright:**

- **Two servers on one network-shared data folder.** Attack 1's whole case. The folder-sharing
  mode makes the lock the *only* barrier, with the ADR's residual write race and lazy theft
  detection as the ordinary path. No UI copy, no heartbeat tuning, and no pid probe rescue it.
- **The credential routes reachable as-is (no TLS, client not on loopback) because its
  convenience walks a hole someone already shipped and round-7 closed.** if the LAN opens, loop
  back the credential routes *first* or refuse.
- **A client-side replay queue for money-aligned operations.** Without server-side idempotency
  for the calls that move stock and cash, a queue that "completes the work" silently prints
  transactions. Refuse until the identity/reconciliation layer exists.

**Expensive but defensible in some form — the smallest safe increment looks like:**

1. **Multiple UI clients against ONE API on ONE machine, same host or LAN, served over HTTPS by
   one deliberate option, only after the credential routes' loopback gate has been re-derived.**
   This matches real usage (an assistant working another register, a phone in the shop), the web
   client needs only rpc.ts url + the credential posture, and every writer-scaling question
   stays moot — the API is still the single writer. It needs the CORS decision, a client
   provisioning story, and an explicit "the passphrase crosses the LAN/Tailscale now" threat-
   model decision the owner signs off on (a decision-only class of change). It does not need the
   off-queue healing promise, does not need server replication, and does not touch the lock.
2. **A separate machine running the server for the same server-side UX (shell dies, web stays).**
   This is genuinely useful today — the t3-self-heal story exists because a stuck shell
   leaves the owner stranded, and "the shell can die without the server dying" solves half of
   #292's class of shop-facing pain at a smaller design cost than any network change. That
   means making the vault gate willing to run HTTP credential routes on a non-loopback TLS
   transport, on the same wire rules as increment 1: the passphrase crosses the wired path
   deliberately, and every other discipline stays as strict as loopback made it.

Both are buildable at the seams the tree has (`config.ts` host/port, `lock.ts` unchanged,
`rpc.ts` URL, `main.ts` serve) because the hard single-writer and durability guarantees survive
the one-server case untouched. That is the strongest thing the tree supports: **multi-client,
not multi-server**. It should be the line drawn for v1 in place of the stronger split, and it
means the "I want two clients in different rooms" user story becomes reachable *without* the
opposite half of the split (server replication, folder sharing, sync/reconciliation) ever shipping.

**The parent's likely wrong turns, flagged explicitly in case the advocate's summary was the
round-about way to say them:**

- "The API is already standalone so this is small": verification says the crates are
  standalone, but every floor whose independence matters (credentials, TLS, CORS, client
  provisioning, contract version, testing topology, healing semantics) culminates in the
  network hop and none is free. The substrate is a lean promise only until "separate machine"
  enters the sentence; after that it is a different project.
- "The lock handles it (cross-host heartbeat exists)": the code says the opposite thing when the
  folder is shared — the ADR's own residuals run the show.
- "Self-heal just queues writes": the store is not designed for retries without identities, and
  the honest answer is a designed refuse-and-reconcile protocol or a deliberate non-promise.
- "Tailscale covers the transport": it covers one of six vectors and is an environment nobody
  in the user's reach has agreed to.

**Where my own reasoning is uncertain:**

- `isLoopbackRequest` FAIL-CLOSED ties credentials to observed peer address — I asserted remote
  clients cannot log in today; if `requiresLoopback` only guards the *pre-boot* routes and
  post-unlock ones behave differently than the comment implies, the split's unlock story has a
  present-day pathway I weighed as unavailable. The change is small either way; the ordering of
  increment 1 vs 2 shifts slightly, the scale of change does not.
- Window of `isLoopbackRequest`'s FAIL-CLOSED in tests with explicit env looked designed and
  honest, but I did not trace every route in the overlay (`overlay.ts`) — there may be routes
  that accept a non-loopback peer without checking, which would soften my strong statement
  slightly and would change "what must exist before exposure is defensible" into "what must
  exist *first*".
- I have not measured whether contract version-skew actually breaks gracefully today instead of
  loudly; "needs an explicit handshake" is my design call from the absence of one, not a
  verified failure mode with a test id in the tree.
- The exact reply semantics of `runSerialized`'s queue under *network* (as opposed to local
  process) interruption — whether an interrupted unit cleanly commits in the client-invisible
  case — is inferred from the code's insistence that only fail-stop happens post-commit, but a
  remote crash between COMMIT and `persistOrFail` returning is a window whose behavior I have
  reasoned about but not verified with a test id found in the tree.
