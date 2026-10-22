import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import i18n, { type AuthErrorInput } from "./lib/i18n";
import { storeVaultSessionToken } from "./lib/vault-client";
import { clearAuthLost, markAuthLost, markSignedOut, SIGNED_OUT_STORAGE_KEY } from "./lib/auth-refusal";
import { SETUP_TOKEN_STORAGE_KEY } from "./lib/setup-token";
import { SIDEBAR_COLLAPSED_KEY, useSidebarCollapsed } from "./components/app/sidebar-state";

let needsSetup = false;
let setupBlocked = false;
/** Number of needsSetup calls that fail (simulates a proxy/API interruption). */
let needsSetupFailures = 0;
/** The better-auth error shape the login page maps (code/message/status). */
type SignInResult = { error: AuthErrorInput | null };
let signInResult: SignInResult = { error: null };
let signInArgs: { username?: string; password?: string } | null = null;
let signInCalls = 0;
/** When true the sign-in call rejects, as a network or proxy failure does. */
let signInThrows = false;
/** How long a sign-in call stays in flight, so a double submit can race it. */
let signInDelayMs = 0;
let firstTimeSetupCalls = 0;
let firstTimeSetupArgs: { setupToken?: string } | null = null;
let setupError: Error | null = null;

// issue #97 follow-up: the shell's preference migration
let sessionData: { user: { id: string } } | null = null;
let sessionPending = false;
let preferenceStore: Record<string, string> = {};
let preferenceReadGate: Promise<void> | null = null;
let preferenceReadCalls = 0;
let failPreferenceWriteCount = 0;
let preferenceWriteGate: Promise<void> | null = null;

mock.module("@/lib/rpc", () => ({
  rpcClient: {
    needsSetup: async () => {
      if (needsSetupFailures > 0) {
        needsSetupFailures -= 1;
        throw new Error("proxy down");
      }
      return { needsSetup, setupBlocked };
    },
    firstTimeSetup: async (input: { setupToken?: string }) => {
      firstTimeSetupCalls += 1;
      firstTimeSetupArgs = input;
      if (setupError !== null) throw setupError;
      return {};
    },
    preferencesGet: async () => {
      preferenceReadCalls += 1;
      // hold every read while gated, so the shell's query and the background
      // migration race in a controlled way
      if (preferenceReadGate !== null) await preferenceReadGate;
      return { values: { ...preferenceStore } };
    },
    preferencesSet: async (input: { key: string; value: string }) => {
      if (preferenceWriteGate !== null) {
        const gate = preferenceWriteGate;
        preferenceWriteGate = null;
        await gate;
      }
      if (failPreferenceWriteCount > 0) {
        failPreferenceWriteCount -= 1;
        throw new Error("PREFERENCES_WRITE_FAILED");
      }
      preferenceStore[input.key] = input.value;
      return { key: input.key, value: input.value };
    },
  },
  orpc: {},
}));

mock.module("@/lib/auth-client", () => ({
  useSession: () => ({ data: sessionData, isPending: sessionPending }),
  authClient: {
    signIn: {
      username: async (args: { username?: string; password?: string }) => {
        signInCalls += 1;
        signInArgs = args;
        if (signInDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, signInDelayMs));
        if (signInThrows) throw new Error("network down");
        return signInResult;
      },
    },
  },
}));

const { RequireSession } = await import("./App");

let mounted: Array<{ root: ReturnType<typeof createRoot>; host: HTMLElement }> = [];

/**
 * The legacy auth screens are what these tests exercise, so the vault status
 * route answers 404 by default (a legacy build). Tests that need the vault
 * paths override this (see the unreachable-status regression).
 */
const originalFetch = globalThis.fetch;
let vaultStatusResponse: () => Promise<Response> = async () => new Response("not found", { status: 404 });
/**
 * Every vault route the app called, in order, as `METHOD pathname`. The retry
 * ORDER is the point (#298): the folder must be asked before the status is read.
 */
let vaultCalls: string[] = [];

beforeEach(() => {
  vaultCalls = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = input instanceof Request ? input.url : String(input);
      const pathname = new URL(url, "http://localhost").pathname;
      if (pathname === "/api/vault/status") {
        vaultCalls.push(`GET ${pathname}`);
        return vaultStatusResponse();
      }
      if (pathname === "/api/vault/reclaim") {
        vaultCalls.push(`POST ${pathname}`);
        return Response.json({ ok: true, taken: false });
      }
      if (pathname === "/api/vault/unlock") {
        vaultCalls.push(`POST ${pathname}`);
        // the browser path's credential is the cookie this reply sets (#319)
        return Response.json({ ok: true, sessionGeneration: 2 });
      }
      return originalFetch(input, init);
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  vaultStatusResponse = async () => new Response("not found", { status: 404 });
  for (const entry of mounted) act(() => entry.root.unmount());
  mounted = [];
  document.body.innerHTML = "";
  needsSetup = false;
  setupBlocked = false;
  needsSetupFailures = 0;
  signInResult = { error: null };
  signInArgs = null;
  signInCalls = 0;
  signInThrows = false;
  signInDelayMs = 0;
  firstTimeSetupCalls = 0;
  firstTimeSetupArgs = null;
  setupError = null;
  sessionData = null;
  sessionPending = false;
  preferenceStore = {};
  preferenceReadGate = null;
  preferenceReadCalls = 0;
  failPreferenceWriteCount = 0;
  preferenceWriteGate = null;
  window.localStorage.clear();
  window.sessionStorage.clear();
  // the refusal is module state, so it outlives a mount: reset it like the page
  clearAuthLost();
});

function renderWithClient(root: ReturnType<typeof createRoot>, ui: React.ReactElement, client: QueryClient): void {
  root.render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

async function mountAuthGateFor(selector: string, children: React.ReactNode = null): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <RequireSession>{children}</RequireSession>
      </QueryClientProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (host.querySelector(selector) !== null) return host;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  throw new Error(`auth gate did not render ${selector}`);
}

async function mountAuthGate(): Promise<HTMLElement> {
  return mountAuthGateFor("form");
}

/** Mount past the vault gate: unlocked status + an in-process session token. */
async function mountVaultOwnerGateFor(selector: string, children: React.ReactNode = null): Promise<HTMLElement> {
  // `session: true` is the server saying THIS request's credential is the live
  // one (#319): the gate renders the app on that answer, so a fixture that
  // omitted it would leave every owner test on the unlock screen.
  vaultStatusResponse = async () =>
    Response.json({
      mode: "vault",
      state: "unlocked",
      legacyDatabase: false,
      recoveryKeyCount: 1,
      lockedForMs: 0,
      unlocked: true,
      session: true,
    });
  storeVaultSessionToken("session-token");
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => {
    root.render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <RequireSession>{children}</RequireSession>
      </QueryClientProvider>,
    );
  });
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (host.querySelector(selector) !== null) return host;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
  }
  throw new Error(`vault owner gate did not render ${selector}`);
}

