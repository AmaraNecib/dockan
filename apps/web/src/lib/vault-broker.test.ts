import { afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  acknowledgeVaultSetup,
  fetchVaultStatus,
  fetchVaultSetupWarning,
  readVaultSessionToken,
  resetVaultPassphrase,
  VaultRequestError,
  vaultSetup,
  vaultUnlock,
  vaultUnlockWithRecovery,
} from "./vault-client";
import { brokerAvailable, type BrokerInvokeArgs } from "./vault-broker";

/**
 * Issue #141: inside the desktop shell the gate's passphrase travels over the
 * Tauri IPC bridge to the sidecar's stdin pipe. These tests fake the same
 * `window.__TAURI_INTERNALS__.invoke` the shell injects and assert the secret
 * never reaches fetch.
 */

type StatusPayload = {
  mode: "vault";
  state: "locked";
  legacyDatabase: boolean;
  recoveryKeyCount: number;
  lockedForMs: number;
  unlocked: boolean;
  broker: boolean;
};

/** The broker reply shape this test fakes (subset of the real wire contract). */
type BrokerWireReply = {
  ok: boolean;
  code?: string;
  retryAfterMs?: number;
  sessionToken?: string;
  sessionGeneration?: number;
  recoveryKey?: string;
  plaintextRemaining?: string[];
  status?: StatusPayload;
};

type InvokeCall = { command: string; args?: BrokerInvokeArgs };
type TauriInternals = { invoke: (command: string, args?: BrokerInvokeArgs) => Promise<BrokerWireReply> };

const statusJson = (broker: boolean): StatusPayload => ({
  mode: "vault",
  state: "locked",
  legacyDatabase: false,
  recoveryKeyCount: 0,
  lockedForMs: 0,
  unlocked: false,
  broker,
});

let calls: InvokeCall[] = [];
let responder: (call: InvokeCall) => BrokerWireReply = () => ({ ok: false, code: "VAULT_UNEXPECTED" });
let httpCalls = 0;
const originalFetch = globalThis.fetch;

function installTauri(): void {
  // SAFETY: this is the exact global the Tauri webview injects; the test
  // stands in for it so the client's dispatch can be observed
  (window as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__ = {
    invoke: async (command, args) => {
      calls.push({ command, args });
      return responder({ command, args });
    },
  };
}

beforeEach(() => {
  calls = [];
  httpCalls = 0;
  // SAFETY: the mock returns the same Response the real fetch would; the
  // assertion only covers the callback signature, not a parsed value
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    httpCalls += 1;
    const raw = input instanceof Request ? input.url : String(input);
    const path = new URL(raw, "http://localhost").pathname;
    if (path === "/api/vault/unlock") return Response.json({ sessionToken: "http-token" });
    if (path === "/api/vault/setup") return Response.json({ recoveryKey: "HTTP-KEY", sessionToken: "http-setup" });
    if (path === "/api/vault/unlock-recovery") return Response.json({ sessionToken: "http-recovery" });
    return Response.json(statusJson(false));
  }) as typeof fetch;
  window.sessionStorage.clear();
});

afterEach(() => {
  // SAFETY: the test installed this exact optional global above
  delete (window as { __TAURI_INTERNALS__?: TauriInternals }).__TAURI_INTERNALS__;
  globalThis.fetch = originalFetch;
});

