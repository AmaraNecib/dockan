import { useSyncExternalStore } from "react";

import { AUTH_REFUSAL } from "@dokan/contracts";

/**
 * The vault session can die under a live window: another window replaced it,
 * the owner logged out, the vault was locked. The refusal that says so arrives
 * as an RPC error, and the app has to answer it with the unlock screen instead
 * of a page of failed queries (issue #319).
 *
 * Two reasons for that screen, and they do not have the same lifetime:
 *
 * - a REFUSAL is a moment. It is module state, it can be transient (a query in
 *   flight across another window's rotation), and a live session is allowed to
 *   take it back.
 * - a SIGN-OUT the server could not confirm is a decision. It is persisted, so
 *   a reload cannot undo it (round-4 P1): the revoke failed, the `HttpOnly`
 *   cookie is still live, and the next page load would otherwise find
 *   `status.session` true and mount the app — the shared-machine failure
 *   `logout.ts` exists to prevent.
 */

/**
 * The refusal code and sentence the API sends when the vault session is gone,
 * re-exported from `@dokan/contracts` where the RPC seam also reads it. It used
 * to be two hand-copied literals — the API threw `AUTH_REQUIRED` and this file
 * compared against its own copy — so changing one word on the wire left every
 * test green and silently killed the user-facing half of #319.
 */
export { AUTH_REFUSAL };

/**
 * Where the unconfirmed sign-out is remembered across a reload.
 *
 * It holds `"1"` and nothing else, because it is NOT a credential: it carries
 * no token, cannot be replayed to the server, and its only effect is to keep
 * the unlock screen up. A page that forges it denies itself the app; it never
 * gains access. (The ADR's "the web holds no token" rule covers the token and
 * generation keys — this flag is not one, and it fails closed.)
 */
export const SIGNED_OUT_STORAGE_KEY = "dokan.auth.signed-out";

/** Whether the last sign-out could not be confirmed, read fresh every time. */
function signedOutRemembered(): boolean {
  try {
    return window.localStorage.getItem(SIGNED_OUT_STORAGE_KEY) === "1";
  } catch {
    // a profile that refuses storage cannot persist the hold; the module keeps
    // the refusal in memory either way, and a throw here would take the app down
    return false;
  }
}

function rememberSignedOut(): void {
  try {
    window.localStorage.setItem(SIGNED_OUT_STORAGE_KEY, "1");
  } catch {
    /* best-effort: without storage the hold lasts this page's lifetime */
  }
}

function forgetSignedOut(): void {
  try {
    window.localStorage.removeItem(SIGNED_OUT_STORAGE_KEY);
  } catch {
    /* nothing to forget when nothing could be written */
  }
}

/** The refusal is a moment, not a decision: memory only, never storage. */
let refusalLost = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * Why the unlock screen is up, or false when it is not. Read through a function
 * rather than a variable so a page that reloaded sees the persisted sign-out on
 * its very first render — the whole point of persisting it.
 */
function authLostState(): false | "refusal" | "signed-out" {
  if (signedOutRemembered()) return "signed-out";
  return refusalLost ? "refusal" : false;
}

/** What the wire says about a failed call; the shape every oRPC error has. */
export type RefusalIdentity = { readonly code: string; readonly message: string };

/** Whether a failure identity is the API's "this session is gone" refusal. */
export function isAuthRefusal(refusal: RefusalIdentity): boolean {
  return refusal.code === AUTH_REFUSAL.code && refusal.message === AUTH_REFUSAL.message;
}

/**
 * Record the refusal; every mounted listener hears about it.
 *
 * The early return is the whole asymmetry, and it runs one way: a refusal never
 * DEMOTES a sign-out (a live cookie answering the re-probe must not take the
 * unlock screen back), and it does not stack on an earlier refusal either —
 * one episode, one screen, one re-probe.
 */
export function markAuthLost(): void {
  if (authLostState() !== false) return;
  refusalLost = true;
  notify();
}

/**
 * Record a sign-out the server could NOT confirm: the vault cookie is still
 * live, and this page can no longer clear it (#319 review). The reload a
 * successful logout performs would land straight back in the app, so the page
 * stays put and shows the unlock screen instead. It is persisted, because a
 * reload would otherwise re-read `status.session` from the live cookie and
 * mount the app behind the owner's back (round-4 P1).
 */
export function markSignedOut(): void {
  const alreadyHeld = authLostState() === "signed-out";
  rememberSignedOut();
  if (alreadyHeld) return;
  notify();
}

/**
 * Drop a REFUSAL because the server now reports that this request's credential
 * is the live session again. It is not a general clear: a refusal can be
 * transient — a query in flight across another window's rotation — and this is
 * what lets the page recover from one without a passphrase (#319 review P1).
 * A sign-out the server never confirmed is left alone: a live cookie does not
 * undo a logout.
 */
export function recoverAuthLost(): void {
  if (authLostState() !== "refusal") return;
  refusalLost = false;
  notify();
}

/** Forget the loss: the owner unlocked again, which is a fresh credential. */
export function clearAuthLost(): void {
  const wasHeld = authLostState() !== false;
  refusalLost = false;
  forgetSignedOut();
  if (wasHeld) notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): boolean {
  return authLostState() !== false;
}

/**
 * Why the unlock screen is up, or undefined when it is not. Exported for the
 * callers that must tell a transient refusal from a sign-out the server never
 * confirmed — only the first may be recovered by a live session.
 */
export function authLossReason(): "refusal" | "signed-out" | undefined {
  const reason = authLostState();
  return reason === false ? undefined : reason;
}

/** Whether the session is gone and the unlock screen must take over. */
export function useAuthLost(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