describe("vault status retry (finding 5)", () => {
  it("shows a retry state when the status is unreachable, never the legacy login", async () => {
    let calls = 0;
    vaultStatusResponse = async () => {
      calls += 1;
      if (calls === 1) throw new Error("api not up");
      return Response.json({
        mode: "vault",
        state: "locked",
        legacyDatabase: false,
        recoveryKeyCount: 0,
        lockedForMs: 0,
        unlocked: false,
      });
    };
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    mounted.push({ root, host });
    await act(async () => {
      root.render(
        <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
          <RequireSession>{null}</RequireSession>
        </QueryClientProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(host.querySelector('[data-testid="vault-status-unavailable"]')).not.toBeNull();
    // the legacy login must NOT appear for a vault install with a blip
    expect(host.querySelector("form")).toBeNull();

    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="vault-status-retry"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(host.querySelector('[data-testid="vault-passphrase"]')).not.toBeNull();
  });
});

describe("vault folder held by another instance (issue #276)", () => {
  it("shows the in-use screen for the refusal, never the server-down screen", async () => {
    vaultStatusResponse = async () => Response.json({ error: { code: "VAULT_LOCKED_BY_OTHER_INSTANCE" } }, { status: 503 });
    const host = await mountAuthGateFor('[data-testid="vault-status-in-use"]');
    // #277: the refused instance takes the folder by itself, so the screen
    // must not send the owner through the restart that change removed
    expect(host.querySelector('[data-testid="vault-status-in-use"]')?.textContent).toBe(
      "البيانات مفتوحة في نسخة أخرى من دكان على هذا المجلد. أغلق النسخة الأخرى، وستأخذ هذه النسخة المجلد من تلقاء نفسها.",
    );
    expect(host.querySelector('[data-testid="vault-status-unavailable"]')).toBeNull();
    // the legacy login must not appear behind a refusal either
    expect(host.querySelector("form")).toBeNull();
  });

  it("asks the refused instance to re-check before it re-reads the status (#298)", async () => {
    // greptile P2 on #298: the retry is a route of its own. When every request
    // also ran a reclaim, a poll cancelled and re-armed the instance's backoff
    // tick, so the retry on this screen was satisfied by the poll rather than by
    // the button. The button must post the retry route, and it must do so before
    // it reads the status again, or it shows the refusal it just cleared.
    vaultStatusResponse = async () => Response.json({ error: { code: "VAULT_LOCKED_BY_OTHER_INSTANCE" } }, { status: 503 });
    const host = await mountAuthGateFor('[data-testid="vault-status-in-use"]');
    vaultCalls = [];
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="vault-status-retry"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(vaultCalls[0]).toBe("POST /api/vault/reclaim");
    expect(vaultCalls).toContain("GET /api/vault/status");
    // ...and the refusal is still the refusal: the folder did not move
    expect(host.querySelector('[data-testid="vault-status-in-use"]')).not.toBeNull();
  });

  it("keeps the refusal on screen while a background check is in flight (#298)", async () => {
    // The 5 s poll on this screen calls the SAME load() the retry button calls,
    // and load() used to clear `failure` the moment it STARTED. `RequireSession`
    // falls back to the loading screen while `failure` is undefined, so the
    // sentence and the Retry button vanished on every poll, and the keyboard
    // focus sitting on the button went with them (greptile P2 on #298). A check
    // that has not answered yet is not news: only a SUCCESSFUL read clears the
    // refusal.
    vaultStatusResponse = async () => Response.json({ error: { code: "VAULT_LOCKED_BY_OTHER_INSTANCE" } }, { status: 503 });
    const host = await mountAuthGateFor('[data-testid="vault-status-in-use"]');
    const retry = host.querySelector<HTMLButtonElement>('[data-testid="vault-status-retry"]');
    if (retry === null) throw new Error("the refusal screen has no retry button");
    retry.focus();

    // the next status read never settles inside the assertion window
    let release: (response: Response) => void = () => undefined;
    vaultStatusResponse = () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      });
    await act(async () => {
      retry.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    // the read is in flight: the refusal is still the screen the owner is on
    expect(vaultCalls).toContain("GET /api/vault/status");
    expect(host.querySelector('[data-testid="vault-status-in-use"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="vault-status-retry"]')).not.toBeNull();
    expect(host.textContent).toContain("البيانات مفتوحة في نسخة أخرى");
    // and the button the owner was on still has the keyboard
    expect(document.activeElement).toBe(retry);

    // the check answers with the same refusal: same screen, no flicker
    await act(async () => {
      release(Response.json({ error: { code: "VAULT_LOCKED_BY_OTHER_INSTANCE" } }, { status: 503 }));
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(host.querySelector('[data-testid="vault-status-in-use"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="vault-passphrase"]')).toBeNull();
  });

  it("retries the refusal into the gate once the folder is free", async () => {
    let calls = 0;
    vaultStatusResponse = async () => {
      calls += 1;
      if (calls === 1) return Response.json({ error: { code: "VAULT_LOCKED_BY_OTHER_INSTANCE" } }, { status: 503 });
      return Response.json({
        mode: "vault",
        state: "locked",
        legacyDatabase: false,
        recoveryKeyCount: 0,
        lockedForMs: 0,
        unlocked: false,
      });
    };
    const host = await mountAuthGateFor('[data-testid="vault-status-in-use"]');
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="vault-status-retry"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(host.querySelector('[data-testid="vault-passphrase"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="vault-status-in-use"]')).toBeNull();
  });

  it("keeps the server-down screen when the server is genuinely unreachable", async () => {
    vaultStatusResponse = async () => {
      throw new Error("api down");
    };
    const host = await mountAuthGateFor('[data-testid="vault-status-unavailable"]');
    expect(host.querySelector('[data-testid="vault-status-unavailable"]')?.textContent).toBe(
      "تعذّر الاتصال بالخادم. تأكد من تشغيله ثم أعد المحاولة.",
    );
    expect(host.querySelector('[data-testid="vault-status-in-use"]')).toBeNull();
  });

  it("invents no cause: an HTML 503 and an unknown code both stay server-down", async () => {
    // a build older than #275 answers the status route with the Arabic refusal page
    vaultStatusResponse = async () =>
      new Response("<!doctype html><main>البيانات مفتوحة في نسخة أخرى</main>", { status: 503, headers: { "content-type": "text/html" } });
    const html503 = await mountAuthGateFor('[data-testid="vault-status-unavailable"]');
    expect(html503.querySelector('[data-testid="vault-status-in-use"]')).toBeNull();

    // an envelope naming a code the gate cannot attribute is not the lock story
    vaultStatusResponse = async () => Response.json({ error: { code: "VAULT_UNEXPECTED" } }, { status: 503 });
    const unknownCode = await mountAuthGateFor('[data-testid="vault-status-unavailable"]');
    expect(unknownCode.querySelector('[data-testid="vault-status-in-use"]')).toBeNull();
    expect(unknownCode.querySelector('form')).toBeNull();
  });
});

describe("vault folder locked by a recycled pid (issue #283)", () => {
  it("names the lock file, and never the close-the-copy story, when the refusal is flagged", async () => {
    vaultStatusResponse = async () =>
      Response.json({ error: { code: "VAULT_LOCKED_BY_OTHER_INSTANCE", staleHeartbeat: true } }, { status: 503 });
    const host = await mountAuthGateFor('[data-testid="vault-status-stale-lock"]');
    // the recycled-pid story keeps its file instruction and loses the restart:
    // deleting vault.lock is enough, the retry loop takes the folder after it
    expect(host.querySelector('[data-testid="vault-status-stale-lock"]')?.textContent).toBe(
      "القفل ممسوك بعملية لا تبدو نسخة أخرى من دكان. إن لم تكن هناك نسخة أخرى مفتوحة، فاحذف ملف vault.lock من مجلد البيانات، وستأخذ هذه النسخة المجلد من تلقاء نفسها.",
    );
    expect(host.querySelector('[data-testid="vault-status-in-use"]')).toBeNull();
    expect(host.querySelector("form")).toBeNull();
  });

  it("keeps the in-use copy for a genuine holder, and never claims a recycled pid elsewhere", async () => {
    // no flag: #276's story stays, and the flag must not widen an unrelated
    // code that happens to carry the field
    vaultStatusResponse = async () => Response.json({ error: { code: "VAULT_LOCKED_BY_OTHER_INSTANCE" } }, { status: 503 });
    const genuine = await mountAuthGateFor('[data-testid="vault-status-in-use"]');
    expect(genuine.querySelector('[data-testid="vault-status-stale-lock"]')).toBeNull();

    vaultStatusResponse = async () => Response.json({ error: { code: "VAULT_UNEXPECTED", staleHeartbeat: true } }, { status: 503 });
    const other = await mountAuthGateFor('[data-testid="vault-status-unavailable"]');
    expect(other.querySelector('[data-testid="vault-status-stale-lock"]')).toBeNull();
    expect(other.querySelector('[data-testid="vault-status-in-use"]')).toBeNull();
  });

  it("retries out of the stale-lock screen into the gate once the lock is gone", async () => {
    let calls = 0;
    vaultStatusResponse = async () => {
      calls += 1;
      if (calls === 1) {
        return Response.json({ error: { code: "VAULT_LOCKED_BY_OTHER_INSTANCE", staleHeartbeat: true } }, { status: 503 });
      }
      return Response.json({ mode: "vault", state: "locked", legacyDatabase: false, recoveryKeyCount: 0, lockedForMs: 0, unlocked: false });
    };
    const host = await mountAuthGateFor('[data-testid="vault-status-stale-lock"]');
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="vault-status-retry"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(host.querySelector('[data-testid="vault-passphrase"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="vault-status-stale-lock"]')).toBeNull();
  });
});

describe("a session that died under a live window (#319)", () => {
  /** A status answer from a server that does NOT hold this request's credential. */
  const deadSession = async (): Promise<Response> =>
    Response.json({
      mode: "vault",
      state: "unlocked",
      legacyDatabase: false,
      recoveryKeyCount: 1,
      lockedForMs: 0,
      unlocked: true,
      session: false,
    });

  it("a window with no live cookie never mounts the app at all (#319 review P2)", async () => {
    // the vault is unlocked, but THIS request's credential is not the live
    // session: rendering the app would paint a page of failed queries and then
    // send the owner to the unlock screen they belong on from the start
    vaultStatusResponse = deadSession;
    const host = await mountAuthGateFor('[data-testid="vault-passphrase"]', <div data-testid="owner-content" />);
    expect(host.querySelector('[data-testid="vault-passphrase"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="owner-content"]')).toBeNull();
  });

  /** A status answer from a live server: THIS request's credential is the session. */
  const liveSession = async (): Promise<Response> =>
    Response.json({
      mode: "vault",
      state: "unlocked",
      legacyDatabase: false,
      recoveryKeyCount: 1,
      lockedForMs: 0,
      unlocked: true,
      session: true,
    });

  /** A profile whose storage refuses every call: a full quota, or a blocked store. */
  const blockedStorage: Storage = {
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

  /** Poll the host until `selector` renders, the way every mount here does. */
  async function waitForSelector(host: HTMLElement, selector: string): Promise<boolean> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (host.querySelector(selector) !== null) return true;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    return host.querySelector(selector) !== null;
  }

  it("holds the gate on a profile whose storage refuses every call (round-6 finding 1)", async () => {
    // The dangerous case, exactly: the revoke was never confirmed, so the vault
    // cookie is still live (`session: true`), and this profile cannot remember
    // the sign-out in storage at all. `markSignedOut()` used to write there and
    // nowhere else, swallow the throw, and leave `authLostState()` false — so a
    // mount would have reached the app for anyone at the keyboard.
    // block the store the hold uses, or the write succeeds and the memory
    // fallback is never exercised (#341 round 7 P2)
    const originalStorage = Object.getOwnPropertyDescriptor(window, "sessionStorage");
    Object.defineProperty(window, "sessionStorage", { configurable: true, value: blockedStorage });
    try {
      vaultStatusResponse = liveSession;
      storeVaultSessionToken("session-token");
      await act(async () => {
        markSignedOut();
      });
      const host = await mountAuthGateFor('[data-testid="vault-passphrase"]', <div data-testid="owner-content" />);
      expect(host.querySelector('[data-testid="vault-passphrase"]')).not.toBeNull();
      expect(host.querySelector('[data-testid="owner-content"]')).toBeNull();
    } finally {
      if (originalStorage !== undefined) Object.defineProperty(window, "sessionStorage", originalStorage);
    }
  });

  it("re-checks the shared session when the window comes back, so a sibling's unlock frees it (round-6 finding 3)", async () => {
    // Two windows share one cookie. Here window A is gated after a refusal; the
    // one probe answered "not this credential"; then window B unlocks (a
    // rotation) and the jar holds a live cookie for both. Nothing else looks:
    // the flag clears only through THIS window's `onUnlocked`, which is a
    // passphrase the owner does not owe.
    const host = await mountVaultOwnerGateFor('[data-testid="owner-content"]', <div data-testid="owner-content" />);
    expect(host.querySelector('[data-testid="owner-content"]')).not.toBeNull();
    const statusReads = (): number => vaultCalls.filter((call) => call === "GET /api/vault/status").length;

    vaultStatusResponse = deadSession;
    const readsBefore = statusReads();
    await act(async () => {
      markAuthLost();
    });
    expect(await waitForSelector(host, '[data-testid="vault-passphrase"]')).toBe(true);
    expect(host.querySelector('[data-testid="owner-content"]')).toBeNull();
    // the one probe ran, and its answer was dead: the gate is where this stalls
    for (let attempt = 0; attempt < 50 && statusReads() === readsBefore; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    expect(statusReads()).toBeGreaterThan(readsBefore);

    // the sibling unlocked, which replaced the cookie in the shared jar
    vaultStatusResponse = liveSession;
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(await waitForSelector(host, '[data-testid="owner-content"]')).toBe(true);
    expect(host.querySelector('[data-testid="vault-passphrase"]')).toBeNull();
    // and nothing rotated it: the recovery is a status read, never an unlock
    expect(vaultCalls).not.toContain("POST /api/vault/unlock");
  });

  it("closes the probe/cookie race: a false answer, then the replaced cookie, then focus (round-6 finding 4)", async () => {
    // The ordering is the finding, so the test holds it one step at a time.
    const host = await mountVaultOwnerGateFor('[data-testid="owner-content"]', <div data-testid="owner-content" />);
    expect(host.querySelector('[data-testid="owner-content"]')).not.toBeNull();

    // 1. refused: another window rotated the token while this one carried the old
    //    cookie, and the probe that follows left with that same old cookie
    vaultStatusResponse = deadSession;
    await act(async () => {
      markAuthLost();
    });
    expect(await waitForSelector(host, '[data-testid="vault-passphrase"]')).toBe(true);
    expect(host.querySelector('[data-testid="owner-content"]')).toBeNull();

    // 2. and only NOW does the sibling's reply install the replacement cookie.
    //    The gate stays up because nothing looks again — that is the whole
    //    defect — so a wait longer than any probe interval must not move it.
    vaultStatusResponse = liveSession;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    expect(host.querySelector('[data-testid="vault-passphrase"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="owner-content"]')).toBeNull();

    // 3. the owner comes back to this window: the re-check reads the live cookie
    //    and the gate comes down. One read per focus, and never a poll — the
    //    step above is what proves the timer does not exist.
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(await waitForSelector(host, '[data-testid="owner-content"]')).toBe(true);
    expect(host.querySelector('[data-testid="vault-passphrase"]')).toBeNull();
  });

  it("a sign-out the server never confirmed is not demoted by the focus re-check (round-6 finding 3)", async () => {
    const host = await mountVaultOwnerGateFor('[data-testid="owner-content"]', <div data-testid="owner-content" />);
    await act(async () => {
      markSignedOut();
    });
    expect(await waitForSelector(host, '[data-testid="vault-passphrase"]')).toBe(true);

    // the server still reports this request's credential as LIVE (the mount
    // fixture is `session: true`), and the owner now looks at the window again
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      document.dispatchEvent(new Event("visibilitychange"));
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    // a live cookie does not undo a logout: only the owner's own unlock may
    expect(host.querySelector('[data-testid="vault-passphrase"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="owner-content"]')).toBeNull();
  });

  it("lands on the unlock screen, and the owner's unlock comes back into the app", async () => {
    const host = await mountVaultOwnerGateFor('[data-testid="owner-content"]', <div data-testid="owner-content" />);
    expect(host.querySelector('[data-testid="owner-content"]')).not.toBeNull();

    // another window unlocked, or the owner logged out: the RPC guard's
    // refusal reaches the app, and the unlock screen is the answer to it. The
    // status agrees — this request's credential is dead — so the screen is the
    // right answer and the one re-probe cannot take it back.
    vaultStatusResponse = deadSession;
    await act(async () => {
      markAuthLost();
    });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (host.querySelector('[data-testid="vault-passphrase"]') !== null) break;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    expect(host.querySelector('[data-testid="vault-passphrase"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="owner-content"]')).toBeNull();

    // and the unlock CLEARS the refusal: without that, one dead session would
    // strand the owner on this screen for the life of the page
    const passphrase = host.querySelector<HTMLInputElement>('[data-testid="vault-passphrase"]');
    if (passphrase === null) throw new Error("the gate rendered no passphrase input");
    setInputValue(passphrase, "correct horse battery");
    await submitForm(host);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (host.querySelector('[data-testid="owner-content"]') !== null) break;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    expect(host.querySelector('[data-testid="owner-content"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="vault-passphrase"]')).toBeNull();
  });

  it("recovers from a TRANSIENT refusal without asking for a passphrase (#319 review P1)", async () => {
    const host = await mountVaultOwnerGateFor('[data-testid="owner-content"]', <div data-testid="owner-content" />);
    expect(host.querySelector('[data-testid="owner-content"]')).not.toBeNull();

    // a query in flight across another window's rotation is refused, with a
    // perfectly live cookie behind it. One refusal must not latch the unlock
    // screen: recovery used to cost a passphrase, which rotates the token and
    // refuses the window that WAS working.
    await act(async () => {
      markAuthLost();
    });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (host.querySelector('[data-testid="owner-content"]') !== null) break;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    // the app came back on the server's answer alone
    expect(host.querySelector('[data-testid="owner-content"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="vault-passphrase"]')).toBeNull();
    // and nothing rotated it: an unlock request would have replaced the cookie
    expect(vaultCalls).not.toContain("POST /api/vault/unlock");
  });

  it("ignores a refusal probe that was read before the owner unlocked (#319 round 3)", async () => {
    const host = await mountVaultOwnerGateFor('[data-testid="owner-content"]', <div data-testid="owner-content" />);
    expect(host.querySelector('[data-testid="owner-content"]')).not.toBeNull();

    // The re-probe's answer is HELD, so it can be delivered after the unlock.
    // It is the world before the unlock: this request's credential was dead.
    let releaseProbe: (() => void) | undefined;
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    let probeReads = 0;
    vaultStatusResponse = async () => {
      probeReads += 1;
      await probeGate;
      return deadSession();
    };

    await act(async () => {
      markAuthLost();
    });
    for (let attempt = 0; attempt < 50 && probeReads === 0; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    // the probe left while the unlock screen was up
    expect(probeReads).toBe(1);
    expect(host.querySelector('[data-testid="vault-passphrase"]')).not.toBeNull();

    // the owner unlocks with the probe still in flight
    const passphrase = host.querySelector<HTMLInputElement>('[data-testid="vault-passphrase"]');
    if (passphrase === null) throw new Error("the gate rendered no passphrase input");
    setInputValue(passphrase, "correct horse battery");
    await submitForm(host);
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (host.querySelector('[data-testid="owner-content"]') !== null) break;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    expect(host.querySelector('[data-testid="owner-content"]')).not.toBeNull();

    // ... and only now does the pre-unlock answer land. It describes a session
    // that no longer exists, so applying it would put the gate back on top of an
    // open vault for up to a poll interval.
    releaseProbe?.();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 80));
    });
    expect(host.querySelector('[data-testid="owner-content"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="vault-passphrase"]')).toBeNull();
  });

  it("recovers on a live answer that was built before a lock, and the next refusal puts the gate back (round 4)", async () => {
    // The bound the probe cannot cross: its answer is true when it was BUILT,
    // and a lock has no local `setStatus` for `appliedRef` to race. So a reply
    // built while the session was live and delivered after the lock DOES clear
    // the refusal. What must hold is the other half — the app's next refused
    // call raises the gate again, so the window is one refused query and never
    // an open vault.
    const host = await mountVaultOwnerGateFor('[data-testid="owner-content"]', <div data-testid="owner-content" />);
    expect(host.querySelector('[data-testid="owner-content"]')).not.toBeNull();

    let releaseProbe: (() => void) | undefined;
    const probeGate = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    let probeReads = 0;
    vaultStatusResponse = async () => {
      probeReads += 1;
      // built NOW, while this request's credential is still the live session
      const builtWhileLive = Response.json({
        mode: "vault",
        state: "unlocked",
        legacyDatabase: false,
        recoveryKeyCount: 1,
        lockedForMs: 0,
        unlocked: true,
        session: true,
      });
      await probeGate;
      return builtWhileLive;
    };

    await act(async () => {
      markAuthLost();
    });
    for (let attempt = 0; attempt < 50 && probeReads === 0; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    expect(probeReads).toBe(1);
    expect(host.querySelector('[data-testid="vault-passphrase"]')).not.toBeNull();

    // the vault locks while that reply is in flight, and the reply lands anyway
    vaultStatusResponse = deadSession;
    releaseProbe?.();
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (host.querySelector('[data-testid="owner-content"]') !== null) break;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    expect(host.querySelector('[data-testid="owner-content"]')).not.toBeNull();

    // and then a dead session refuses a call — which is what `markAuthLost`
    // records, the same way `rpc-link.ts` does for AUTH_REQUIRED. The gate comes
    // back on a fresh, held answer that says the credential is dead.
    await act(async () => {
      markAuthLost();
    });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (host.querySelector('[data-testid="vault-passphrase"]') !== null) break;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    expect(host.querySelector('[data-testid="vault-passphrase"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="owner-content"]')).toBeNull();
  });

  it("a reload after an unconfirmed sign-out lands on the gate, not the app (round-4 P1)", async () => {
    // The state a reload creates after `logout.ts` could not confirm the revoke:
    // the flag survives the page, and the vault cookie survives with it — so the
    // status route answers `session: true` for a machine that was just signed
    // out. Without the persisted flag this mount reaches the app, which is the
    // shared-machine failure the hold exists to prevent.
    // `sessionStorage`: the hold belongs to the window that signed out, and a
    // reload of THAT window is what has to land on the gate (#341 fresh-eyes P2)
    window.sessionStorage.setItem(SIGNED_OUT_STORAGE_KEY, "1");
    vaultStatusResponse = async () =>
      Response.json({
        mode: "vault",
        state: "unlocked",
        legacyDatabase: false,
        recoveryKeyCount: 1,
        lockedForMs: 0,
        unlocked: true,
        session: true,
      });
    storeVaultSessionToken("session-token");
    const host = await mountAuthGateFor('[data-testid="vault-passphrase"]', <div data-testid="owner-content" />);
    expect(host.querySelector('[data-testid="vault-passphrase"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="owner-content"]')).toBeNull();
  });

  it("keeps the unlock screen for a sign-out the server never confirmed (#319 round 3)", async () => {
    // The state `logout.ts` creates when the revoke FAILS: the page gives up its
    // own copy, cannot disable an `HttpOnly` cookie, and records the sign-out as
    // its own reason. `logout.test.ts` proves that at the module boundary; what
    // was never proven is what `RequireSession` does with it — and the fixture
    // here is the dangerous case, a server that still reports this request's
    // credential as LIVE (the mount fixture is `session: true`). A live cookie
    // must not undo a sign-out the server could not confirm.
    const host = await mountVaultOwnerGateFor('[data-testid="owner-content"]', <div data-testid="owner-content" />);
    const statusReads = (): number => vaultCalls.filter((call) => call === "GET /api/vault/status").length;
    const readsBefore = statusReads();

    await act(async () => {
      markSignedOut();
    });
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (host.querySelector('[data-testid="vault-passphrase"]') !== null) break;
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    expect(host.querySelector('[data-testid="vault-passphrase"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="owner-content"]')).toBeNull();

    // the re-probe ran, and the server answered "live" — the answer that must
    // NOT recover a sign-out
    for (let attempt = 0; attempt < 50 && statusReads() === readsBefore; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    expect(statusReads()).toBeGreaterThan(readsBefore);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 120));
    });
    // the unlock screen stays: only the owner's own unlock may leave it
    expect(host.querySelector('[data-testid="vault-passphrase"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="owner-content"]')).toBeNull();
  });
});

describe("vault owner gate retry (round-7 finding 4)", () => {
  it("auto-retries a failed needsSetup check instead of hanging on the loading screen", async () => {
    needsSetupFailures = 1;
    const host = await mountVaultOwnerGateFor('[data-testid="owner-content"]', <div data-testid="owner-content" />);
    // the bounded retry recovered and the owner gate rendered its children
    expect(host.querySelector('[data-testid="owner-content"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="owner-check-retry"]')).toBeNull();
  });

  it("shows a working retry button after repeated failures", async () => {
    needsSetupFailures = 99;
    const host = await mountVaultOwnerGateFor('[data-testid="owner-check-retry"]');
    expect(host.querySelector('[data-testid="owner-check-failed"]')).not.toBeNull();

    // the interruption ends: the owner retries from the button and gets in
    needsSetupFailures = 0;
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="owner-check-retry"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(host.querySelector('[data-testid="owner-check-retry"]')).toBeNull();
  });
});

function inputByName(host: HTMLElement, name: string): HTMLInputElement {
  const input = host.querySelector<HTMLInputElement>(`input[name="${name}"]`);
  if (input === null) throw new Error(`missing input named ${name}`);
  return input;
}

/** React listens for the native setter + input event, not a value assignment. */
function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter === undefined) throw new Error("HTMLInputElement value setter missing");
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function submitForm(host: HTMLElement): Promise<void> {
  const form = host.querySelector("form");
  if (form === null) throw new Error("auth gate rendered no form");
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

describe("ownerless non-empty database (ADR-0008 §4.1)", () => {
  it("shows the blocked message instead of a login form that cannot succeed", async () => {
    needsSetup = false;
    setupBlocked = true;
    const host = await mountAuthGateFor('[data-testid="setup-blocked"]');

    const alert = host.querySelector('[data-testid="setup-blocked"]');
    expect(alert?.textContent).toBe(i18n.t("SETUP_DATABASE_NOT_EMPTY"));
    expect(host.querySelector('[data-testid="login-submit"]')).toBeNull();
    expect(host.querySelector("form")).toBeNull();
  });

  it("retries the check and moves on when the condition clears", async () => {
    needsSetup = false;
    setupBlocked = true;
    const host = await mountAuthGateFor('[data-testid="setup-blocked"]');
    expect(host.querySelector('[data-testid="setup-blocked"]')).not.toBeNull();

    // the underlying condition is gone: the retry must reach the login form
    setupBlocked = false;
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="setup-blocked-retry"]')?.click();
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(host.querySelector('[data-testid="login-submit"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="setup-blocked"]')).toBeNull();
  });
});

