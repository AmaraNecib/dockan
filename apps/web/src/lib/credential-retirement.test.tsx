import { afterEach, expect, it, mock, spyOn } from "bun:test";
import { act, StrictMode, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import type { Invoice } from "@dokan/contracts";
import { z } from "zod";

import "./i18n";
import { clearAuthLost, markAuthLost } from "./auth-refusal";
import { RpcScopeProvider, useRpc, type RpcBinding } from "./rpc-context";
import { orpc, rpcClient } from "./rpc";
import { createCredentialLease } from "./credential-lease";
import { sessionRefreshGeneration } from "./session-refresh";
import { replaceLocalStorage } from "../tests/local-storage-control";
import { usePreference, parseBooleanPreference, serializeBooleanPreference } from "./preferences";

// SAFETY: React's documented act environment flag is the only property written.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// SAFETY: only the optional happy-dom test registry is read.
(window as { happyDOM?: { setURL: (url: string) => void } }).happyDOM?.setURL("http://localhost:5173/");
mock.module("@/lib/auth-client", () => ({
  useSession: () => ({ data: { user: { id: "owner" } }, isPending: false }),
  authClient: { getSession: async () => ({ data: { user: { id: "owner" } }, error: null }) },
}));
const { RequireSession } = await import("../App");
const { CustomerSettlePanel } = await import("../components/parties/customer-settle-panel");

function assertRpcScopeContract() {
  const lease = createCredentialLease();
  expect(lease).toBeDefined();
  expect(lease.isLive).toBeInstanceOf(Function);
  expect(lease.isLive()).toBe(true);
  const binding: RpcBinding = { rpcClient, orpc, lease };
  let observed: RpcBinding | undefined;
  function BindingProbe() {
    observed = useRpc();
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    act(() => root.render(<RpcScopeProvider binding={binding}><BindingProbe /></RpcScopeProvider>));
    expect(observed).toBe(binding);
    expect(observed?.lease?.isLive()).toBe(true);
  } finally {
    act(() => root.unmount());
  }
}
it("provides the active RPC binding and live credential lease through its scope", assertRpcScopeContract);

const originalFetch = globalThis.fetch;
const roots: ReturnType<typeof createRoot>[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
  globalThis.fetch = originalFetch;
  window.localStorage.clear();
  window.sessionStorage.clear();
  clearAuthLost();
});
type RpcFixture = { values: Record<string, string> } | { needsSetup: boolean; setupBlocked: boolean } | { key: string; value: string } | Record<string, never>;
function envelope(value: RpcFixture) { return Response.json({ json: value }); }
function requiredElement<T extends HTMLElement = HTMLElement>(host: HTMLElement, selector: string): T {
  const element = host.querySelector<T>(selector);
  if (element === null) throw new Error(`Missing test element ${selector}`);
  return element;
}
function advisory() {
  window.dispatchEvent(new StorageEvent("storage", { key: "better-auth.message", newValue: '{"event":"session","data":{"trigger":"signout"}}' }));
}
async function flush() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); }
async function until(check: () => boolean) {
  for (let i = 0; i < 60 && !check(); i += 1) await flush();
  expect(check()).toBe(true);
}
async function mount(children: ReactNode, strict = false) {
  assertRpcScopeContract();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  roots.push(root);
  const tree = <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}><RequireSession>{children}</RequireSession></QueryClientProvider>;
  await act(async () => { root.render(strict ? <StrictMode>{tree}</StrictMode> : tree); });
  return host;
}
function setInput(host: HTMLElement, testId: string, value: string) {
  const input = requiredElement<HTMLInputElement>(host, `[data-testid="${testId}"]`);
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter === undefined) throw new Error("Missing native input setter");
  act(() => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}

