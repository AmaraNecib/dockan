import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import i18n from "@/lib/i18n";
import { VaultSettings } from "./vault-settings";
import { readVaultSessionToken, storeVaultSessionToken } from "@/lib/vault-client";

type KeyRow = { id: string; kind: "recovery"; label?: string; createdAt: string };

let keys: KeyRow[] = [];
let deletedToken = "removed-token";
let changedToken = "changed-token";
let resetToken = "reset-token";
let seenHeaders: Headers | undefined;

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

const mounted: Array<{ root: ReturnType<typeof createRoot>; host: HTMLElement }> = [];

beforeEach(() => {
  keys = [
    { id: "key-1", kind: "recovery", label: "01", createdAt: "2026-01-01T00:00:00Z" },
    { id: "key-2", kind: "recovery", label: "02", createdAt: "2026-01-02T00:00:00Z" },
  ];
  seenHeaders = undefined;
  routes = new Map();
  routes.set("/api/vault/status", () =>
    Response.json({
      mode: "vault",
      state: "unlocked",
      legacyDatabase: false,
      recoveryKeyCount: keys.length,
      lockedForMs: 0,
      unlocked: true,
    }),
  );
  routes.set("/api/vault/recovery-keys", (init) => {
    if (init?.method === "DELETE") return Response.json({ ok: true, sessionToken: deletedToken });
    return Response.json({ keys });
  });
  routes.set(`/api/vault/recovery-keys/key-1`, (init) => {
    if (init?.method === "DELETE") return Response.json({ ok: true, sessionToken: deletedToken });
    return Response.json({ keys });
  });
  routes.set("/api/vault/change-passphrase", (init) => {
    seenHeaders = new Headers(init?.headers);
    return Response.json({ ok: true, sessionToken: changedToken });
  });
  routes.set("/api/vault/reset-passphrase", (init) => {
    seenHeaders = new Headers(init?.headers);
    return Response.json({ ok: true, sessionToken: resetToken });
  });
  globalThis.fetch = mockFetch;
  window.sessionStorage.clear();
});

afterEach(() => {
  for (const entry of mounted) act(() => entry.root.unmount());
  mounted.length = 0;
  globalThis.fetch = originalFetch;
});

async function flush(count = 5): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
}

async function mount(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <VaultSettings />
      </QueryClientProvider>,
    );
  });
  await flush();
  return host;
}

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

