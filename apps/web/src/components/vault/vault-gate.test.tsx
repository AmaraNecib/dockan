import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import i18n from "@/lib/i18n";
import { VaultGate } from "./vault-gate";
import type { BrokerInvokeArgs, BrokerReply } from "@/lib/vault-broker";
import type { VaultStatus } from "@/lib/vault-client";

/** The global the Tauri webview injects; tests stand in with this shape. */
type FakeTauriInternals = { invoke: (command: string, args?: BrokerInvokeArgs) => Promise<BrokerReply> };

const statusFor = (state: VaultStatus["state"], extra: Partial<VaultStatus> = {}): VaultStatus => ({
  mode: "vault",
  state,
  legacyDatabase: false,
  recoveryKeyCount: state === "unconfigured" ? 0 : 1,
  lockedForMs: 0,
  unlocked: state === "unlocked",
  broker: false,
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
  // SAFETY: the broker tests installed this exact optional global above
  delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
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

/** Every field input the gate can mount across its screens. */
const GATE_FIELD_TEST_IDS = ["vault-passphrase", "vault-passphrase-confirm", "vault-recovery-input"] as const;

/**
 * A failure that names no field must leave EVERY mounted field unassociated
 * with the alert, not just the one that was blamed before: a regression that
 * reassigns the blame to a different input must not slip through. Also pins the
 * alert's `id`, so a dangling `aria-describedby` cannot survive.
 */
function expectNoFieldBlamed(host: HTMLElement): void {
  const alert = host.querySelector("[data-testid='vault-error']");
  expect(alert?.getAttribute("id")).toBe("vault-error");
  for (const testId of GATE_FIELD_TEST_IDS) {
    const input = host.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`);
    if (input === null) continue;
    expect(input.getAttribute("aria-describedby")).not.toBe("vault-error");
    expect(input.getAttribute("aria-invalid")).not.toBe("true");
  }
}

describe("vault gate takes over native validation (issue #109)", () => {
  it("setup: noValidate, and an empty passphrase shows Arabic without a request", async () => {
    let setupCalls = 0;
    routes.set("/api/vault/setup", () => {
      setupCalls += 1;
      return Response.json({ ok: true, recoveryKey: "x", sessionToken: "y" });
    });
    const host = await mount(statusFor("unconfigured"), () => undefined);
    expect(host.querySelector("form")?.noValidate).toBe(true);

    await submit(host, "vault-setup-submit");

    expect(setupCalls).toBe(0);
    expect(host.querySelector('[data-testid="vault-error"]')?.textContent).toBe(i18n.t("vaultPassphraseTooShort"));
    const passphrase = host.querySelector<HTMLInputElement>('[data-testid="vault-passphrase"]');
    expect(passphrase?.getAttribute("aria-invalid")).toBe("true");
    expect(passphrase?.getAttribute("aria-describedby")).toBe("vault-error");
    expect(document.activeElement).toBe(passphrase);
  });

  it("unlock: noValidate, and an empty passphrase shows Arabic without a request", async () => {
    let unlockCalls = 0;
    routes.set("/api/vault/unlock", () => {
      unlockCalls += 1;
      return Response.json({ ok: true, sessionToken: "s" });
    });
    const host = await mount(statusFor("locked"), () => undefined);
    expect(host.querySelector("form")?.noValidate).toBe(true);

    await submit(host, "vault-unlock-submit");

    expect(unlockCalls).toBe(0);
    expect(host.querySelector('[data-testid="vault-error"]')?.textContent).toBe("أدخل كلمة مرور الخزنة.");
    const passphrase = host.querySelector<HTMLInputElement>('[data-testid="vault-passphrase"]');
    expect(passphrase?.getAttribute("aria-invalid")).toBe("true");
    expect(passphrase?.getAttribute("aria-describedby")).toBe("vault-error");
    expect(document.activeElement).toBe(passphrase);
  });

  it("recovery unlock: noValidate, and an empty key shows Arabic without a request", async () => {
    let recoveryCalls = 0;
    routes.set("/api/vault/unlock-recovery", () => {
      recoveryCalls += 1;
      return Response.json({ ok: true, sessionToken: "s" });
    });
    const host = await mount(statusFor("locked"), () => undefined);
    await submit(host, "vault-use-recovery");
    expect(host.querySelector("form")?.noValidate).toBe(true);

    await submit(host, "vault-recovery-submit");

    expect(recoveryCalls).toBe(0);
    expect(host.querySelector('[data-testid="vault-error"]')?.textContent).toBe("أدخل مفتاح الاسترداد.");
    const input = host.querySelector<HTMLInputElement>('[data-testid="vault-recovery-input"]');
    expect(input?.getAttribute("aria-invalid")).toBe("true");
    expect(input?.getAttribute("aria-describedby")).toBe("vault-error");
    expect(document.activeElement).toBe(input);
  });

  it("editing a blamed field clears the Arabic error and aria-invalid", async () => {
    const host = await mount(statusFor("unconfigured"), () => undefined);
    await submit(host, "vault-setup-submit");

    const passphrase = host.querySelector<HTMLInputElement>('[data-testid="vault-passphrase"]');
    expect(passphrase?.getAttribute("aria-invalid")).toBe("true");
    expect(host.querySelector('[data-testid="vault-error"]')).not.toBeNull();

    setValue(host, "vault-passphrase", "long enough passphrase");

    expect(host.querySelector('[data-testid="vault-error"]')).toBeNull();
    expect(passphrase?.getAttribute("aria-invalid")).toBe("false");
    expect(passphrase?.getAttribute("aria-describedby")).toBeNull();
  });

  it("editing the passphrase clears a confirm-blamed mismatch", async () => {
    const host = await mount(statusFor("unconfigured"), () => undefined);
    setValue(host, "vault-passphrase", "long enough passphrase");
    setValue(host, "vault-passphrase-confirm", "a different passphrase");
    await submit(host, "vault-setup-submit");
    expect(host.querySelector('[data-testid="vault-error"]')?.textContent).toBe(i18n.t("vaultPassphraseMismatch"));

    // making the passphrase match the confirm is a fix too, so the confirm's
    // stale refusal must go with it
    setValue(host, "vault-passphrase", "a different passphrase");
    expect(host.querySelector('[data-testid="vault-error"]')).toBeNull();
  });
});

describe("vault gate keeps one failure value (issue #217)", () => {
  it("a failing recovery action never keeps the empty-passphrase blame, and editing cannot hide the server error", async () => {
    // the recovery action fails with a server error that names no input
    routes.set("/api/vault/unlock-recovery", () =>
      Response.json({ error: { code: "VAULT_RECOVERY_LIMIT" } }, { status: 400 }),
    );
    const host = await mount(statusFor("locked"), () => {
      throw new Error("must not unlock");
    });

    // an empty passphrase blames that field on the unlock screen
    await submit(host, "vault-unlock-submit");
    const passphrase = host.querySelector<HTMLInputElement>('[data-testid="vault-passphrase"]');
    expect(passphrase?.getAttribute("aria-describedby")).toBe("vault-error");

    // the recovery action replaces it with a field-less server failure; the
    // screen change must drop the passphrase blame, or it survives unmounted
    await submit(host, "vault-use-recovery");
    setValue(host, "vault-recovery-input", "ABCD-EFGH-IJKL-MNPQ-RSTU-VWXY-Z234-567A-BC");
    await submit(host, "vault-recovery-submit");
    expect(host.querySelector('[data-testid="vault-error"]')?.textContent).toBe(i18n.t("VAULT_RECOVERY_LIMIT"));
    expectNoFieldBlamed(host);

    // editing the recovery field must not swallow the unrelated server error
    setValue(host, "vault-recovery-input", "ABCD-EFGH-IJKL-MNPQ-RSTU-VWXY-Z234-567A-BD");
    expect(host.querySelector('[data-testid="vault-error"]')?.textContent).toBe(i18n.t("VAULT_RECOVERY_LIMIT"));

    // ... and the abandoned passphrase blame must not resurrect on the way back
    const back = Array.from(host.querySelectorAll("button")).find((button) => button.textContent?.trim() === i18n.t("vaultBackToPassphrase"));
    if (back === undefined) throw new Error("missing back-to-passphrase button");
    await act(async () => {
      back.click();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    expect(host.querySelector('[data-testid="vault-error"]')).toBeNull();
    const returned = host.querySelector<HTMLInputElement>('[data-testid="vault-passphrase"]');
    expect(returned?.getAttribute("aria-invalid")).toBe("false");
    expect(returned?.getAttribute("aria-describedby")).toBeNull();
  });

  it("a field-less failure clears the field blame it replaced", async () => {
    routes.set("/api/vault/unlock-recovery", () =>
      Response.json({ error: { code: "VAULT_UNEXPECTED" } }, { status: 500 }),
    );
    const host = await mount(statusFor("locked"), () => {
      throw new Error("must not unlock");
    });
    await submit(host, "vault-use-recovery");

    // an empty recovery key blames the recovery field (a mounted field)
    await submit(host, "vault-recovery-submit");
    const recovery = host.querySelector<HTMLInputElement>('[data-testid="vault-recovery-input"]');
    expect(recovery?.getAttribute("aria-describedby")).toBe("vault-error");
    expect(recovery?.getAttribute("aria-invalid")).toBe("true");

    // the next failure names no field, so the old blame must go with the copy
    setValue(host, "vault-recovery-input", "ABCD-EFGH-IJKL-MNPQ-RSTU-VWXY-Z234-567A-BC");
    await submit(host, "vault-recovery-submit");
    expect(host.querySelector('[data-testid="vault-error"]')?.textContent).toBe(i18n.t("VAULT_UNEXPECTED"));
    expectNoFieldBlamed(host);

    // ... and editing the field cannot swallow the server error
    setValue(host, "vault-recovery-input", "ABCD-EFGH-IJKL-MNPQ-RSTU-VWXY-Z234-567A-BD");
    expect(host.querySelector('[data-testid="vault-error"]')?.textContent).toBe(i18n.t("VAULT_UNEXPECTED"));
  });
});

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

  it("takes the passphrase over the desktop broker when the status says so (issue #141)", async () => {
    const calls: Array<{ command: string; args?: BrokerInvokeArgs }> = [];
    // SAFETY: this is the global the Tauri webview injects; the test stands in for it
    (window as { __TAURI_INTERNALS__?: FakeTauriInternals }).__TAURI_INTERNALS__ = {
      invoke: async (command, args) => {
        calls.push({ command, args });
        if (command === "vault_unlock") return { ok: true, sessionToken: "broker-session", sessionGeneration: 1 };
        return { ok: true };
      },
    };
    let unlocked = 0;
    const host = await mount(
      statusFor("locked", { broker: true }),
      () => {
        unlocked += 1;
      },
    );
    setValue(host, "vault-passphrase", "correct horse battery");
    await submit(host, "vault-unlock-submit");

    expect(calls[0]).toEqual({ command: "vault_unlock", args: { passphrase: "correct horse battery" } });
    expect(window.sessionStorage.getItem("dokan.vault.session")).toBe("broker-session");
    expect(unlocked).toBe(1);
  });

  it("acknowledges the recovery key over the broker after first-run setup (issue #141)", async () => {
    const commands: string[] = [];
    // SAFETY: this is the global the Tauri webview injects; the test stands in for it
    (window as { __TAURI_INTERNALS__?: FakeTauriInternals }).__TAURI_INTERNALS__ = {
      invoke: async (command) => {
        commands.push(command);
        if (command === "vault_setup") return { ok: true, sessionToken: "setup-session", recoveryKey: "ABCD-EFGH", plaintextRemaining: [] };
        return { ok: true };
      },
    };
    let unlocked = 0;
    const host = await mount(
      statusFor("unconfigured", { broker: true }),
      () => {
        unlocked += 1;
      },
    );
    setValue(host, "vault-passphrase", "correct horse battery");
    setValue(host, "vault-passphrase-confirm", "correct horse battery");
    await submit(host, "vault-setup-submit");
    expect(host.querySelector('[data-testid="vault-recovery-key"]')?.textContent).toBe("ABCD-EFGH");

    const checkbox = host.querySelector<HTMLInputElement>('[data-testid="vault-recovery-confirm"]');
    if (checkbox === null) throw new Error("missing recovery confirm");
    await act(async () => {
      checkbox.click();
    });
    await submit(host, "vault-recovery-continue");
    expect(commands).toEqual(["vault_setup", "vault_setup_warning", "vault_setup_saved"]);
    expect(unlocked).toBe(1);
  });

  it("shows the recovery key while the plaintext sweep is still pending (round-3 finding 1)", async () => {
    // SAFETY: the global the Tauri webview injects; the test stands in for it
    (window as { __TAURI_INTERNALS__?: FakeTauriInternals }).__TAURI_INTERNALS__ = {
      invoke: async (command) => {
        if (command === "vault_setup") return { ok: true, sessionToken: "setup-session", recoveryKey: "ABCD-EFGH" };
        // the sweep never reports (a huge legacy backup set)
        if (command === "vault_setup_warning") return await new Promise<BrokerReply>(() => {});
        return { ok: true };
      },
    };
    const host = await mount(statusFor("unconfigured", { broker: true }), () => {});
    setValue(host, "vault-passphrase", "correct horse battery");
    setValue(host, "vault-passphrase-confirm", "correct horse battery");
    await submit(host, "vault-setup-submit");

    // the one-time key is safely on screen even though the sweep has not reported
    expect(host.querySelector('[data-testid="vault-recovery-key"]')?.textContent).toBe("ABCD-EFGH");
    expect(host.querySelector('[data-testid="vault-plaintext-checking"]')).not.toBeNull();
    const checkbox = host.querySelector<HTMLInputElement>('[data-testid="vault-recovery-confirm"]');
    if (checkbox === null) throw new Error("missing recovery confirm");
    await act(async () => {
      checkbox.click();
    });
    // the owner cannot leave before the warning arrives (or fails)
    expect(host.querySelector<HTMLButtonElement>('[data-testid="vault-recovery-continue"]')?.disabled).toBe(true);
  });

  it("shows the plaintext warning when the follow-up arrives (round-3 finding 1)", async () => {
    let resolveWarning: ((reply: BrokerReply) => void) | undefined;
    // SAFETY: the global the Tauri webview injects; the test stands in for it
    (window as { __TAURI_INTERNALS__?: FakeTauriInternals }).__TAURI_INTERNALS__ = {
      invoke: async (command) => {
        if (command === "vault_setup") return { ok: true, sessionToken: "setup-session", recoveryKey: "ABCD-EFGH" };
        if (command === "vault_setup_warning") {
          return await new Promise<BrokerReply>((resolve) => {
            resolveWarning = resolve;
          });
        }
        return { ok: true };
      },
    };
    let unlocked = 0;
    const host = await mount(
      statusFor("unconfigured", { broker: true }),
      () => {
        unlocked += 1;
      },
    );
    setValue(host, "vault-passphrase", "correct horse battery");
    setValue(host, "vault-passphrase-confirm", "correct horse battery");
    await submit(host, "vault-setup-submit");
    const checkbox = host.querySelector<HTMLInputElement>('[data-testid="vault-recovery-confirm"]');
    if (checkbox === null) throw new Error("missing recovery confirm");
    await act(async () => {
      checkbox.click();
    });

    await act(async () => {
      resolveWarning?.({ ok: true, warning: "plaintext", plaintextStatus: "remaining", plaintextRemaining: ["C:/data/dokan.db"] });
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(host.querySelector('[data-testid="vault-plaintext-warning"]')?.textContent).toContain("C:/data/dokan.db");
    expect(host.querySelector('[data-testid="vault-plaintext-checking"]')).toBeNull();
    await submit(host, "vault-recovery-continue");
    expect(unlocked).toBe(1);
  });

  it("warns the owner when the sweep outcome is unknown instead of showing the clean story (round-4 finding)", async () => {
    // SAFETY: the global the Tauri webview injects; the test stands in for it
    (window as { __TAURI_INTERNALS__?: FakeTauriInternals }).__TAURI_INTERNALS__ = {
      invoke: async (command) => {
        if (command === "vault_setup") return { ok: true, sessionToken: "setup-session", recoveryKey: "ABCD-EFGH" };
        if (command === "vault_setup_warning") return { ok: true, warning: "plaintext", plaintextStatus: "unknown", plaintextRemaining: [] };
        return { ok: true };
      },
    };
    let unlocked = 0;
    const host = await mount(
      statusFor("unconfigured", { broker: true }),
      () => {
        unlocked += 1;
      },
    );
    setValue(host, "vault-passphrase", "correct horse battery");
    setValue(host, "vault-passphrase-confirm", "correct horse battery");
    await submit(host, "vault-setup-submit");
    // the key is visible and the manual-verification warning is shown
    expect(host.querySelector('[data-testid="vault-recovery-key"]')?.textContent).toBe("ABCD-EFGH");
    expect(host.querySelector('[data-testid="vault-plaintext-unknown"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="vault-plaintext-warning"]')).toBeNull();

    const checkbox = host.querySelector<HTMLInputElement>('[data-testid="vault-recovery-confirm"]');
    if (checkbox === null) throw new Error("missing recovery confirm");
    await act(async () => {
      checkbox.click();
    });
    await submit(host, "vault-recovery-continue");
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

  it("renders both setup passphrase fields with an identical app-controlled reveal (issue #167)", async () => {
    const host = await mount(statusFor("unconfigured"), () => undefined);
    const first = host.querySelector<HTMLInputElement>('[data-testid="vault-passphrase"]');
    const confirm = host.querySelector<HTMLInputElement>('[data-testid="vault-passphrase-confirm"]');
    const firstToggle = host.querySelector<HTMLButtonElement>('[data-testid="vault-passphrase-toggle"]');
    const confirmToggle = host.querySelector<HTMLButtonElement>('[data-testid="vault-passphrase-confirm-toggle"]');

    expect(first).not.toBeNull();
    expect(confirm).not.toBeNull();
    expect(firstToggle).not.toBeNull();
    expect(confirmToggle).not.toBeNull();

    // same component, no per-field class: the two fields cannot mirror in RTL.
    // happy-dom has no layout, so class parity is the unit proxy here and the
    // Playwright spec measures the actual box geometry.
    expect(first?.className).toBe(confirm?.className);
    expect(firstToggle?.className).toBe(confirmToggle?.className);
    // pin the reserved inline-end gutter, so dropping the class cannot pass as
    // "identical" when both fields lost it
    expect(first?.className).toContain("pe-10");
    expect(firstToggle?.type).toBe("button");
    expect(confirmToggle?.type).toBe("button");
    expect(first?.type).toBe("password");
    expect(confirm?.type).toBe("password");

    // each field owns its own reveal state: revealing one must not reveal the
    // other (a shared state would defeat the confirm check)
    const firstToggleButton = firstToggle;
    if (firstToggleButton === null) throw new Error("missing first toggle");
    act(() => firstToggleButton.click());
    expect(host.querySelector<HTMLInputElement>('[data-testid="vault-passphrase"]')?.type).toBe("text");
    expect(host.querySelector<HTMLInputElement>('[data-testid="vault-passphrase-confirm"]')?.type).toBe("password");
    expect(host.querySelector('[data-testid="vault-passphrase-confirm-toggle"]')?.getAttribute("aria-pressed")).toBe("false");
  });

  it("keeps the setup eye after a double toggle and still submits (issue #167)", async () => {
    routes.set("/api/vault/setup", () => Response.json({ ok: true, recoveryKey: "ABCD-EFGH", sessionToken: "s" }));
    const host = await mount(statusFor("unconfigured"), () => undefined);
    const toggle = host.querySelector<HTMLButtonElement>('[data-testid="vault-passphrase-toggle"]');
    if (toggle === null) throw new Error("missing passphrase toggle");

    act(() => toggle.click());
    expect(host.querySelector<HTMLInputElement>('[data-testid="vault-passphrase"]')?.type).toBe("text");
    act(() => toggle.click());
    expect(host.querySelector<HTMLInputElement>('[data-testid="vault-passphrase"]')?.type).toBe("password");
    expect(host.querySelector('[data-testid="vault-passphrase-toggle"]')).not.toBeNull();

    setValue(host, "vault-passphrase", "correct horse battery");
    setValue(host, "vault-passphrase-confirm", "correct horse battery");
    await submit(host, "vault-setup-submit");
    expect(host.querySelector('[data-testid="vault-recovery-key"]')).not.toBeNull();
  });
});