describe("setup token (ADR-0008 ownership race)", () => {
  it("forwards the shell's one-time token to the api", async () => {
    needsSetup = true;
    window.sessionStorage.setItem(SETUP_TOKEN_STORAGE_KEY, "shell-token");
    const host = await mountAuthGate();

    setInputValue(inputByName(host, "ownerName"), "مالك");
    setInputValue(inputByName(host, "storeName"), "متجر");
    setInputValue(inputByName(host, "phone"), "0550123123");
    setInputValue(inputByName(host, "password"), "abcd");
    await submitForm(host);

    expect(firstTimeSetupCalls).toBe(1);
    expect(firstTimeSetupArgs?.setupToken).toBe("shell-token");
  });

  it("sends no token outside the packaged shell", async () => {
    needsSetup = true;
    const host = await mountAuthGate();

    setInputValue(inputByName(host, "ownerName"), "مالك");
    setInputValue(inputByName(host, "storeName"), "متجر");
    setInputValue(inputByName(host, "phone"), "0550123123");
    setInputValue(inputByName(host, "password"), "abcd");
    await submitForm(host);

    expect(firstTimeSetupCalls).toBe(1);
    expect(firstTimeSetupArgs?.setupToken).toBeUndefined();
  });
});

describe("auth phone inputs (issue #94)", () => {
  it("setup: the phone field is a named tel input with the tel keypad", async () => {
    needsSetup = true;
    const host = await mountAuthGate();

    const phone = inputByName(host, "phone");
    expect(phone.type).toBe("tel");
    expect(phone.inputMode).toBe("tel");
    expect(phone.autocomplete).toBe("username");

    // the other setup fields carry meaningful names too
    expect(inputByName(host, "ownerName").name).toBe("ownerName");
    expect(inputByName(host, "storeName").name).toBe("storeName");
    expect(inputByName(host, "password").type).toBe("password");
  });

  it("login: the username phone field is a named tel input", async () => {
    needsSetup = false;
    const host = await mountAuthGate();

    const username = inputByName(host, "username");
    expect(username.type).toBe("tel");
    expect(username.inputMode).toBe("tel");
    expect(username.autocomplete).toBe("username");
  });
});

