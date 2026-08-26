# Issue #52 — Auth hardening trio (design)

Tier: **High-assurance** (auth/security). Base SHA: `706a498` (origin/develop,
merge-base of chore/52-auth-hardening).

Three independent, cheap hardenings from the credential-model debate. The
per-customer baked build secret stays as-is.

## 1. Constant-time build-secret comparison

**Seam:** `apps/api/src/auth/admin.ts` — `input.secret !== config.buildSecret`.

**Change:** new pure helper `constantTimeEqual(a: string, b: string): boolean`
in `apps/api/src/lib/constant-time.ts`, backed by
`crypto.timingSafeEqual` with an explicit length guard (the primitive throws on
length mismatch). `resetAdminPassword` uses it for the secret check.

Known and accepted: the early length return still leaks secret *length*; the
secret is a long random per-customer value, so this leaks nothing useful.
Full-constant behavior would require hashing both sides first — noted in code.

**Tests (`constant-time.test.ts`):**
- wrong-length inputs → false (and no throw)
- same-length mismatch → false
- equal → true

## 2. Attempt lockout on authResetPassword

**Seam:** `apps/api/src/rpc/router.ts` `authResetPassword` handler.

**Threat model:** loopback / shared laptop. The reset RPC is unauthenticated by
design; today wrong-secret guesses are unlimited. Phone-keyed limiting is
defeated by phone rotation (phone is attacker-supplied input), so the limiter
is **global to the process** — correct scope for a single-admin app where the
only unauthenticated identity surface is this one endpoint.

**No DoS foot-guns:** bounded by construction — never locks forever:
- after `5` wrong-secret failures within a 5-minute window → `30s` lockout;
- once the lockout passes, attempts are allowed again and the counter starts fresh;
- failures older than the window stop counting (scattered mistypes during
  provisioning never accumulate into a lockout);
- a successful reset clears all state.

New module `apps/api/src/lib/reset-throttle.ts`: `createResetThrottle(options)`
with injectable clock (`now`) and tunables (`maxFailures`, `lockoutMs`,
`windowMs`) for deterministic tests. API: `check()` → `{ allowed, retryAfterMs }`,
`recordFailure()`, `recordSuccess()`.

Router wiring: check before calling `resetAdminPassword`; blocked →
`ORPCError("TOO_MANY_REQUESTS", { message: "RESET_LOCKED" })` (429, valid oRPC
code); only `WRONG_BUILD_SECRET` counts as a failure (invalid phone /
unconfigured secret are operator errors, not guesses); success clears.

The throttle instance is created inside `createRpcRouter`; tests may inject one
via optional `RpcDeps.resetThrottle`.

**i18n:** add `RESET_LOCKED` key in `apps/web/src/lib/i18n.ts` (shared i18n
addition allowed by the issue).

**Tests:**
- unit (`reset-throttle.test.ts`): consecutive failures reach lockout; clear
  status carries retryAfterMs; success-after-wait works once injected clock
  passes the lockout; success resets counters; window decay prevents lockout
  from scattered failures; failure after expiry re-locks.
- rpc wiring (in `router.test.ts`, dedicated app + injected throttle): 4 wrong
  attempts still map to FORBIDDEN/WRONG_BUILD_SECRET; 5th locks even a CORRECT
  secret behind RESET_LOCKED; advancing the fake clock lets the real reset
  succeed.

## 3. Refuse wildcard DOKAN_HOST without explicit opt-in

**Seam:** `apps/api/src/config.ts` `createAppConfig`.

**Change:** wildcard bind hosts (`0.0.0.0`, `::`, `::0`, `0:0:0:0:0:0:0:0` —
same set `probeHostFor` already maps) are rejected at boot unless the env also
sets `DOKAN_HOST_INTERFACE` to the exact same value. Loopback default and plain
LAN hosts (e.g. `192.168.1.5`) stay accepted. Failure throws a loud Error that
names both env vars.

Single source of truth: export `isWildcardBindHost(host)` from
`port-record.ts`; `probeHostFor` reuses it.

**Tests (`config.test.ts`):** default loopback; LAN host accepted; wildcard
without opt-in throws; wildcard with matching opt-in accepted (host kept,
probeHost loopback); non-matching opt-in value throws.

## Risks

- Throttle is per-process (in-memory): restart resets it. Accepted — DB-backed
  state adds persistence of attack data for little gain against a local
  attacker who can already delete the DB file.
- Global limiter can be triggered by anyone with HTTP access to the port; on
  the shared-laptop threat model that actor already has the port, and the
  lockout is bounded at 30s.
- Config throw changes boot behavior for operators who previously bound
  wildcard silently — intentional (fail loudly), documented error message.

## Out of scope

- invoice/payments/reports seams (#11), store money procs, router.tsx beyond
  the single i18n key, any push/PR (parent lane owns those).
