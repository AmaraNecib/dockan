import { clearVaultSessionToken, revokeVaultSession } from "./vault-client";
import { markSignedOut } from "./auth-refusal";
import { brokerAvailable, brokerCommands, invokeBrokerVoid } from "./vault-broker";

/** What a sign-out call resolves to; better-auth returns a data envelope. */
export type SignOutResult = { data: unknown } | null | undefined;

/**
 * Logout for both credential worlds. Better Auth signs the session out, and in
 * vault mode the owner access rides one live token: the browser path carries it
 * in an `HttpOnly` cookie that survives the reload, the broker path in this
 * page's storage (#319). Leaving either behind means landing straight back in
 * the app without a passphrase on a shared computer.
 *
 * So the RELOAD only happens after the server CONFIRMED the revoke. The page
 * cannot disable an `HttpOnly` cookie by itself, so a reload after a failed
 * revoke — a 403, a restarting sidecar, a refused origin — would arrive with
 * the cookie still live and put the owner back in the app. Before #319 the
 * local clear was the guarantee; now the server is, and an unconfirmed revoke
 * shows the unlock screen instead of reloading into the app.
 */
export async function logoutAndReload(signOut: () => Promise<SignOutResult>): Promise<void> {
  let revoked = false;
  try {
    await revokeVaultSession();
    revoked = true;
  } catch {
    // an unreachable or already-revoked session is not a reason to throw; it
    // is a reason not to reload (below)
  }
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
  if (!revoked) {
    // The credential the reload would present is still live. Show the unlock
    // screen in place: `markSignedOut` outranks the "a live cookie is not a
    // reason to sit on the gate" recovery in App.tsx, so the app cannot
    // reappear behind the owner's back.
    markSignedOut();
    return;
  }
  window.location.reload();
}