describe("password reveal eye (issue #167)", () => {
  it("login: the password field has an app-controlled toggle that flips its type", async () => {
    needsSetup = false;
    const host = await mountAuthGate();

    const toggle = (): HTMLButtonElement | null => host.querySelector<HTMLButtonElement>('[data-testid="login-password-toggle"]');
    expect(inputByName(host, "password").type).toBe("password");
    expect(toggle()?.type).toBe("button");

    await act(async () => {
      toggle()?.click();
    });
    expect(inputByName(host, "password").type).toBe("text");
    await act(async () => {
      toggle()?.click();
    });
    expect(inputByName(host, "password").type).toBe("password");
    // the reported bug: the eye must still be there after one round trip
    expect(toggle()).not.toBeNull();
  });

  it("first run: the password field has an app-controlled toggle", async () => {
    needsSetup = true;
    const host = await mountAuthGate();

    const toggle = host.querySelector<HTMLButtonElement>('[data-testid="setup-password-toggle"]');
    expect(toggle?.type).toBe("button");
    await act(async () => {
      toggle?.click();
    });
    expect(host.querySelector<HTMLInputElement>('[data-testid="setup-password"]')?.type).toBe("text");
  });
});

describe("login failures name the problem (issue #100)", () => {
  it("a rejected password shows the credentials message, not the generic one", async () => {
    needsSetup = false;
    signInResult = { error: { code: "INVALID_USERNAME_OR_PASSWORD", message: "Invalid username or password", status: 401 } };
    const host = await mountAuthGate();

    setInputValue(inputByName(host, "username"), "0550123123");
    setInputValue(inputByName(host, "password"), "wrong-password");
    await submitForm(host);

    // a field-less failure is its own live region: that is the only
    // announcement path, and it is the summary that takes focus. Select it by
    // id so the role assertion is a real check, not a restatement of the
    // selector.
    const alert = host.querySelector("#login-error");
    expect(alert?.getAttribute("role")).toBe("alert");
    // exactly one live region: a field-less failure has no second path
    expect(host.querySelectorAll('[role="alert"]').length).toBe(1);
    expect(alert?.textContent).toBe(i18n.t("AUTH_INVALID_CREDENTIALS"));
    expect(alert?.textContent).not.toBe(i18n.t("unexpected"));
    expect(signInCalls).toBe(1);
    // the form posts the canonical username, not the raw local form
    expect(signInArgs?.username).toBe("213550123123");
    // the copy names both fields, so the summary carries the message and no
    // single field is blamed (the field's own aria-invalid would lie)
    expect(document.activeElement).toBe(alert);
    expect(inputByName(host, "password").getAttribute("aria-invalid")).toBe("false");
  });

  it("announces through the field when a field is blamed, not twice", async () => {
    needsSetup = false;
    const host = await mountAuthGate();

    setInputValue(inputByName(host, "username"), "12345");
    setInputValue(inputByName(host, "password"), "abcd");
    await submitForm(host);

    // focus lands on the phone and its aria-describedby carries the message
    const phone = inputByName(host, "username");
    expect(document.activeElement).toBe(phone);
    expect(phone.getAttribute("aria-invalid")).toBe("true");
    expect(phone.getAttribute("aria-describedby")).toBe("login-error");
    // the paragraph is a plain description, not a live region too: otherwise a
    // screen reader announces the sentence on insertion and again on focus.
    // No live region anywhere: the field's description is the only path.
    expect(host.querySelector("#login-error")?.getAttribute("role")).toBeNull();
    expect(host.querySelectorAll('[role="alert"]').length).toBe(0);
  });

  it("stops the phone field at the longest accepted form", async () => {
    needsSetup = false;
    const host = await mountAuthGate();
    // "+213550123123" is 13 characters; anything longer cannot be a login name
    expect(inputByName(host, "username").getAttribute("maxlength")).toBe("13");
  });

  it("keeps the native length hint on the password field", async () => {
    needsSetup = false;
    const host = await mountAuthGate();
    expect(inputByName(host, "password").getAttribute("minlength")).toBe("4");
  });

  it("a malformed phone shows the phone message and never calls sign-in", async () => {
    needsSetup = false;
    const host = await mountAuthGate();

    setInputValue(inputByName(host, "username"), "12345");
    setInputValue(inputByName(host, "password"), "any-password");
    await submitForm(host);

    // a field error is announced through the field, so the paragraph is not a
    // second live region (issue #113)
    const alert = host.querySelector("#login-error");
    expect(alert?.textContent).toBe(i18n.t("INVALID_PHONE_NUMBER"));
    expect(alert?.getAttribute("role")).toBeNull();
    expect(inputByName(host, "username").getAttribute("aria-invalid")).toBe("true");
    expect(inputByName(host, "username").getAttribute("aria-describedby")).toBe("login-error");
    expect(document.activeElement).toBe(inputByName(host, "username"));
    expect(signInCalls).toBe(0);
  });

  it("an unknown failure says something calm, never the crash message", async () => {
    needsSetup = false;
    signInResult = { error: { code: "SOME_FUTURE_401", status: 401 } };
    const host = await mountAuthGate();

    setInputValue(inputByName(host, "username"), "0550123123");
    setInputValue(inputByName(host, "password"), "any-password");
    await submitForm(host);

    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe(i18n.t("errorGeneric"));
    expect(alert?.textContent).not.toBe(i18n.t("unexpected"));
    expect(document.activeElement).toBe(alert);
  });

  it("a lockout names the wait, not the app", async () => {
    needsSetup = false;
    signInResult = { error: { message: "Too many requests. Please try again later.", status: 429 } };
    const host = await mountAuthGate();

    setInputValue(inputByName(host, "username"), "0550123123");
    setInputValue(inputByName(host, "password"), "any-password");
    await submitForm(host);

    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe(i18n.t("AUTH_TOO_MANY_ATTEMPTS"));
    expect(document.activeElement).toBe(alert);
  });

  it("a repeated failure re-mounts the alert so it is announced again", async () => {
    needsSetup = false;
    signInResult = { error: { code: "INVALID_USERNAME_OR_PASSWORD", status: 401 } };
    const host = await mountAuthGate();

    setInputValue(inputByName(host, "username"), "0550123123");
    setInputValue(inputByName(host, "password"), "wrong-password");
    await submitForm(host);
    const first = host.querySelector('[role="alert"]');

    await submitForm(host);
    const second = host.querySelector('[role="alert"]');

    expect(second?.textContent).toBe(i18n.t("AUTH_INVALID_CREDENTIALS"));
    // a new node is what a screen reader notices; React keeps the old one if
    // the key does not change
    expect(second).not.toBe(first);
  });

  it("a field-less failure after a field failure becomes a live region again", async () => {
    needsSetup = false;
    const host = await mountAuthGate();

    // a phone-blamed failure is read through the field: no live region at all
    setInputValue(inputByName(host, "username"), "12345");
    setInputValue(inputByName(host, "password"), "abcd");
    await submitForm(host);
    expect(host.querySelectorAll('[role="alert"]').length).toBe(0);

    // the next failure blames no field, so the summary must become the live
    // region and take focus — the role is a per-failure contract, not fixed
    signInResult = { error: { code: "INVALID_USERNAME_OR_PASSWORD", status: 401 } };
    setInputValue(inputByName(host, "username"), "0550123123");
    await submitForm(host);
    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe(i18n.t("AUTH_INVALID_CREDENTIALS"));
    expect(document.activeElement).toBe(alert);
  });
});