describe("desktop stdin broker transport (issue #141)", () => {
  it("unlocks over the shell's pipe and never calls fetch", async () => {
    installTauri();
    responder = () => ({ ok: true, sessionToken: "broker-token", sessionGeneration: 4 });
    const token = await vaultUnlock("correct horse battery", true);
    expect(token).toBe("broker-token");
    expect(calls).toEqual([{ command: "vault_unlock", args: { passphrase: "correct horse battery" } }]);
    expect(readVaultSessionToken()).toBe("broker-token");
    expect(httpCalls).toBe(0);
  });

  it("maps a broker refusal to the same stable error the HTTP path throws", async () => {
    installTauri();
    responder = () => ({ ok: false, code: "VAULT_WRONG_PASSPHRASE", retryAfterMs: 30_000 });
    try {
      await vaultUnlock("wrong horse battery", true);
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(VaultRequestError);
      if (error instanceof VaultRequestError) {
        expect(error.code).toBe("VAULT_WRONG_PASSPHRASE");
        expect(error.retryAfterMs).toBe(30_000);
      }
    }
    expect(httpCalls).toBe(0);
  });

  it("surfaces a dead bridge as the generic refusal, never a raw code", async () => {
    installTauri();
    responder = () => {
      throw new Error("the sidecar was never started");
    };
    await expect(vaultUnlock("correct horse battery", true)).rejects.toThrow("VAULT_UNEXPECTED");
  });

  it("fails with VAULT_BROKER_REQUIRED, never VAULT_UNEXPECTED, when the API says broker mode but the webview has no bridge (shipped bug)", async () => {
    // The real shipped bug: the sidecar runs in broker mode, so the HTTP
    // /api/vault/status reports broker: true, but the Tauri capability did not
    // list the loopback remote origin, so the webview never got the IPC
    // bridge. The secret must not be handed to a missing invoke AND must not
    // fall back to HTTP (the API refuses broker-mode credential routes).
    expect(brokerAvailable()).toBe(false);

    const attempts = [
      () => vaultSetup("correct horse battery", "setup-token", true),
      () => vaultUnlock("correct horse battery", true),
      () => vaultUnlockWithRecovery("ABCD-EFGH-IJKL", true),
      () => resetVaultPassphrase("ABCD-EFGH-IJKL", "a brand new passphrase", true),
    ];
    for (const attempt of attempts) {
      let caught: Error | undefined;
      try {
        await attempt();
      } catch (error) {
        caught = error instanceof Error ? error : new Error(String(error));
      }
      expect(caught).toBeInstanceOf(VaultRequestError);
      if (caught instanceof VaultRequestError) expect(caught.code).toBe("VAULT_BROKER_REQUIRED");
    }

    // no IPC call was attempted and the secret never reached the network
    expect(calls).toEqual([]);
    expect(httpCalls).toBe(0);
  });

  it("keeps HTTP for a browser (dev/e2e) with no broker flag", async () => {
    await vaultUnlock("correct horse battery");
    expect(calls).toEqual([]);
    expect(httpCalls).toBe(1);
    expect(readVaultSessionToken()).toBe("http-token");
  });

  it("keeps HTTP when the Tauri dev window has a bridge but the API is not in broker mode", async () => {
    // `tauri dev` injects the bridge but spawns no sidecar, so the API status
    // reports broker: false. The API flag must gate the bridge (AND), not the
    // reverse: otherwise dev unlock would try a nonexistent sidecar and fail.
    installTauri();
    responder = () => ({ ok: true, sessionToken: "broker-token" });
    const token = await vaultUnlock("correct horse battery", false);
    expect(token).toBe("http-token");
    expect(calls).toEqual([]);
    expect(httpCalls).toBe(1);
  });

  it("sets up over the broker and acknowledges the recovery key over the same pipe", async () => {
    installTauri();
    responder = (call) =>
      call.command === "vault_setup"
        ? { ok: true, sessionToken: "setup-token", recoveryKey: "ABCD-EFGH", plaintextRemaining: [] }
        : { ok: true };
    const result = await vaultSetup("correct horse battery", "shell-token", true);
    expect(result.recoveryKey).toBe("ABCD-EFGH");
    expect(readVaultSessionToken()).toBe("setup-token");
    expect(calls[0]).toEqual({ command: "vault_setup", args: { passphrase: "correct horse battery" } });

    await acknowledgeVaultSetup(true);
    expect(calls.map((call) => call.command)).toEqual(["vault_setup", "vault_setup_saved"]);
    expect(httpCalls).toBe(0);
  });

  it("unlocks with a recovery key over the broker", async () => {
    installTauri();
    responder = () => ({ ok: true, sessionToken: "recovery-token" });
    const token = await vaultUnlockWithRecovery("ABCD-EFGH-IJKL", true);
    expect(token).toBe("recovery-token");
    expect(calls[0]).toEqual({ command: "vault_unlock_recovery", args: { recoveryKey: "ABCD-EFGH-IJKL" } });
    expect(httpCalls).toBe(0);
  });

  it("resets the passphrase from a recovery key over the broker for settings (round-2 finding 2)", async () => {
    installTauri();
    responder = () => ({ ok: true, sessionToken: "reset-token", sessionGeneration: 6 });
    const token = await resetVaultPassphrase("ABCD-EFGH-IJKL", "a brand new passphrase", true);
    expect(token).toBe("reset-token");
    expect(calls[0]).toEqual({
      command: "vault_reset_passphrase",
      args: { recoveryKey: "ABCD-EFGH-IJKL", newPassphrase: "a brand new passphrase" },
    });
    expect(readVaultSessionToken()).toBe("reset-token");
    expect(httpCalls).toBe(0);
  });

  it("does not acknowledge a setup that went over HTTP", async () => {
    await acknowledgeVaultSetup(false);
    expect(calls).toEqual([]);
  });

  it("delivers the plaintext warning as the setup follow-up (round-3 finding 1)", async () => {
    installTauri();
    responder = (call) =>
      call.command === "vault_setup_warning"
        ? { ok: true, warning: "plaintext", plaintextStatus: "remaining", plaintextRemaining: ["C:/data/dokan.db"] }
        : { ok: false, code: "VAULT_UNEXPECTED" };
    await expect(fetchVaultSetupWarning(true)).resolves.toEqual({ status: "remaining", paths: ["C:/data/dokan.db"] });
    expect(calls[0]?.command).toBe("vault_setup_warning");
  });

  it("reports a confirmed clean sweep as clean", async () => {
    installTauri();
    responder = () => ({ ok: true, warning: "plaintext", plaintextStatus: "clean", plaintextRemaining: [] });
    await expect(fetchVaultSetupWarning(true)).resolves.toEqual({ status: "clean" });
  });

  it("maps a timed-out or broken warning pipe to UNKNOWN, never clean (round-4 finding)", async () => {
    installTauri();
    responder = () => {
      throw new Error("the sidecar did not answer in time");
    };
    await expect(fetchVaultSetupWarning(true)).resolves.toEqual({ status: "unknown" });
  });

  it("reports UNKNOWN for the setup warning when broker mode has no bridge, never clean", async () => {
    // the trailing follow-up of the same shipped bug: broker mode but no
    // bridge must not tell the owner the plaintext sweep was clean
    await expect(fetchVaultSetupWarning(true)).resolves.toEqual({ status: "unknown" });
  });

  it("maps a warning reply that admits failure to UNKNOWN (round-4 finding)", async () => {
    installTauri();
    responder = () => ({ ok: true, warning: "plaintext", plaintextStatus: "unknown", plaintextRemaining: [] });
    await expect(fetchVaultSetupWarning(true)).resolves.toEqual({ status: "unknown" });
  });

  it("treats a reply with no verdict and no paths as UNKNOWN, never clean (round-4 finding)", async () => {
    installTauri();
    responder = () => ({ ok: true });
    await expect(fetchVaultSetupWarning(true)).resolves.toEqual({ status: "unknown" });
  });

  it("reads the gate status from the broker first when the shell is present", async () => {
    installTauri();
    responder = () => ({ ok: true, status: statusJson(true) });
    const status = await fetchVaultStatus();
    expect(status.broker).toBe(true);
    expect(calls[0]?.command).toBe("vault_status");
    expect(httpCalls).toBe(0);
  });

  it("falls back to HTTP when the shell has no broker child yet", async () => {
    installTauri();
    responder = () => {
      throw new Error("the sidecar was never started");
    };
    const status = await fetchVaultStatus();
    expect(status.broker).toBe(false);
    expect(httpCalls).toBe(1);
  });
});