it("preserves the exact unchecked setup key and cleanup warning across a live advisory without provisioning before acknowledgment", async () => {
  const recoveryKey = "ABCD-EFGH-IJKL-MNPQ-RSTU-VWXY-Z234-567A-BC";
  let configured = false;
  let credentialLive = true;
  let statusHold: Promise<Response> | null = null;
  let ownerChecks = 0;
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    const path = new URL(input instanceof Request ? input.url : String(input), window.location.origin).pathname;
    if (path === "/api/vault/status") {
      if (statusHold !== null) { const pending = statusHold; statusHold = null; return pending; }
      return Response.json({ mode: "vault", state: configured ? "unlocked" : "unconfigured", legacyDatabase: true, recoveryKeyCount: configured ? 1 : 0, lockedForMs: 0, unlocked: configured, session: configured && credentialLive, broker: false });
    }
    if (path === "/api/vault/unlock") { credentialLive = true; return Response.json({ ok: true, sessionGeneration: 2 }); }
    if (path === "/api/vault/setup") { configured = true; return Response.json({ ok: true, recoveryKey, plaintextRemaining: ["D:/owned/legacy.db"] }); }
    if (path.endsWith("/needsSetup")) { ownerChecks += 1; return envelope({ needsSetup: false, setupBlocked: false }); }
    if (path.endsWith("/preferencesGet")) return envelope({ values: {} });
    return Response.json({ ok: true });
  }, { preconnect: originalFetch.preconnect });
  const host = await mount(<div data-testid="private-app">Private</div>);
  await until(() => host.querySelector('[data-testid="vault-setup-submit"]') !== null);
  setInput(host, "vault-passphrase", "a strong setup passphrase");
  setInput(host, "vault-passphrase-confirm", "a strong setup passphrase");
  act(() => requiredElement<HTMLButtonElement>(host, '[data-testid="vault-setup-submit"]').click());
  await until(() => host.querySelector('[data-testid="vault-recovery-key"]') !== null);
  expect(requiredElement(host, '[data-testid="vault-recovery-key"]').textContent).toBe(recoveryKey);
  expect(requiredElement(host, '[data-testid="vault-plaintext-warning"]').textContent).toContain("D:/owned/legacy.db");
  expect(ownerChecks).toBe(0);
  await act(async () => { advisory(); });
  await flush();
  expect(host.querySelector('[data-testid="vault-recovery-key"]')?.textContent).toBe(recoveryKey);
  expect(host.querySelector('[data-testid="vault-plaintext-warning"]')?.textContent).toContain("D:/owned/legacy.db");
  expect(host.querySelector<HTMLInputElement>('[data-testid="vault-recovery-confirm"]')?.checked).toBe(false);
  expect(host.querySelector<HTMLButtonElement>('[data-testid="vault-recovery-continue"]')?.disabled).toBe(true);
  expect(ownerChecks).toBe(0);
  expect(host.querySelector('[data-testid="private-app"]')).toBeNull();
  let releaseStatus!: (response: Response) => void;
  statusHold = new Promise<Response>((resolve) => { releaseStatus = resolve; });
  credentialLive = false;
  await act(async () => { advisory(); });
  expect(host.querySelector('[data-testid="vault-recovery-key"]')).toBeNull();
  await act(async () => { releaseStatus(Response.json({ mode: "vault", state: "unlocked", legacyDatabase: true, recoveryKeyCount: 1, lockedForMs: 0, unlocked: true, session: false, broker: false })); });
  await until(() => host.querySelector('[data-testid="vault-unlock-submit"]') !== null);
  expect(host.querySelector('[data-testid="vault-recovery-key"]')).toBeNull();
  expect(ownerChecks).toBe(0);
  setInput(host, "vault-passphrase", "a strong setup passphrase");
  act(() => requiredElement<HTMLButtonElement>(host, '[data-testid="vault-unlock-submit"]').click());
  await until(() => host.querySelector('[data-testid="vault-recovery-key"]') !== null);
  expect(requiredElement(host, '[data-testid="vault-recovery-key"]').textContent).toBe(recoveryKey);
  expect(requiredElement(host, '[data-testid="vault-plaintext-warning"]').textContent).toContain("D:/owned/legacy.db");
  expect(ownerChecks).toBe(0);
  act(() => requiredElement<HTMLInputElement>(host, '[data-testid="vault-recovery-confirm"]').click());
  act(() => requiredElement<HTMLButtonElement>(host, '[data-testid="vault-recovery-continue"]').click());
  await until(() => host.querySelector('[data-testid="private-app"]') !== null);
  expect(ownerChecks).toBeGreaterThan(0);
});