describe("login normalises Arabic-Indic phone digits (issue #108)", () => {
  it("types raw Arabic-Indic digits into the real form and signs in with the canonical username", async () => {
    needsSetup = false;
    signInResult = { error: { code: "INVALID_USERNAME_OR_PASSWORD", status: 401 } };
    const host = await mountAuthGate();

    // the owner types the numerals their Arabic keyboard produces
    setInputValue(inputByName(host, "username"), "٠٥٥٠١٢٣١٢٣");
    setInputValue(inputByName(host, "password"), "any-password");
    await submitForm(host);

    // if the form stopped normalising, the attempt would be refused as an
    // invalid phone (signInCalls 0) — exactly the #108 lockout this guards
    expect(signInCalls).toBe(1);
    expect(signInArgs?.username).toBe("213550123123");
    expect(host.querySelector('[role="alert"]')?.textContent).not.toBe(i18n.t("INVALID_PHONE_NUMBER"));
  });
});

describe("setup names the field (issue #100)", () => {
  it("setup: a three-character password is rejected in Arabic without a request", async () => {
    needsSetup = true;
    const host = await mountAuthGate();

    // names valid: the password is the first failing rule, which is what this
    // test pins (the names have their own #109 coverage)
    setInputValue(inputByName(host, "ownerName"), "مالك");
    setInputValue(inputByName(host, "storeName"), "متجر");
    setInputValue(inputByName(host, "phone"), "0550123123");
    setInputValue(inputByName(host, "password"), "abc");
    await submitForm(host);

    const alert = host.querySelector("#setup-error");
    expect(alert?.textContent).toBe(i18n.t("AUTH_PASSWORD_TOO_SHORT"));
    expect(alert?.getAttribute("role")).toBeNull();
    expect(inputByName(host, "password").getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(inputByName(host, "password"));
    expect(firstTimeSetupCalls).toBe(0);
  });

  it("setup: exactly four characters is accepted and reaches the api", async () => {
    needsSetup = true;
    const host = await mountAuthGate();

    setInputValue(inputByName(host, "ownerName"), "مالك");
    setInputValue(inputByName(host, "storeName"), "متجر");
    // a grouped, prefixed form that the shared normalizer accepts: it must not
    // be over-rejected by the new pre-submit check
    setInputValue(inputByName(host, "phone"), "00213 550 123 123");
    setInputValue(inputByName(host, "password"), "abcd");
    await submitForm(host);

    expect(firstTimeSetupCalls).toBe(1);
    expect(host.querySelector("#setup-error")).toBeNull();
  });
});

describe("auth forms take over the browser's validation (issue #109)", () => {
  it("login: the form is noValidate and an empty phone shows Arabic without a request", async () => {
    needsSetup = false;
    const host = await mountAuthGate();
    expect(host.querySelector("form")?.noValidate).toBe(true);

    await submitForm(host);

    const alert = host.querySelector("#login-error");
    expect(alert?.textContent).toBe(i18n.t("INVALID_PHONE_NUMBER"));
    expect(alert?.getAttribute("role")).toBeNull();
    expect(signInCalls).toBe(0);
    const phone = inputByName(host, "username");
    expect(phone.getAttribute("aria-invalid")).toBe("true");
    expect(phone.getAttribute("aria-describedby")).toBe("login-error");
    expect(document.activeElement).toBe(phone);
  });

  it("login: an empty password shows the Arabic short-password message without a request", async () => {
    needsSetup = false;
    const host = await mountAuthGate();

    setInputValue(inputByName(host, "username"), "0550123123");
    await submitForm(host);

    const alert = host.querySelector("#login-error");
    expect(alert?.textContent).toBe(i18n.t("AUTH_PASSWORD_TOO_SHORT"));
    expect(alert?.getAttribute("role")).toBeNull();
    expect(signInCalls).toBe(0);
    const password = inputByName(host, "password");
    expect(password.getAttribute("aria-invalid")).toBe("true");
    expect(password.getAttribute("aria-describedby")).toBe("login-error");
    expect(document.activeElement).toBe(password);
  });

  it("setup: empty and whitespace names are refused in Arabic before any request", async () => {
    needsSetup = true;
    const host = await mountAuthGate();
    expect(host.querySelector("form")?.noValidate).toBe(true);

    // phone and password valid: only the names are missing
    setInputValue(inputByName(host, "phone"), "0550123123");
    setInputValue(inputByName(host, "password"), "abcd");
    await submitForm(host);

    let alert = host.querySelector("#setup-error");
    expect(alert?.textContent).toBe("اكتب اسم المالك.");
    expect(alert?.getAttribute("role")).toBeNull();
    const owner = inputByName(host, "ownerName");
    expect(owner.getAttribute("aria-invalid")).toBe("true");
    expect(owner.getAttribute("aria-describedby")).toBe("setup-error");
    expect(document.activeElement).toBe(owner);
    expect(firstTimeSetupCalls).toBe(0);

    // a whitespace-only owner name is still empty (the api trims it)
    setInputValue(owner, "   ");
    await submitForm(host);
    alert = host.querySelector("#setup-error");
    expect(alert?.textContent).toBe("اكتب اسم المالك.");
    expect(alert?.getAttribute("role")).toBeNull();
    expect(firstTimeSetupCalls).toBe(0);

    // filling the owner moves the blame to the store name
    setInputValue(owner, "مالك");
    await submitForm(host);
    alert = host.querySelector("#setup-error");
    expect(alert?.textContent).toBe("اكتب اسم المتجر.");
    expect(alert?.getAttribute("role")).toBeNull();
    const store = inputByName(host, "storeName");
    expect(store.getAttribute("aria-invalid")).toBe("true");
    expect(store.getAttribute("aria-describedby")).toBe("setup-error");
    expect(document.activeElement).toBe(store);
    expect(firstTimeSetupCalls).toBe(0);
  });

  it("setup: a whitespace-only store name is refused too", async () => {
    needsSetup = true;
    const host = await mountAuthGate();

    setInputValue(inputByName(host, "ownerName"), "مالك");
    setInputValue(inputByName(host, "storeName"), "   ");
    setInputValue(inputByName(host, "phone"), "0550123123");
    setInputValue(inputByName(host, "password"), "abcd");
    await submitForm(host);

    const alert = host.querySelector("#setup-error");
    expect(alert?.textContent).toBe("اكتب اسم المتجر.");
    expect(alert?.getAttribute("role")).toBeNull();
    expect(firstTimeSetupCalls).toBe(0);
  });

  it("setup: the valid path still reaches the api", async () => {
    needsSetup = true;
    const host = await mountAuthGate();

    setInputValue(inputByName(host, "ownerName"), "مالك");
    setInputValue(inputByName(host, "storeName"), "متجر");
    setInputValue(inputByName(host, "phone"), "0550123123");
    setInputValue(inputByName(host, "password"), "abcd");
    await submitForm(host);

    expect(host.querySelector("#setup-error")).toBeNull();
    expect(firstTimeSetupCalls).toBe(1);
  });
});

describe("auth transport failures stay calm (issue #100)", () => {
  it("a thrown sign-in call names no crash and releases the button", async () => {
    needsSetup = false;
    signInThrows = true;
    const host = await mountAuthGate();

    setInputValue(inputByName(host, "username"), "0550123123");
    setInputValue(inputByName(host, "password"), "any-password");
    await submitForm(host);

    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe(i18n.t("errorGeneric"));
    expect(alert?.textContent).not.toBe(i18n.t("unexpected"));
    const submit = host.querySelector<HTMLButtonElement>('[data-testid="login-submit"]');
    expect(submit?.disabled).toBe(false);
  });

  it("a setup conflict the api names is translated, not called unexpected", async () => {
    needsSetup = true;
    setupError = new Error("SETUP_ALREADY_DONE");
    const host = await mountAuthGate();

    setInputValue(inputByName(host, "ownerName"), "مالك");
    setInputValue(inputByName(host, "storeName"), "متجر");
    setInputValue(inputByName(host, "phone"), "0550123123");
    setInputValue(inputByName(host, "password"), "abcd");
    await submitForm(host);

    // SETUP_ALREADY_DONE hands off to the login form and the notice is reported
    // there, so the summary is the login page's live region
    const alert = host.querySelector("#login-error");
    expect(alert?.getAttribute("role")).toBe("alert");
    expect(host.querySelectorAll('[role="alert"]').length).toBe(1);
    expect(alert?.textContent).toBe(i18n.t("SETUP_ALREADY_DONE"));
    expect(alert?.textContent).not.toBe(i18n.t("unexpected"));
    expect(firstTimeSetupCalls).toBe(1);
    // the message says "sign in", so the form that can do it must be on screen,
    // and the removed secret/reset entry points must not come back
    expect(host.querySelector('[data-testid="login-submit"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="setup-secret"]')).toBeNull();
    expect(host.querySelector('[data-testid="forgot-password"]')).toBeNull();
  });

  it("a locked setup names the lockout on the form", async () => {
    needsSetup = true;
    setupError = new Error("SETUP_LOCKED");
    const host = await mountAuthGate();

    setInputValue(inputByName(host, "ownerName"), "مالك");
    setInputValue(inputByName(host, "storeName"), "متجر");
    setInputValue(inputByName(host, "phone"), "0550123123");
    setInputValue(inputByName(host, "password"), "abcd");
    await submitForm(host);

    const alert = host.querySelector("#setup-error");
    expect(alert?.getAttribute("role")).toBe("alert");
    expect(host.querySelectorAll('[role="alert"]').length).toBe(1);
    expect(alert?.textContent).toBe(i18n.t("SETUP_LOCKED"));
    expect(alert?.textContent).not.toBe(i18n.t("unexpected"));
    expect(firstTimeSetupCalls).toBe(1);
    // still the setup form: the owner waits and retries there
    expect(host.querySelector('[data-testid="login-submit"]')).toBeNull();
  });

  it("clears a stale field error as soon as the owner corrects that field", async () => {
    needsSetup = false;
    const host = await mountAuthGate();

    // a too-short password is the password field's problem (the validator's own
    // sentence, which is what the api actually emits)
    signInResult = { error: { message: "Too small: expected string to have >=4 characters" } };
    setInputValue(inputByName(host, "username"), "0550123123");
    setInputValue(inputByName(host, "password"), "ab");
    await submitForm(host);
    const password = inputByName(host, "password");
    const alert = host.querySelector("#login-error");
    expect(alert?.textContent).toBe(i18n.t("AUTH_PASSWORD_TOO_SHORT"));
    expect(alert?.getAttribute("role")).toBeNull();
    expect(password.getAttribute("aria-invalid")).toBe("true");

    // typing the correction drops the alert and the invalid marking with it
    setInputValue(password, "abcd");
    expect(host.querySelector("#login-error")).toBeNull();
    expect(password.getAttribute("aria-invalid")).toBe("false");

    // a phone error survives an edit to the password, and clears on its own
    setInputValue(inputByName(host, "username"), "12345");
    await submitForm(host);
    const phone = inputByName(host, "username");
    expect(phone.getAttribute("aria-invalid")).toBe("true");
    setInputValue(password, "another-password");
    expect(phone.getAttribute("aria-invalid")).toBe("true");
    setInputValue(phone, "0550123123");
    expect(host.querySelector("#login-error")).toBeNull();
  });

  it("a second submit while the first is in flight does not double-fire", async () => {
    needsSetup = false;
    signInDelayMs = 50;
    const host = await mountAuthGate();

    setInputValue(inputByName(host, "username"), "0550123123");
    setInputValue(inputByName(host, "password"), "any-password");
    const form = host.querySelector("form");
    if (form === null) throw new Error("no form");
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await new Promise((resolve) => setTimeout(resolve, 80));
    });

    expect(signInCalls).toBe(1);
  });
});

