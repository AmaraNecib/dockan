import { useSyncExternalStore } from "react";

import { AUTH_REFUSAL } from "@dokan/contracts";

/**
 * The vault session can die under a live window: another window replaced it,
 * the owner logged out, the vault was locked. The refusal that says so arrives
 * as an RPC error, and the app has to answer it with the unlock screen instead
 * of a page of failed queries (issue #319).
 *
 * The signal is module state on purpose: the refusal is not a property of a
 * screen, and the screen that must react may not be mounted yet.
 */

/**
 * The refusal code and sentence the API sends when the vault session is gone,
 * re-exported from `@dokan/contracts` where the RPC seam also reads it. It used
 * to be two hand-copied literals — the API threw `AUTH_REQUIRED` and this file
 * compared against its own copy — so changing one word on the wire left every
 * test green and silently killed the user-facing half of #319.
 */
export { AUTH_REFUSAL };

let authLost: false | "refusal" | "signed-out" = false;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

/** What the wire says about a failed call; the shape every oRPC error has. */
export type RefusalIdentity = { readonly code: string; readonly message: string };

/** Whether a failure identity is the API's "this session is gone" refusal. */
export function isAuthRefusal(refusal: RefusalIdentity): boolean {
  return refusal.code === AUTH_REFUSAL.code && refusal.message === AUTH_REFUSAL.message;
}

/** Record the refusal; every mounted listener hears about it. */
export function markAuthLost(): void {
  if (authLost !== false) return;
  authLost = "refusal";
  notify();
}

/**
 * Record a sign-out the server could NOT confirm: the vault cookie is still
 * live, and this page can no longer clear it (#319 review). The reload a
 * successful logout performs would land straight back in the app, so the page
 * stays put and shows the unlock screen instead. This is its own reason for
 * the screen, because a live cookie must not undo it: see `recoverAuthLost`.
 */
export function markSignedOut(): void {
  if (authLost === "signed-out") return;
  authLost = "signed-out";
  notify();
}

/**
 * Drop a REFUSAL because the server now reports that this request's credential
 * is the live session again. It is not a general clear: a refusal can be
 * transient — a query in flight across another window's rotation — and this is
 * what lets the page recover from one without a passphrase (#319 review P1).
 * A confirmed-absent sign-out is left alone: a live cookie does not undo a
 * logout.
 */
export function recoverAuthLost(): void {
  if (authLost !== "refusal") return;
  authLost = false;
  notify();
}

/** Forget the loss: the owner unlocked again, which is a fresh credential. */
export function clearAuthLost(): void {
  if (authLost === false) return;
  authLost = false;
  notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): boolean {
  return authLost !== false;
}

/**
 * Why the unlock screen is up, or undefined when it is not. Exported for the
 * callers that must tell a transient refusal from a sign-out the server never
 * confirmed — only the first may be recovered by a live session.
 */
export function authLossReason(): "refusal" | "signed-out" | undefined {
  return authLost === false ? undefined : authLost;
}

/** Whether the session is gone and the unlock screen must take over. */
export function useAuthLost(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
