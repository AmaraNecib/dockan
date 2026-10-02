import { clearVaultSessionToken } from "./vault-client";

/** What a sign-out call resolves to; better-auth returns a data envelope. */
export type SignOutResult = { data: unknown } | null | undefined;

/**
 * Logout for both credential worlds. Better Auth signs the session out, but in
 * vault mode the owner access rides `dokan.vault.session` in sessionStorage;
 * leaving it behind means the reload lands straight back in the app without a
 * passphrase on a shared computer. The vault token is cleared FIRST, before
 * the async sign-out can fail or be skipped, and the reload always happens.
 */
export async function logoutAndReload(signOut: () => Promise<SignOutResult>): Promise<void> {
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