it.each([false, true])("holds owner admission while the committed setup body is pending across advisory replacement, revoked %s", async (revoked) => {
  const recoveryKey = "LATE-EXACT-SETUP-RECOVERY-KEY";
  let configured = false;
  let credentialLive = true;
  let bodyRequested = false;
  let releaseBody!: (body: string) => void;
  const body = new Promise<string>((resolve) => { releaseBody = resolve; });
  let ownerChecks = 0;
  let statusChecks = 0;
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    const path = new URL(input instanceof Request ? input.url : String(input), window.location.origin).pathname;
    if (path === "/api/vault/status") {
      statusChecks += 1;
      return Response.json({ mode: "vault", state: configured ? "unlocked" : "unconfigured", legacyDatabase: true, recoveryKeyCount: configured ? 1 : 0, lockedForMs: 0, unlocked: configured, session: configured && credentialLive, broker: false });
    }
    if (path === "/api/vault/unlock") { credentialLive = true; return Response.json({ ok: true, sessionGeneration: 2 }); }
    if (path === "/api/vault/setup") {
      // Headers install the shared cookie before request() consumes the body.
      configured = true;
      const response = new Response(null, { headers: { "set-cookie": "vault=committed; HttpOnly" } });
      response.text = () => { bodyRequested = true; return body; };
      return response;
    }
    if (path.endsWith("/needsSetup")) { ownerChecks += 1; return envelope({ needsSetup: false, setupBlocked: false }); }
    if (path.endsWith("/preferencesGet")) return envelope({ values: {} });
    return Response.json({ ok: true });
  }, { preconnect: originalFetch.preconnect });
  const host = await mount(<div data-testid="private-app">Private</div>);
  await until(() => host.querySelector('[data-testid="vault-setup-submit"]') !== null);
  setInput(host, "vault-passphrase", "a strong setup passphrase");
  setInput(host, "vault-passphrase-confirm", "a strong setup passphrase");
  act(() => requiredElement<HTMLButtonElement>(host, '[data-testid="vault-setup-submit"]').click());
  await until(() => bodyRequested);
  const before = statusChecks;
  await act(async () => { advisory(); });
  await until(() => statusChecks > before);
  await flush();
  expect(ownerChecks).toBe(0);
  expect(host.querySelector('[data-testid="private-app"]')).toBeNull();
  expect(host.querySelector('[data-testid="vault-recovery-key"]')).toBeNull();
  if (revoked) {
    credentialLive = false;
    await act(async () => { advisory(); });
    await flush();
  }
  await act(async () => { releaseBody(JSON.stringify({ ok: true, recoveryKey, plaintextRemaining: ["D:/late/legacy.db"] })); });
  if (revoked) {
    await until(() => host.querySelector('[data-testid="vault-unlock-submit"]') !== null);
    expect(host.querySelector('[data-testid="vault-recovery-key"]')).toBeNull();
    expect(ownerChecks).toBe(0);
    setInput(host, "vault-passphrase", "a strong setup passphrase");
    act(() => requiredElement<HTMLButtonElement>(host, '[data-testid="vault-unlock-submit"]').click());
  }
  await until(() => host.querySelector('[data-testid="vault-recovery-key"]') !== null);
  expect(requiredElement(host, '[data-testid="vault-recovery-key"]').textContent).toBe(recoveryKey);
  expect(requiredElement(host, '[data-testid="vault-plaintext-warning"]').textContent).toContain("D:/late/legacy.db");
  expect(ownerChecks).toBe(0);
  expect(requiredElement<HTMLButtonElement>(host, '[data-testid="vault-recovery-continue"]').disabled).toBe(true);
  act(() => requiredElement<HTMLInputElement>(host, '[data-testid="vault-recovery-confirm"]').click());
  act(() => requiredElement<HTMLButtonElement>(host, '[data-testid="vault-recovery-continue"]').click());
  await until(() => host.querySelector('[data-testid="private-app"]') !== null);
  expect(ownerChecks).toBeGreaterThan(0);
});

