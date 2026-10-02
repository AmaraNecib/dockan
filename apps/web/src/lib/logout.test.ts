import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import { logoutAndReload } from "./logout";
import { clearVaultSessionToken, readVaultSessionToken, storeVaultSessionToken } from "./vault-client";

let reloads = 0;
const originalReload = window.location.reload;

beforeEach(() => {
  reloads = 0;
  window.sessionStorage.clear();
  // happy-dom does not implement navigation; count the calls instead
  Object.defineProperty(window.location, "reload", {
    configurable: true,
    value: () => {
      reloads += 1;
    },
  });
});

afterEach(() => {
  Object.defineProperty(window.location, "reload", { configurable: true, value: originalReload });
  clearVaultSessionToken();
});

describe("logoutAndReload", () => {
  it("clears the vault session before signing out so a shared computer cannot reopen the app", async () => {
    storeVaultSessionToken("vault-session-token");
    expect(readVaultSessionToken()).toBe("vault-session-token");

    let tokenWhenSignOutRan: string | undefined = "unset";
    await logoutAndReload(async () => {
      tokenWhenSignOutRan = readVaultSessionToken();
      return null;
    });

    expect(tokenWhenSignOutRan).toBeUndefined();
    expect(readVaultSessionToken()).toBeUndefined();
    expect(reloads).toBe(1);
  });

  it("still clears and reloads when sign-out fails", async () => {
    storeVaultSessionToken("vault-session-token");
    await logoutAndReload(async () => {
      throw new Error("network down");
    });
    expect(readVaultSessionToken()).toBeUndefined();
    expect(reloads).toBe(1);
  });
});
