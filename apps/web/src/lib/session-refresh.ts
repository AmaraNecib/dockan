import { useSyncExternalStore } from "react";
import { z } from "zod";
import { getGlobalBroadcastChannel } from "better-auth/client";
import { authLossReason } from "./auth-refusal";

// Public Better Auth 1.7 storage protocol. Own the reader because the installed
// channel's setup() parses untrusted storage JSON without a catch.
const STORAGE_KEY = "better-auth.message";
const sessionMessage = z.object({
  event: z.literal("session"),
  data: z.object({ trigger: z.enum(["signout", "getSession", "updateUser"]) }),
});
let generation = 0;
let lastMessage: string | null = null;
const listeners = new Set<() => void>();

export function sessionRefreshGeneration(): number {
  return generation;
}

function refresh(): void {
  generation += 1;
  for (const listener of listeners) listener();
}

function onStorage(event: StorageEvent): void {
  if (event.key !== STORAGE_KEY || !event.newValue) return;
  try {
    if (event.storageArea !== null && event.storageArea !== window.localStorage) return;
    if (!sessionMessage.safeParse(JSON.parse(event.newValue)).success) return;
    lastMessage = event.newValue;
    refresh();
  } catch {
    // Storage is advisory input, not an authentication answer.
  }
}

function onVisible(): void {
  // Do not discard a live draft merely because its tab gained focus. A missed
  // stored message can trigger verification; an unreadable store cannot establish
  // a change. Delivery is best-effort when either tab cannot use storage.
  if (document.visibilityState === "hidden" || authLossReason() !== undefined) return;
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    if (value !== lastMessage && value !== null) onStorage(new StorageEvent("storage", { key: STORAGE_KEY, newValue: value }));
  } catch {
    // A blocked read is not evidence of another tab's credential change.
    // Delivery is best-effort when storage is unavailable; auth checks remain authoritative.
  }
}

export function subscribeSessionRefresh(listener: () => void): () => void {
  if (listeners.size === 0) {
    try { lastMessage = window.localStorage.getItem(STORAGE_KEY); } catch { lastMessage = null; }
    window.addEventListener("storage", onStorage);
    window.addEventListener("focus", onVisible);
    document.addEventListener("visibilitychange", onVisible);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener("focus", onVisible);
      document.removeEventListener("visibilitychange", onVisible);
    }
  };
}

export function useSessionRefreshGeneration(): number {
  return useSyncExternalStore(subscribeSessionRefresh, sessionRefreshGeneration, sessionRefreshGeneration);
}

/** An attempted sign-out settled, not proof that any credential was revoked. */
export function publishSessionRefresh(): void {
  getGlobalBroadcastChannel().post({ event: "session", data: { trigger: "signout" }, clientId: crypto.randomUUID() });
  // Storage events do not fire in the sender. Its own logout owns reload/hold.
  // If storage is blocked, visible focus checks remain a best-effort fallback.
}
