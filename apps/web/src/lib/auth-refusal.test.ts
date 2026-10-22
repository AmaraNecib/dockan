import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { SIGNED_OUT_STORAGE_KEY, authLossReason, clearAuthLost, markSignedOut } from "./auth-refusal";

// red-on-parent-waive: 'the memory hold' — the module under test (./auth-refusal) is introduced by this change; discrimination is the ablation proof, not a parent run
// red-on-parent-waive: 'a cleared hold' — the module under test (./auth-refusal) is introduced by this change; discrimination is the ablation proof, not a parent run

/**
 * The unconfirmed sign-out's fallback, tested where the hold lives (#319
 * round-6 finding 1).
 *
 * The finding was that `markSignedOut()` wrote to `localStorage` and nowhere
 * else: `rememberSignedOut()` swallowed a throwing `setItem`, so
 * `authLostState()` still answered `false` and `logoutAndReload()` returned
 * without reloading and without hiding the still-authenticated app — on a
 * profile whose storage is full or blocked, which is exactly the shared-machine
 * case the hold exists for. Two comments claimed a memory fallback. Neither was
 * true. These tests are what makes them true, and they are at this boundary
 * because the mount only ever SEES the module's answer; `App.test.tsx` proves
 * the screen for the screen's sake.
 *
 * happy-dom's `localStorage` is a Proxy whose instance methods cannot be
 * shadowed and whose writes never throw, so a dead storage is installed by
 * replacing the window property — the same way the platform hands a page a
 * storage that refuses it.
 */

const originalDescriptor = Object.getOwnPropertyDescriptor(window, "localStorage");

/** A storage that refuses every call: a full quota, or a store the profile blocks. */
const deadStorage: Storage = {
  get length(): number {
    throw new Error("storage is blocked");
  },
  clear: () => {
    throw new Error("storage is blocked");
  },
  getItem: () => {
    throw new Error("storage is blocked");
  },
  key: () => {
    throw new Error("storage is blocked");
  },
  removeItem: () => {
    throw new Error("storage is blocked");
  },
  setItem: () => {
    throw new Error("storage is blocked");
  },
};

function installDeadStorage(): void {
  Object.defineProperty(window, "localStorage", { configurable: true, value: deadStorage });
}

beforeEach(() => {
  // a failed test must not leave the next one with a storage it cannot read
  if (originalDescriptor !== undefined) Object.defineProperty(window, "localStorage", originalDescriptor);
  window.localStorage.removeItem(SIGNED_OUT_STORAGE_KEY);
  clearAuthLost();
});

afterEach(() => {
  if (originalDescriptor !== undefined) Object.defineProperty(window, "localStorage", originalDescriptor);
  clearAuthLost();
});

describe("an unconfirmed sign-out on a profile that refuses storage (#319 round 6)", () => {
  it("the memory hold raises the gate when every storage call throws", () => {
    installDeadStorage();
    // the fixture is the finding: this is a profile where the write CANNOT land
    expect(() => window.localStorage.setItem(SIGNED_OUT_STORAGE_KEY, "1")).toThrow("storage is blocked");

    markSignedOut();

    // the hold stands on memory alone: nothing was persisted, and the gate is
    // up anyway. Before the fix this answered `undefined` — the app stayed
    // mounted on a cookie the server never dropped.
    expect(authLossReason()).toBe("signed-out");
    expect(() => window.localStorage.getItem(SIGNED_OUT_STORAGE_KEY)).toThrow("storage is blocked");
  });

  it("a cleared hold is really gone, so the next sign-out is its own episode", () => {
    installDeadStorage();

    markSignedOut();
    expect(authLossReason()).toBe("signed-out");

    // the owner's unlock is the one thing that ends a sign-out, and on this
    // profile `forgetSignedOut()` throws too: the memory flag is the only copy,
    // so a clear that missed it would hold the gate for the life of the page
    clearAuthLost();
    expect(authLossReason()).toBeUndefined();

    // and it is not a one-way latch: a second unconfirmed sign-out rises again
    markSignedOut();
    expect(authLossReason()).toBe("signed-out");
  });
});
