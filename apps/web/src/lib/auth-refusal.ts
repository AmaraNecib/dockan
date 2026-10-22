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
 * - a SIGN-OUT the server could not confirm is a decision. It is held in this
 *   WINDOW's memory and in its `sessionStorage`, so neither a reload nor a storage
 *   that refuses every call can undo it (round-4 P1, round-6 finding 1): the
 *   revoke failed, the `HttpOnly` cookie is still live, and the next page load
 *   would otherwise find `status.session` true and mount the app — the
 *   shared-machine failure `logout.ts` exists to prevent.
 *
 *   `sessionStorage`, not `localStorage` (#341 fresh-eyes P2): the hold belongs to
 *   the window that signed out. `localStorage` is shared by every tab of the
 *   origin, so one window's failed sign-out would gate a sibling that still held a
 *   live credential, and any window's unlock would clear the hold of the window
 *   that actually signed out. A tab is what asked, and a tab is what
 *   `sessionStorage` scopes — while still surviving the F5 the hold exists for.
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

/**
 * The unconfirmed sign-out held in THIS page's memory, beside the persisted
 * one and not a cache of it.
 *
 * It is the half that a profile with a full quota, a blocked storage or a
 * partitioned store still gets (round-6 finding 1). Without it the hold existed
 * only in storage, so on such a profile `markSignedOut()` threw, the
 * throw was swallowed as best-effort, and `authLostState()` answered `false`
 * while the revoke had never been confirmed — `logoutAndReload()` returned
 * without reloading and without hiding the still-authenticated app. A comment
 * here claimed this flag existed; now it does.
 *
 * Set BEFORE the storage write and cleared only by `clearAuthLost()`, so the
 * hold cannot be lost between the two.
 */
let signedOutLost = false;

/** Whether the last sign-out could not be confirmed, read fresh every time. */
function signedOutRemembered(): boolean {
  try {
    return window.sessionStorage.getItem(SIGNED_OUT_STORAGE_KEY) === "1";
  } catch {
    // a profile that refuses storage cannot persist the hold; `signedOutLost`
    // holds it for this page either way, and a throw here would take the app down
    return false;
  }
}

function rememberSignedOut(): void {
  try {
    window.sessionStorage.setItem(SIGNED_OUT_STORAGE_KEY, "1");
  } catch {
    /* best-effort: without storage the hold lasts this page's lifetime */
  }
}

function forgetSignedOut(): void {
  try {
    window.sessionStorage.removeItem(SIGNED_OUT_STORAGE_KEY);
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
  // memory first: it is the only copy on a profile whose storage throws, and it
  // is never absent when the persisted one is present
  if (signedOutLost || signedOutRemembered()) return "signed-out";
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
  // MEMORY BEFORE STORAGE: `rememberSignedOut` is best-effort by design, so a
  // storage that throws must cost the reload survival and nothing else. Held the
  // other way round, a refused write left the gate down on a cookie the server
  // never dropped (round-6 finding 1).
  signedOutLost = true;
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
  signedOutLost = false;
  forgetSignedOut();
  if (wasHeld) notify();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
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

/**
 * Whether the session is gone and the unlock screen must take over, and why.
 *
 * One hook rather than a boolean plus a separate read, because every caller that
 * needs the screen also needs the REASON (round-6 finding 3): only a refusal may
 * be taken back by a live session, so a listener that re-reads the shared
 * session has to know which reason is up, not merely that one is. Adding a
 * second `useAuthLost()` beside it invited exactly that bug, so it was removed
 * rather than left as a wider way to ask the same question.
 */
export function useAuthLossReason(): "refusal" | "signed-out" | undefined {
  return useSyncExternalStore(subscribe, authLossReason, authLossReason);
}