describe("RequireSession preference migration (issue #97 follow-up)", () => {
  function SidebarProbe() {
    const { value } = useSidebarCollapsed();
    return <span data-testid="sidebar-value">{String(value)}</span>;
  }

  function SidebarWriter() {
    const { setValue } = useSidebarCollapsed();
    return (
      <button type="button" data-testid="sidebar-write" onClick={() => setValue(true)}>
        write
      </button>
    );
  }

  /**
   * Mount the migration with the legacy sidebar value seeded, the migration
   * read and the owner's competing write both held, and exactly that write
   * configured to fail. The caller releases the two gates in the order the
   * scenario needs — sequentially (round 1) or in the same turn (round 2).
   */
  async function mountHeldSidebarImport(legacy: string): Promise<{
    client: QueryClient;
    releaseRead: () => void;
    releaseWrite: () => void;
  }> {
    sessionData = { user: { id: "u1" } };
    // the legacy value the import must recover
    window.localStorage.setItem("dokan.sidebar.collapsed", legacy);

    // hold the migration read so the owner's write is issued first...
    let releaseRead = () => {};
    preferenceReadGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    // ...hold that write so the migration observes it in flight...
    let releaseWrite = () => {};
    preferenceWriteGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    // ...and fail exactly that write, so the retry can succeed
    failPreferenceWriteCount = 1;

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    mounted.push({ root, host });
    await act(async () => {
      renderWithClient(
        root,
        <RequireSession>
          <SidebarWriter />
        </RequireSession>,
        client,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    // the owner toggles while the migration read is still held
    await act(async () => {
      host.querySelector<HTMLButtonElement>("[data-testid='sidebar-write']")?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    return { client, releaseRead, releaseWrite };
  }

  it("renders the shell immediately and surfaces the imported value in the background", async () => {
    sessionData = { user: { id: "u1" } };
    window.localStorage.setItem("dokan.sidebar.collapsed", "true");
    let releaseRead = () => {};
    preferenceReadGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    mounted.push({ root, host });
    await act(async () => {
      renderWithClient(
        root,
        <RequireSession>
          <SidebarProbe />
        </RequireSession>,
        client,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    // the shell is never blocked on the migration read (the scanner mounts)
    expect(host.querySelector("[data-testid='sidebar-value']")).not.toBeNull();

    releaseRead();
    for (
      let attempt = 0;
      attempt < 50 && host.querySelector("[data-testid='sidebar-value']")?.textContent !== "true";
      attempt += 1
    ) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    expect(preferenceStore[SIDEBAR_COLLAPSED_KEY]).toBe("true");
    expect(host.querySelector("[data-testid='sidebar-value']")?.textContent).toBe("true");
    expect(window.localStorage.getItem("dokan.sidebar.collapsed")).toBeNull();
  });

  it("runs the background import only once per mount", async () => {
    sessionData = { user: { id: "u1" } };
    window.localStorage.setItem("dokan.sidebar.collapsed", "true");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    mounted.push({ root, host });
    await act(async () => {
      renderWithClient(
        root,
        <RequireSession>
          <div data-testid="shell" />
        </RequireSession>,
        client,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    for (let attempt = 0; attempt < 50 && preferenceStore[SIDEBAR_COLLAPSED_KEY] !== "true"; attempt += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    const callsAfterImport = preferenceReadCalls;
    expect(callsAfterImport).toBe(1);

    // a session identity change re-runs the effect; the one-shot ref skips it
    sessionData = { user: { id: "u1" } };
    await act(async () => {
      renderWithClient(
        root,
        <RequireSession>
          <div data-testid="shell" />
        </RequireSession>,
        client,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(preferenceReadCalls).toBe(callsAfterImport);
  });

  it("re-runs the import when the owner's competing sidebar write fails (issue #115)", async () => {
    const { client, releaseRead, releaseWrite } = await mountHeldSidebarImport("false");

    // release the read: the migration sees the competing write and skips
    releaseRead();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(preferenceStore[SIDEBAR_COLLAPSED_KEY]).toBeUndefined();
    expect(window.localStorage.getItem("dokan.sidebar.collapsed")).toBe("false");

    // the competing write fails; the settled-write subscription re-runs the
    // import so the sidebar does not fall back to the default until next launch
    releaseWrite();
    for (
      let attempt = 0;
      attempt < 50 && preferenceStore[SIDEBAR_COLLAPSED_KEY] !== "false";
      attempt += 1
    ) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    expect(preferenceStore[SIDEBAR_COLLAPSED_KEY]).toBe("false");
    expect(window.localStorage.getItem("dokan.sidebar.collapsed")).toBeNull();
    client.clear();
  });

  it("remembers a retry that arrives while the import is still settling (issue #115 round 2)", async () => {
    const { client, releaseRead, releaseWrite } = await mountHeldSidebarImport("false");

    // release the read and fail the competing write in the same turn: the read
    // settles first (the migration skips for the in-flight write) and the
    // failure listener then runs before the migration's `finally` clears
    // `importing`; the retry must be remembered, not dropped. The two orderings
    // are behaviourally identical at the end, so the discrimination evidence is
    // the mutation (drop `retryPending` → this test fails), not an assertion.
    await act(async () => {
      releaseRead();
      releaseWrite();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    for (
      let attempt = 0;
      attempt < 50 && preferenceStore[SIDEBAR_COLLAPSED_KEY] !== "false";
      attempt += 1
    ) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
    }
    expect(preferenceStore[SIDEBAR_COLLAPSED_KEY]).toBe("false");
    expect(window.localStorage.getItem("dokan.sidebar.collapsed")).toBeNull();
    client.clear();
  });
});
