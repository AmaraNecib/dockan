import { beforeEach, describe, expect, it } from "bun:test";

import { AUTH_REFUSAL } from "@dokan/contracts";

import { authLossReason, clearAuthLost, isAuthRefusal } from "./auth-refusal";
import { createDokanRpcClient } from "./rpc-link";
import { subscribeSessionRefresh } from "./session-refresh";

/**
 * The wire → unlock-screen chain (#319), tested where it actually lives.
 *
 * `App.test.tsx` mocks `@/lib/rpc` wholesale, so it can only prove the SCREEN
 * reacts to a refusal — it called `markAuthLost()` itself and never ran the
 * interceptor. Deleting the interceptor from the link left every one of those
 * tests green (test-audit lens, round 2). This file builds a client from the
 * real `createDokanRpcClient` factory and drives a real oRPC error envelope
 * through it, so the refusal → store → gate chain has one place that runs end
 * to end.
 *
 * The parent gate cannot load this file because `auth-refusal.ts` uses a local
 * export list that the hollow writer cannot mirror; the whole-file waiver records
 * that exact limitation.
 */

// red-on-parent-waive: "whole file" — auth-refusal.ts uses a local export list that the gate cannot mirror

const originalFetch = globalThis.fetch;
const rpcClient = createDokanRpcClient();

/**
 * The link builds its URL from `window.location.origin`, which the happy-dom
 * preload leaves as `about:blank`; a real page always has one, so the test
 * gives the window the origin a browser would have.
 */
// SAFETY: happy-dom's own registry object is the only thing read here, and a
// globals-only binding without it simply leaves the URL as it was
const happyDom = (window as { happyDOM?: { setURL?: (url: string) => void } }).happyDOM;
happyDom?.setURL?.("http://localhost:5173/");

/**
 * The body oRPC decodes as an `ORPCError`: the codec wraps every payload in
 * `{ json }`, and an error payload is `ORPCError.toJSON()`.
 */
function refusalEnvelope(code: string, message: string, status: number): Response {
  return Response.json({ json: { defined: false, code, status, message } }, { status });
}

beforeEach(() => {
  clearAuthLost();
  globalThis.fetch = originalFetch;
});

describe("the RPC refusal reaches the unlock screen (#319 round 2)", () => {
  it("ignores a refusal that completes after its credential scope was retired", async () => {
    let release!: (response: Response) => void;
    globalThis.fetch = Object.assign(() => new Promise<Response>((resolve) => { release = resolve; }), { preconnect: originalFetch.preconnect });
    const stop = subscribeSessionRefresh(() => {});
    try {
      const pending = rpcClient.categoriesList();
      const rejected = pending.catch((error: Error) => error);
      for (let i = 0; i < 30 && !release; i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
      expect(release).toBeDefined();
      window.dispatchEvent(new StorageEvent("storage", { key: "better-auth.message", newValue: '{"event":"session","data":{"trigger":"signout"}}' }));
      release(refusalEnvelope(AUTH_REFUSAL.code, AUTH_REFUSAL.message, 401));
      expect(await rejected).toMatchObject({ message: AUTH_REFUSAL.message });
      expect(authLossReason()).toBeUndefined();
    } finally { stop(); }
  });

  it("records the loss when the wire answers UNAUTHORIZED / AUTH_REQUIRED", async () => {
    globalThis.fetch = Object.assign(
      async () => refusalEnvelope(AUTH_REFUSAL.code, AUTH_REFUSAL.message, 401),
      { preconnect: originalFetch.preconnect },
    );
    // the call fails — the point is what it did on the way out
    await expect(rpcClient.categoriesList()).rejects.toThrow(AUTH_REFUSAL.message);
    expect(authLossReason()).toBe("refusal");
  });

  it("leaves the screen alone for a refusal that is not the session's", async () => {
    globalThis.fetch = Object.assign(
      async () => refusalEnvelope("FORBIDDEN", "VAULT_ORIGIN_FORBIDDEN", 403),
      { preconnect: originalFetch.preconnect },
    );
    await expect(rpcClient.categoriesList()).rejects.toThrow("VAULT_ORIGIN_FORBIDDEN");
    // a foreign-origin refusal is NOT "your session died": no unlock screen
    expect(authLossReason()).toBeUndefined();
  });

  it("leaves the screen alone for an unrelated failure", async () => {
    globalThis.fetch = Object.assign(
      async () => {
        throw new TypeError("network down");
      },
      { preconnect: originalFetch.preconnect },
    );
    await expect(rpcClient.categoriesList()).rejects.toThrow();
    expect(authLossReason()).toBeUndefined();
  });
});

describe("the refusal identity is one pair, not two hand copies (#319 round 2)", () => {
  it("matches only the exact code AND message", () => {
    expect(isAuthRefusal(AUTH_REFUSAL)).toBe(true);
    // each half alone is not the refusal: the message is what the unlock
    // screen is raised for, and a same-code refusal of another kind (an
    // expired legacy cookie) must not be read as the vault session's death
    expect(isAuthRefusal({ code: AUTH_REFUSAL.code, message: "SOMETHING_ELSE" })).toBe(false);
    expect(isAuthRefusal({ code: "FORBIDDEN", message: AUTH_REFUSAL.message })).toBe(false);
    expect(isAuthRefusal({ code: "FORBIDDEN", message: "FORBIDDEN" })).toBe(false);
  });
});