async function click(host: HTMLElement, testId: string): Promise<void> {
  const button = host.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  if (button === null) throw new Error(`missing button ${testId}`);
  await act(async () => {
    button.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
}

/** The field inputs the settings section can mount. */
const FIELD_INPUT_TEST_IDS = [
  "vault-current-passphrase",
  "vault-new-passphrase",
  "vault-confirm-passphrase",
  "vault-reset-recovery-key",
  "vault-reset-new-passphrase",
] as const;

/**
 * A failure that names no field must leave EVERY field unassociated with the
 * alert, not just the one that was blamed before: a regression that reassigns
 * the blame to a different input must not slip through. Also pins the alert's
 * `id`, so a dangling `aria-describedby` cannot survive.
 */
function expectNoFieldBlamed(host: HTMLElement): void {
  const alert = host.querySelector("[data-testid='vault-settings-error']");
  expect(alert?.getAttribute("id")).toBe("vault-settings-error");
  for (const testId of FIELD_INPUT_TEST_IDS) {
    const input = host.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`);
    if (input === null) continue;
    expect(input.getAttribute("aria-describedby")).not.toBe("vault-settings-error");
    expect(input.getAttribute("aria-invalid")).not.toBe("true");
  }
}

describe("VaultSettings", () => {
  it("changes the passphrase and adopts the rotated session token", async () => {
    storeVaultSessionToken("stored-token");
    const host = await mount();
    setValue(host, "vault-current-passphrase", "correct horse battery");
    setValue(host, "vault-new-passphrase", "a brand new passphrase");
    setValue(host, "vault-confirm-passphrase", "a brand new passphrase");
    await click(host, "vault-change-submit");
    await flush();
    expect(readVaultSessionToken()).toBe(changedToken);
    expect(host.querySelector('[data-testid="vault-settings-saved"]')).not.toBeNull();
    expect(seenHeaders?.get("x-vault-session")).toBe("stored-token");
  });

  it("deletes a recovery key and adopts the rotated token, but never offers to delete the last one", async () => {
    const host = await mount();
    // two keys: both deletable
    expect(host.querySelector('[data-testid="vault-delete-key-1"]')).not.toBeNull();
    await click(host, "vault-delete-key-1");
    await click(host, "vault-delete-confirm-key-1");
    await flush();
    expect(readVaultSessionToken()).toBe(deletedToken);

    // one key left: no delete control, and the reason is shown
    keys = [keys[1]!];
    const narrowed = await mount();
    await flush();
    expect(narrowed.querySelector('[data-testid^="vault-delete-"]')).toBeNull();
    expect(narrowed.querySelector('[data-testid="vault-last-key-hint"]')).not.toBeNull();
  });

  it("sets a new passphrase from a recovery key without the current one", async () => {
    const host = await mount();
    await click(host, "vault-show-recovery-reset");
    setValue(host, "vault-reset-recovery-key", "ABCD-EFGH-IJKL-MNPQ-RSTU-VWXY-Z234-567A-BC");
    setValue(host, "vault-reset-new-passphrase", "a brand new passphrase");
    await click(host, "vault-reset-submit");
    await flush();
    expect(readVaultSessionToken()).toBe(resetToken);
    // the reset is pre-auth: no vault session header is sent
    expect(seenHeaders?.get("x-vault-session")).toBeNull();
  });

  it("gives every password field its own app-controlled reveal toggle (issue #167)", async () => {
    const host = await mount();
    for (const testId of ["vault-current-passphrase", "vault-new-passphrase", "vault-confirm-passphrase"]) {
      const input = (): HTMLInputElement | null => host.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`);
      const toggle = host.querySelector<HTMLButtonElement>(`[data-testid="${testId}-toggle"]`);
      expect(input()?.type).toBe("password");
      expect(toggle?.type).toBe("button");

      await click(host, `${testId}-toggle`);
      expect(input()?.type).toBe("text");
      await click(host, `${testId}-toggle`);
      expect(input()?.type).toBe("password");
      expect(host.querySelector(`[data-testid="${testId}-toggle"]`)).not.toBeNull();
    }

    // the recovery-reset form's new passphrase is a password field too, so it
    // must not be left without a reveal control by the global native-reveal
    // suppression in index.css
    await click(host, "vault-show-recovery-reset");
    const resetToggle = host.querySelector<HTMLButtonElement>('[data-testid="vault-reset-new-passphrase-toggle"]');
    expect(resetToggle?.type).toBe("button");
    await click(host, "vault-reset-new-passphrase-toggle");
    expect(host.querySelector<HTMLInputElement>('[data-testid="vault-reset-new-passphrase"]')?.type).toBe("text");
  });
});

