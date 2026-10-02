import { clearVaultSessionToken, revokeVaultSession } from "./vault-client";
import { brokerAvailable, brokerCommands, invokeBrokerVoid } from "./vault-broker";

/** What a sign-out call resolves to; better-auth returns a data envelope. */
export type SignOutResult = { data: unknown } | null | undefined;

/**
 * Logout for both credential worlds. Better Auth signs the session out, but in
 * vault mode the owner access rides `dokan.vault.session` in sessionStorage;
 * leaving it behind means the reload lands straight back in the app without a
 * passphrase on a shared computer. The server-side session is revoked FIRST
 * (finding: a copied token kept authorising RPCs after logout), then the local
 * token is cleared, and the reload always happens.
 */
export async function logoutAndReload(signOut: () => Promise<SignOutResult>): Promise<void> {
  try {
    await revokeVaultSession();
  } catch {
    // an already-revoked or unreachable session must not block the logout
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
    // the server session may already be gone; the local session is cleared
    // and the reload below is the authoritative logout
  } finally {
    window.location.reload();
  }
}