it("rechecks the current credential when setup commits after its originating gate unmounts", async () => {
  let configured = false;
  let release!: () => void;
  let dispatched = false;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  let statusChecks = 0;
  let ownerChecks = 0;
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    const path = new URL(input instanceof Request ? input.url : String(input), window.location.origin).pathname;
    if (path === "/api/vault/status") {
      statusChecks += 1;
      return Response.json({ mode: "vault", state: configured ? "unlocked" : "unconfigured", legacyDatabase: false, recoveryKeyCount: configured ? 1 : 0, lockedForMs: 0, unlocked: configured, session: configured, broker: false });
    }
    if (path === "/api/vault/setup") {
      dispatched = true;
      await hold;
      configured = true;
      return Response.json({ ok: true, recoveryKey: "AFTER-REMOUNT-KEY", plaintextStatus: "clean" });
    }
    if (path.endsWith("/needsSetup")) { ownerChecks += 1; return envelope({ needsSetup: false, setupBlocked: false }); }
    return Response.json({ ok: true });
  }, { preconnect: originalFetch.preconnect });
  const host = await mount(<div data-testid="private-app">Private</div>);
  await until(() => host.querySelector('[data-testid="vault-setup-submit"]') !== null);
  setInput(host, "vault-passphrase", "a strong setup passphrase");
  setInput(host, "vault-passphrase-confirm", "a strong setup passphrase");
  act(() => requiredElement<HTMLButtonElement>(host, '[data-testid="vault-setup-submit"]').click());
  await until(() => dispatched);
  const before = statusChecks;
  await act(async () => { advisory(); });
  await until(() => statusChecks > before);
  await flush();
  await act(async () => { release(); });
  await until(() => host.querySelector('[data-testid="vault-recovery-key"]') !== null);
  expect(requiredElement(host, '[data-testid="vault-recovery-key"]').textContent).toBe("AFTER-REMOUNT-KEY");
  expect(ownerChecks).toBe(0);
  expect(host.querySelector('[data-testid="private-app"]')).toBeNull();
});

it.each([false, true])("settles failed setup after replacement without admitting unknown completion, committed %s", async (committed) => {
  let configured = false;
  let bodyRequested = false;
  let rejectBody!: (error: Error) => void;
  const body = new Promise<string>((_resolve, reject) => { rejectBody = reject; });
  let setupCalls = 0;
  let ownerChecks = 0;
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    const path = new URL(input instanceof Request ? input.url : String(input), window.location.origin).pathname;
    if (path === "/api/vault/status") return Response.json({ mode: "vault", state: configured ? "unlocked" : "unconfigured", legacyDatabase: true, recoveryKeyCount: configured ? 1 : 0, lockedForMs: 0, unlocked: configured, session: configured, broker: false });
    if (path === "/api/vault/setup") {
      setupCalls += 1;
      if (setupCalls > 1) {
        configured = true;
        return Response.json({ ok: true, recoveryKey: "RETRY-KEY", plaintextStatus: "clean" });
      }
      configured = committed;
      const response = new Response(null);
      response.text = () => { bodyRequested = true; return body; };
      return response;
    }
    if (path.endsWith("/needsSetup")) { ownerChecks += 1; return envelope({ needsSetup: false, setupBlocked: false }); }
    return Response.json({ ok: true });
  }, { preconnect: originalFetch.preconnect });
  const host = await mount(<div data-testid="private-app">Private</div>);
  await until(() => host.querySelector('[data-testid="vault-setup-submit"]') !== null);
  setInput(host, "vault-passphrase", "a strong setup passphrase");
  setInput(host, "vault-passphrase-confirm", "a strong setup passphrase");
  act(() => requiredElement<HTMLButtonElement>(host, '[data-testid="vault-setup-submit"]').click());
  await until(() => bodyRequested);
  await act(async () => { advisory(); });
  await until(() => host.querySelector('[data-testid="vault-setup-pending"]') !== null);
  await act(async () => { rejectBody(new Error("setup body lost")); });
  await until(() => host.querySelector('[role="alert"]') !== null);
  expect(host.querySelector('[data-testid="vault-setup-pending"]')).toBeNull();
  expect(host.querySelector('[data-testid="private-app"]')).toBeNull();
  expect(ownerChecks).toBe(0);
  if (!committed) {
    setInput(host, "vault-passphrase", "a strong retry passphrase");
    setInput(host, "vault-passphrase-confirm", "a strong retry passphrase");
    act(() => requiredElement<HTMLButtonElement>(host, '[data-testid="vault-setup-submit"]').click());
    await until(() => host.querySelector('[data-testid="vault-recovery-key"]') !== null);
    expect(requiredElement(host, '[data-testid="vault-recovery-key"]').textContent).toBe("RETRY-KEY");
    expect(ownerChecks).toBe(0);
  }
});