describe("vault settings takes over native validation (issue #109)", () => {
  it("the change form is noValidate and refuses an empty current passphrase in Arabic", async () => {
    let changeCalls = 0;
    routes.set("/api/vault/change-passphrase", () => {
      changeCalls += 1;
      return Response.json({ ok: true, sessionToken: changedToken });
    });
    const host = await mount();
    expect(host.querySelector<HTMLFormElement>('[data-testid="vault-settings"] form')?.noValidate).toBe(true);

    setValue(host, "vault-new-passphrase", "a brand new passphrase");
    setValue(host, "vault-confirm-passphrase", "a brand new passphrase");
    await click(host, "vault-change-submit");
    await flush();

    expect(changeCalls).toBe(0);
    const current = host.querySelector<HTMLInputElement>('[data-testid="vault-current-passphrase"]');
    expect(current?.getAttribute("aria-invalid")).toBe("true");
    expect(current?.getAttribute("aria-describedby")).toBe("vault-settings-error");
    expect(document.activeElement).toBe(current);
    expect(host.querySelector('[data-testid="vault-settings-error"]')?.textContent).toBe("أدخل كلمة مرور الخزنة.");
  });

  it("associates the change-form error with the blamed field and clears it on edit", async () => {
    const host = await mount();
    setValue(host, "vault-current-passphrase", "correct horse battery");
    setValue(host, "vault-new-passphrase", "a brand new passphrase");
    await click(host, "vault-change-submit");
    await flush();

    const confirm = host.querySelector<HTMLInputElement>('[data-testid="vault-confirm-passphrase"]');
    expect(host.querySelector('[data-testid="vault-settings-error"]')?.textContent).toBe("كلمتا المرور غير متطابقتين.");
    expect(confirm?.getAttribute("aria-invalid")).toBe("true");
    expect(confirm?.getAttribute("aria-describedby")).toBe("vault-settings-error");
    // the blame is exclusive: the other fields must not carry it too
    const current = host.querySelector<HTMLInputElement>('[data-testid="vault-current-passphrase"]');
    expect(current?.getAttribute("aria-describedby")).toBeNull();
    expect(host.querySelector<HTMLInputElement>('[data-testid="vault-new-passphrase"]')?.getAttribute("aria-describedby")).toBeNull();
    expect(document.activeElement).toBe(confirm);

    setValue(host, "vault-confirm-passphrase", "a brand new passphrase");
    expect(host.querySelector('[data-testid="vault-settings-error"]')).toBeNull();
    expect(confirm?.getAttribute("aria-invalid")).toBe("false");
  });

  it("editing the new passphrase clears a confirm-blamed mismatch", async () => {
    const host = await mount();
    setValue(host, "vault-current-passphrase", "correct horse battery");
    setValue(host, "vault-new-passphrase", "a brand new passphrase");
    setValue(host, "vault-confirm-passphrase", "a different passphrase");
    await click(host, "vault-change-submit");
    await flush();
    expect(host.querySelector('[data-testid="vault-settings-error"]')?.textContent).toBe("كلمتا المرور غير متطابقتين.");

    // making the new passphrase match the confirm is a fix too, so the stale
    // mismatch must go with it
    setValue(host, "vault-new-passphrase", "a different passphrase");
    expect(host.querySelector('[data-testid="vault-settings-error"]')).toBeNull();
  });

  it("the change form refuses an empty confirm in Arabic without a request", async () => {
    let changeCalls = 0;
    routes.set("/api/vault/change-passphrase", () => {
      changeCalls += 1;
      return Response.json({ ok: true, sessionToken: changedToken });
    });
    const host = await mount();
    // current and new are valid: with `noValidate` the native `required` on the
    // confirm field is gone, so the app must refuse the blank confirmation
    setValue(host, "vault-current-passphrase", "correct horse battery");
    setValue(host, "vault-new-passphrase", "a brand new passphrase");
    await click(host, "vault-change-submit");
    await flush();

    expect(changeCalls).toBe(0);
    expect(host.querySelector('[data-testid="vault-settings-error"]')?.textContent).toBe("كلمتا المرور غير متطابقتين.");
  });

  it("the reset form is noValidate and refuses an empty recovery key in Arabic", async () => {
    let resetCalls = 0;
    routes.set("/api/vault/reset-passphrase", () => {
      resetCalls += 1;
      return Response.json({ ok: true, sessionToken: resetToken });
    });
    const host = await mount();
    await click(host, "vault-show-recovery-reset");
    expect(host.querySelector<HTMLFormElement>('[data-testid="vault-recovery-reset"]')?.noValidate).toBe(true);

    setValue(host, "vault-reset-new-passphrase", "a brand new passphrase");
    await click(host, "vault-reset-submit");
    await flush();

    expect(resetCalls).toBe(0);
    const key = host.querySelector<HTMLInputElement>('[data-testid="vault-reset-recovery-key"]');
    expect(key?.getAttribute("aria-invalid")).toBe("true");
    expect(key?.getAttribute("aria-describedby")).toBe("vault-settings-error");
    expect(document.activeElement).toBe(key);
    expect(host.querySelector('[data-testid="vault-settings-error"]')?.textContent).toBe("أدخل مفتاح الاسترداد.");
  });

  it("the reset form refuses an empty new passphrase in Arabic", async () => {
    let resetCalls = 0;
    routes.set("/api/vault/reset-passphrase", () => {
      resetCalls += 1;
      return Response.json({ ok: true, sessionToken: resetToken });
    });
    const host = await mount();
    await click(host, "vault-show-recovery-reset");
    setValue(host, "vault-reset-recovery-key", "ABCD-EFGH-IJKL-MNPQ-RSTU-VWXY-Z234-567A-BC");
    await click(host, "vault-reset-submit");
    await flush();

    expect(resetCalls).toBe(0);
    expect(host.querySelector('[data-testid="vault-settings-error"]')?.textContent).toBe(i18n.t("vaultPassphraseTooShort"));
  });

  it("a failed recovery-key action never keeps the empty-passphrase field blamed, and editing it cannot hide the server error", async () => {
    // the recovery-key POST fails with a server error that names no input
    routes.set("/api/vault/recovery-keys", (init) => {
      if (init?.method === "POST") {
        return Response.json({ error: { code: "VAULT_RECOVERY_LIMIT" } }, { status: 400 });
      }
      return Response.json({ keys });
    });
    const host = await mount();

    // an empty current passphrase blames that field
    setValue(host, "vault-new-passphrase", "a brand new passphrase");
    setValue(host, "vault-confirm-passphrase", "a brand new passphrase");
    await click(host, "vault-change-submit");
    await flush();
    const current = host.querySelector<HTMLInputElement>('[data-testid="vault-current-passphrase"]');
    expect(current?.getAttribute("aria-describedby")).toBe("vault-settings-error");

    // a recovery-key failure names no field, so NO field may keep the blame —
    // not just the one that was blamed before
    await click(host, "vault-add-recovery");
    await flush();
    expect(host.querySelector('[data-testid="vault-settings-error"]')?.textContent).toBe(i18n.t("VAULT_RECOVERY_LIMIT"));
    expectNoFieldBlamed(host);

    // editing the password field must not swallow the unrelated server error
    setValue(host, "vault-current-passphrase", "correct horse battery");
    expect(host.querySelector('[data-testid="vault-settings-error"]')?.textContent).toBe(i18n.t("VAULT_RECOVERY_LIMIT"));
  });

  it("a failed recovery-key deletion never keeps the empty-passphrase field blamed either", async () => {
    // the DELETE fails with a server error that names no input
    routes.set("/api/vault/recovery-keys/key-1", (init) => {
      if (init?.method === "DELETE") {
        return Response.json({ error: { code: "VAULT_UNEXPECTED" } }, { status: 500 });
      }
      return Response.json({ keys });
    });
    const host = await mount();

    setValue(host, "vault-new-passphrase", "a brand new passphrase");
    setValue(host, "vault-confirm-passphrase", "a brand new passphrase");
    await click(host, "vault-change-submit");
    await flush();
    const current = host.querySelector<HTMLInputElement>('[data-testid="vault-current-passphrase"]');
    expect(current?.getAttribute("aria-describedby")).toBe("vault-settings-error");

    await click(host, "vault-delete-key-1");
    await click(host, "vault-delete-confirm-key-1");
    await flush();
    expect(host.querySelector('[data-testid="vault-settings-error"]')?.textContent).toBe(i18n.t("VAULT_UNEXPECTED"));
    expectNoFieldBlamed(host);

    // editing the password field must not swallow the deletion failure
    setValue(host, "vault-current-passphrase", "correct horse battery");
    expect(host.querySelector('[data-testid="vault-settings-error"]')?.textContent).toBe(i18n.t("VAULT_UNEXPECTED"));
  });
});
