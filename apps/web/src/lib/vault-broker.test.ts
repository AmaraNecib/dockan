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
import type { BrokerInvokeArgs } from "./vault-broker";

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

  it("keeps HTTP for a browser (dev/e2e) with no broker flag", async () => {
    await vaultUnlock("correct horse battery");
    expect(calls).toEqual([]);
    expect(httpCalls).toBe(1);
    expect(readVaultSessionToken()).toBe("http-token");
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
        ? { ok: true, warning: "plaintext", plaintextRemaining: ["C:/data/dokan.db"] }
        : { ok: false, code: "VAULT_UNEXPECTED" };
    await expect(fetchVaultSetupWarning(true)).resolves.toEqual(["C:/data/dokan.db"]);
    expect(calls[0]?.command).toBe("vault_setup_warning");
  });

  it("treats a failed warning follow-up as nothing to report, never a failed setup", async () => {
    installTauri();
    responder = () => {
      throw new Error("the sidecar closed the broker pipe");
    };
    await expect(fetchVaultSetupWarning(true)).resolves.toEqual([]);
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