it.each([false, true])("keeps StrictMode's active query and draft, then clears retired clients without reviving leases, same-turn completion %s", async (completeBeforeCleanup) => {
  type Pending = { client: QueryClient; signal: AbortSignal; release: (value: string) => void; result: Promise<unknown>; mounts: number };
  const pending = new Map<QueryClient, Pending>();
  const mountClient = QueryClient.prototype.mount;
  // Start a genuine query at provider mount, before the gate's asynchronous boot.
  // This observes the actual client during StrictMode's setup/cleanup/setup cycle.
  const mountedClient = spyOn(QueryClient.prototype, "mount").mockImplementation(function (this: QueryClient) {
    mountClient.call(this);
    const existing = pending.get(this);
    if (existing !== undefined) { existing.mounts += 1; return; }
    this.setQueryData(["private-seed"], "private cached data");
    let release!: (value: string) => void;
    let signal!: AbortSignal;
    const held = new Promise<string>((resolve) => { release = resolve; });
    const result = this.fetchQuery({ queryKey: ["private-deferred"], queryFn: (context) => { signal = context.signal; return held; } }).catch(() => "cancelled");
    pending.set(this, { client: this, signal, release, result, mounts: 1 });
  });
  let binding!: RpcBinding;
  let activeClient!: QueryClient;
  function Draft() {
    binding = useRpc();
    activeClient = useQueryClient();
    const [draft, setDraft] = useState("unsaved private draft");
    return <button data-testid="draft" onClick={() => setDraft("edited private draft")}>{draft}</button>;
  }
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    const path = new URL(input instanceof Request ? input.url : String(input), window.location.origin).pathname;
    if (path === "/api/vault/status") return new Response("not found", { status: 404 });
    if (path.endsWith("/preferencesGet")) return envelope({ values: {} });
    return envelope({ needsSetup: false, setupBlocked: false });
  }, { preconnect: originalFetch.preconnect });
  try {
    const host = await mount(<Draft />, true);
    await until(() => host.querySelector('[data-testid="draft"]') !== null);
    const first = pending.get(activeClient);
    expect(first).toBeDefined();
    if (first === undefined) throw new Error("Missing active client query");
    expect(first.mounts).toBeGreaterThanOrEqual(2);
    expect(first.signal.aborted).toBe(false);
    expect(first.client.getQueryData<string>(["private-seed"])).toBe("private cached data");
    act(() => requiredElement<HTMLButtonElement>(host, '[data-testid="draft"]').click());
    const oldBinding = binding;
    const generation = sessionRefreshGeneration();
    const descriptor = Object.getOwnPropertyDescriptor(window, "localStorage");
    const restore = replaceLocalStorage({ getItem: () => { throw new Error("blocked read"); } });
    try {
      expect(() => window.localStorage.getItem("better-auth.message")).toThrow("blocked read");
      await act(async () => {
        window.dispatchEvent(new Event("focus"));
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new Event("focus"));
      });
      expect(sessionRefreshGeneration()).toBe(generation);
      expect(activeClient).toBe(first.client);
      expect(binding).toBe(oldBinding);
      expect(host.querySelector('[data-testid="draft"]')?.textContent).toBe("edited private draft");
    } finally { restore(); }
    expect(Object.getOwnPropertyDescriptor(window, "localStorage")).toEqual(descriptor);
    // Resolve the initial query after effect replay, proving it was not cancelled.
    await act(async () => { first.release("first private answer"); await first.result; });
    expect(first.client.getQueryData<string>(["private-deferred"])).toBe("first private answer");
    await act(async () => {
      flushSync(() => { advisory(); });
      expect(host.querySelector('[data-testid="draft"]')).toBeNull();
      // The captured lease retires before any cleanup microtask runs.
      expect(oldBinding.lease?.isLive()).toBe(false);
      expect(() => oldBinding.lease?.assertLive()).toThrow("SESSION_SCOPE_RETIRED");
    });
    await until(() => activeClient !== first.client && host.querySelector('[data-testid="draft"]') !== null);
    expect(first.client.getQueryCache().getAll()).toHaveLength(0);
    expect(host.querySelector('[data-testid="draft"]')?.textContent).toBe("unsaved private draft");
    const second = pending.get(activeClient);
    if (second === undefined) throw new Error("Missing replacement query");
    const secondBinding = binding;
    await act(async () => {
      markAuthLost();
      expect(secondBinding.lease?.isLive()).toBe(false);
      clearAuthLost();
      expect(secondBinding.lease?.isLive()).toBe(false);
      // Complete the old request in the same turn as replacement, before its
      // scheduled cleanup. It must never populate the replacement client.
      if (completeBeforeCleanup) second.release("late private answer");
    });
    await until(() => activeClient !== second.client);
    // Completed queries need no abort; still-pending retired queries must abort.
    expect(second.signal.aborted).toBe(!completeBeforeCleanup);
    expect(second.client.getQueryCache().getAll()).toHaveLength(0);
    await act(async () => { second.release("late private answer"); await second.result; });
    expect(second.client.getQueryCache().getAll()).toHaveLength(0);
    expect(activeClient.getQueryData(["private-deferred"])).toBeUndefined();
    expect(oldBinding.lease?.isLive()).toBe(false);
    const last = pending.get(activeClient);
    if (last === undefined) throw new Error("Missing final query");
    const root = roots.pop();
    if (root === undefined) throw new Error("Missing mounted root");
    await act(async () => { root.unmount(); });
    expect(last.signal.aborted).toBe(true);
    expect(last.client.getQueryCache().getAll()).toHaveLength(0);
    await act(async () => { last.release("answer after unmount"); await last.result; });
    expect(last.client.getQueryCache().getAll()).toHaveLength(0);
  } finally {
    mountedClient.mockRestore();
    for (const entry of pending.values()) entry.client.clear();
  }
});

