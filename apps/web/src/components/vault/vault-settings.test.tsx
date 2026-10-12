import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "@/lib/i18n";
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
