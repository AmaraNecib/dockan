import { afterEach, expect, it } from "bun:test";
import { migrateLegacySidebarCollapsed, SIDEBAR_COLLAPSED_KEY } from "./sidebar-state";
import { subscribeSessionRefresh } from "../../lib/session-refresh";
import { createPreferenceClient } from "../../lib/preferences";
import { createCredentialLease } from "../../lib/credential-lease";
import { createDokanRpcClient } from "../../lib/rpc-link";

// SAFETY: only the optional happy-dom test registry is read.
(window as { happyDOM?: { setURL: (url: string) => void } }).happyDOM?.setURL("http://localhost:5173/");
const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; window.localStorage.clear(); });

it.each([undefined, "false"])("keeps the legacy fallback and submits zero writes after a held sidebar read retires, server value %s", async (serverValue) => {
  window.localStorage.setItem("dokan.sidebar.collapsed", "true");
  let release!: (response: Response) => void;
  let writes = 0;
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    const path = new URL(input instanceof Request ? input.url : String(input), window.location.origin).pathname;
    if (path.endsWith("/preferencesGet")) return new Promise<Response>((resolve) => { release = resolve; });
    writes += 1;
    return Response.json({ json: { key: SIDEBAR_COLLAPSED_KEY, value: "true" } });
  }, { preconnect: originalFetch.preconnect });
  const stop = subscribeSessionRefresh(() => {});
  try {
    const lease = createCredentialLease();
    const preferences = createPreferenceClient(createDokanRpcClient(lease), lease);
    const pending = migrateLegacySidebarCollapsed(preferences);
    for (let i = 0; i < 50 && !release; i += 1) await new Promise((resolve) => setTimeout(resolve, 1));
    expect(release).toBeDefined();
    window.dispatchEvent(new StorageEvent("storage", { key: "better-auth.message", newValue: '{"event":"session","data":{"trigger":"signout"}}' }));
    release(Response.json({ json: { values: serverValue === undefined ? {} : { [SIDEBAR_COLLAPSED_KEY]: serverValue } } }));
    expect(await pending).toBeNull();
    expect(writes).toBe(0);
    expect(window.localStorage.getItem("dokan.sidebar.collapsed")).toBe("true");
  } finally { stop(); }
});