function invoice(id: string, invoiceDate: string): Invoice {
  return { id, invoiceDate, invoiceNumber: `INV-${id}`, kind: "SALE", counterpartyId: "customer", counterpartyName: "Customer", subtotalAmount: 1000, discountType: null, discountValue: null, discountAmount: 0, totalAmount: 1000, remainingAmount: 1000, paidAmount: 0, notes: null, createdAt: `${invoiceDate}T10:00:00`, updatedAt: `${invoiceDate}T10:00:00` };
}

it("blocks a retained direct preference setter after its component unmounts", async () => {
  let writeCount = 0;
  let retained!: (next: boolean) => void;
  function PreferenceProbe() {
    const pref = usePreference("ui.test", false, parseBooleanPreference, serializeBooleanPreference);
    retained = pref.setValue;
    return <span data-testid="preference">{String(pref.value)}</span>;
  }
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    const path = new URL(input instanceof Request ? input.url : String(input), window.location.origin).pathname;
    if (path === "/api/vault/status") return new Response("not found", { status: 404 });
    if (path.endsWith("/preferencesGet")) return envelope({ values: {} });
    if (path.endsWith("/preferencesSet")) { writeCount += 1; return envelope({ key: "ui.test", value: "true" }); }
    return envelope({ needsSetup: false, setupBlocked: false });
  }, { preconnect: originalFetch.preconnect });
  const host = await mount(<PreferenceProbe />);
  await until(() => host.querySelector('[data-testid="preference"]') !== null);
  const root = roots.pop();
  if (root === undefined) throw new Error("Missing mounted root");
  act(() => root.unmount());
  act(() => retained(true));
  await flush();
  expect(writeCount).toBe(0);
});

it("retains the real two-target payment observer without dispatching its second payment after fresh admission", async () => {
  let release!: (response: Response) => void;
  const writes: string[] = [];
  globalThis.fetch = Object.assign(async (input: RequestInfo | URL) => {
    const request = input instanceof Request ? input : new Request(input);
    const path = new URL(request.url).pathname;
    if (path === "/api/vault/status") return new Response("not found", { status: 404 });
    if (path.endsWith("/invoicesPay")) {
      const body = z.object({ json: z.object({ invoiceId: z.string() }) }).parse(await request.json());
      writes.push(body.json.invoiceId);
      if (writes.length === 1) return new Promise<Response>((resolve) => { release = resolve; });
      return envelope({});
    }
    if (path.endsWith("/preferencesGet")) return envelope({ values: {} });
    return envelope({ needsSetup: false, setupBlocked: false });
  }, { preconnect: originalFetch.preconnect });
  const host = await mount(<CustomerSettlePanel partyId="customer" invoices={[invoice("first", "2026-09-01"), invoice("second", "2026-09-02")]} unpaid={2000} onDone={() => {}} onWriteFailed={() => {}} onCancel={() => {}} />, true);
  await until(() => host.querySelector('[data-testid="party-settle-confirm"]') !== null);
  act(() => requiredElement<HTMLButtonElement>(host, '[data-testid="party-settle-confirm"]').click());
  await until(() => writes.length === 1);
  expect(writes).toEqual(["first"]);
  await act(async () => { advisory(); });
  await until(() => host.querySelector<HTMLButtonElement>('[data-testid="party-settle-confirm"]')?.disabled === false);
  // B is now admitted before A's first request finishes.
  await act(async () => { release(envelope({})); });
  await flush();
  expect(writes).toEqual(["first"]);
  act(() => requiredElement<HTMLButtonElement>(host, '[data-testid="party-settle-confirm"]').click());
  await until(() => writes.length === 3);
  expect(writes).toEqual(["first", "first", "second"]);
});
