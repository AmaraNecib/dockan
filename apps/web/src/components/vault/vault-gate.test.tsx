import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "@/lib/i18n";
import { VaultGate } from "./vault-gate";
import type { VaultStatus } from "@/lib/vault-client";

const statusFor = (state: VaultStatus["state"], extra: Partial<VaultStatus> = {}): VaultStatus => ({
  mode: "vault",
  state,
  legacyDatabase: false,
  recoveryKeyCount: state === "unconfigured" ? 0 : 1,
  lockedForMs: 0,
  unlocked: state === "unlocked",
  ...extra,
});

let routes = new Map<string, (init: RequestInit | undefined) => Response>();
const originalFetch = globalThis.fetch;
const mockFetch: typeof fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const path = new URL(url, "http://localhost").pathname;
    const handler = routes.get(path);
    if (handler === undefined) return new Response("not found", { status: 404 });
    return handler(init);
  },
  { preconnect: originalFetch.preconnect },
);

let mounted: Array<{ root: ReturnType<typeof createRoot>; host: HTMLElement }> = [];

beforeEach(() => {
  routes = new Map();
  globalThis.fetch = mockFetch;
  window.sessionStorage.clear();
});

afterEach(() => {
  for (const entry of mounted) act(() => entry.root.unmount());
  mounted = [];
  globalThis.fetch = originalFetch;
});

async function mount(status: VaultStatus, onUnlocked: () => void): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => {
    root.render(<VaultGate status={status} onUnlocked={onUnlocked} />);
  });
  return host;
}

/** React listens for the native setter + input event, not a value assignment. */
function setValue(host: HTMLElement, testId: string, value: string): void {
  const input = host.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`);
  if (input === null) throw new Error(`missing input ${testId}`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter === undefined) throw new Error("HTMLInputElement value setter missing");
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submit(host: HTMLElement, testId: string): Promise<void> {
  const button = host.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (button === null) throw new Error(`missing button ${testId}`);
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

describe("VaultGate", () => {
  it("creates the vault, shows the recovery key once, and requires the save acknowledgement", async () => {
    const recoveryKey = "ABCD-EFGH-IJKL-MNPQ-RSTU-VWXY-Z234-567A-BC";
    routes.set("/api/vault/setup", () => Response.json({ ok: true, recoveryKey, sessionToken: "session-token" }));
    let unlocked = 0;
    const host = await mount(statusFor("unconfigured"), () => {
      unlocked += 1;
    });

    expect(host.textContent).toContain("إذا فقدت كلمة المرور ومفتاح الاسترداد معاً");
    setValue(host, "vault-passphrase", "correct horse battery");
    setValue(host, "vault-passphrase-confirm", "correct horse battery");
    await submit(host, "vault-setup-submit");

    expect(host.querySelector('[data-testid="vault-recovery-key"]')?.textContent).toBe(recoveryKey);
    const continueButton = host.querySelector<HTMLButtonElement>('[data-testid="vault-recovery-continue"]');
    expect(continueButton?.disabled).toBe(true);
    // the session token is already stored so the app can proceed after the ack
    expect(window.sessionStorage.getItem("dokan.vault.session")).toBe("session-token");

    const checkbox = host.querySelector<HTMLInputElement>('[data-testid="vault-recovery-confirm"]');
    if (checkbox === null) throw new Error("missing recovery confirm");
    await act(async () => {
      checkbox.click();
    });
    expect(continueButton?.disabled).toBe(false);
    await act(async () => {
      continueButton?.click();
    });
    expect(unlocked).toBe(1);
  });

  it("shows the Arabic refusal for a wrong passphrase and keeps the form usable", async () => {
    routes.set("/api/vault/unlock", () =>
      Response.json(
        { error: { code: "VAULT_WRONG_PASSPHRASE", message: "كلمة المرور غير صحيحة. تحقّق منها ثم أعد المحاولة." } },
        { status: 401 },
      ),
    );
    const host = await mount(statusFor("locked"), () => {
      throw new Error("must not unlock");
    });
    setValue(host, "vault-passphrase", "wrong passphrase");
    await submit(host, "vault-unlock-submit");
    expect(host.querySelector('[data-testid="vault-error"]')?.textContent).toContain("كلمة المرور غير صحيحة");
  });

  it("unlocks with a recovery key through the recovery screen", async () => {
    routes.set("/api/vault/unlock-recovery", () => Response.json({ ok: true, sessionToken: "recovery-session" }));
    let unlocked = 0;
    const host = await mount(statusFor("locked"), () => {
      unlocked += 1;
    });
    await submit(host, "vault-use-recovery");
    setValue(host, "vault-recovery-input", "ABCD-EFGH-IJKL-MNPQ-RSTU-VWXY-Z234-567A-BC");
    await submit(host, "vault-recovery-submit");
    expect(unlocked).toBe(1);
  });

  it("warns when setup could not remove plaintext files (finding 2)", async () => {
    const recoveryKey = "ABCD-EFGH-IJKL-MNPQ-RSTU-VWXY-Z234-567A-BC";
    routes.set("/api/vault/setup", () =>
      Response.json({
        ok: true,
        recoveryKey,
        sessionToken: "session-token",
        plaintextRemaining: ["C:/data/backups/dokan-2020-01-01.db"],
      }),
    );
    const host = await mount(statusFor("unconfigured"), () => undefined);
    setValue(host, "vault-passphrase", "correct horse battery");
    setValue(host, "vault-passphrase-confirm", "correct horse battery");
    await submit(host, "vault-setup-submit");
    const warning = host.querySelector('[data-testid="vault-plaintext-warning"]');
    expect(warning?.textContent).toContain("dokan-2020-01-01.db");
  });

  it("rejects a whitespace-only passphrase before any request (normalized floor)", async () => {
    let setupCalls = 0;
    routes.set("/api/vault/setup", () => {
      setupCalls += 1;
      return Response.json({ ok: true, recoveryKey: "x", sessionToken: "y" });
    });
    const host = await mount(statusFor("unconfigured"), () => undefined);
    setValue(host, "vault-passphrase", "        ");
    setValue(host, "vault-passphrase-confirm", "        ");
    await submit(host, "vault-setup-submit");
    expect(setupCalls).toBe(0);
    expect(host.querySelector('[data-testid="vault-error"]')?.textContent).toContain("كلمة");
  });

  it("states the unrecoverable case on the first-run screen before anything is created", async () => {
    const host = await mount(statusFor("unconfigured"), () => undefined);
    expect(host.textContent).toContain("لا يمكن استعادة بيانات المتجر");
  });
});
