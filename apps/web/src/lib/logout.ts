import { clearVaultSessionToken, revokeVaultSession, vaultRouteAbsent } from "./vault-client";
import { markSignedOut } from "./auth-refusal";
import { brokerAvailable, brokerCommands, invokeBrokerVoid } from "./vault-broker";

/** What a sign-out call resolves to; better-auth returns a data envelope. */
export type SignOutResult = { data: unknown } | null | undefined;

/**
 * What the revoke established about the server's copy of the credential.
 *
 * - `revoked` — the server confirmed it dropped the session.
 * - `absent` — there is no vault credential for a reload to walk back in with:
 *   this build mounts no vault route at all. The local clear WAS the whole
 *   credential. NOTE the narrowness: absence is not "the revoke said there was
 *   nothing to revoke" (see `revokeOutcome`).
 * - `unconfirmed` — a vault may still accept a live cookie. Only this one means
 *   the reload would walk back into the app.
 */
type RevokeOutcome = "revoked" | "absent" | "unconfirmed";

async function revokeOutcome(): Promise<RevokeOutcome> {
  try {
    await revokeVaultSession();
    return "revoked";
  } catch (error) {
    // An absent session is not a failed revoke. Reading "not success" as
    // "unconfirmed" was the round-4 defect: the legacy build has no logout
    // route at all, so a sign-out the server never even saw held the page and
    // left the app mounted on a session that was already gone.
    if (!(error instanceof Error)) return "unconfirmed";
    // ABSENCE IS ASKED OF THE BUILD, NEVER READ OFF THIS CALL (round-6 finding
    // 2). `VAULT_NOT_UNLOCKED` used to count as "nothing to revoke" here, and it
    // is not that: the API answers it for an OLD token as readily as for no
    // session at all. Another window rotating the token is exactly how logout
    // comes to carry the old cookie — and reading that 401 as absence skipped
    // `markSignedOut()` and RELOADED, which put the replacement cookie into the
    // shared jar and landed the page back in the app. So the revoke hop's own
    // code decides nothing; whether a vault cookie can walk back in is the
    // status route's answer, and it is the same read the gate makes on boot.
    return (await vaultRouteAbsent()) ? "absent" : "unconfirmed";
  }
}

/**
 * Logout for both credential worlds. Better Auth signs the session out, and in
 * vault mode the owner access rides one live token: the browser path carries it
 * in an `HttpOnly` cookie that survives the reload, the broker path in this
 * page's storage (#319). Leaving either behind means landing straight back in
 * the app without a passphrase on a shared computer.
 *
 * So the RELOAD is not tied to "the call succeeded": it is tied to "no live
 * cookie can walk back in". A confirmed revoke says that, and so does a server
 * that answered "there is nothing to revoke" — no vault route in this build, or
 * no session. The page cannot disable an `HttpOnly` cookie by itself, so a
 * reload after an UNCONFIRMED revoke — a 403, a restarting sidecar, a refused
 * origin — would arrive with the cookie still live and put the owner back in
 * the app; that case shows the unlock screen instead of reloading.
 */
export async function logoutAndReload(signOut: () => Promise<SignOutResult>): Promise<void> {
  const revoked = await revokeOutcome();
  clearVaultSessionToken();
  // Broker mode: the serving sidecar is one-shot, so replace it with a freshly
  // verified sibling before the reload; otherwise the reloaded gate could
  // never unlock again without restarting the app (round-2 finding 1). The
  // HTTP session is already revoked, and the restarted child starts locked.
  if (brokerAvailable()) {
    try {
      await invokeBrokerVoid(brokerCommands.logout);
    } catch {
      /* best-effort: the gate still reloads, and a stale child fails closed */
    }
  }
  try {
    await signOut();
  } catch {
    // the server session may already be gone; the revoke above is what gates
    // the reload, not this call
  }
  if (revoked === "unconfirmed") {
    // The credential the reload would present may still be live. Show the
    // unlock screen in place: `markSignedOut` outranks the "a live cookie is
    // not a reason to sit on the gate" recovery in App.tsx, and it is
    // persisted, so an F5 cannot undo it (round-4 P1).
    markSignedOut();
    return;
  }
  window.location.reload();
}
