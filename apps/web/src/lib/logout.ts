import { clearVaultSessionToken, revokeVaultSession } from "./vault-client";

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
  try {
    await signOut();
  } catch {
    // the server session may already be gone; the local session is cleared
    // and the reload below is the authoritative logout
  } finally {
    window.location.reload();
  }
}
