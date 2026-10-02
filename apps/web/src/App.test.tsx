import { afterEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import i18n, { type AuthErrorInput } from "./lib/i18n";
import { SIDEBAR_COLLAPSED_KEY, useSidebarCollapsed } from "./components/app/sidebar-state";

let needsSetup = false;
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
let setupError: Error | null = null;

// issue #97 follow-up: the shell's preference migration
let sessionData: { user: { id: string } } | null = null;
let sessionPending = false;
let preferenceStore: Record<string, string> = {};
let preferenceReadGate: Promise<void> | null = null;
let preferenceReadCalls = 0;

mock.module("@/lib/rpc", () => ({
  rpcClient: {
    needsSetup: async () => ({ needsSetup }),
    firstTimeSetup: async () => {
      firstTimeSetupCalls += 1;
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

afterEach(() => {
  for (const entry of mounted) act(() => entry.root.unmount());
  mounted = [];
  document.body.innerHTML = "";
  needsSetup = false;
  signInResult = { error: null };
  signInArgs = null;
  signInCalls = 0;
  signInThrows = false;
  signInDelayMs = 0;
  firstTimeSetupCalls = 0;
  setupError = null;
  sessionData = null;
  sessionPending = false;
  preferenceStore = {};
  preferenceReadGate = null;
  preferenceReadCalls = 0;
  window.localStorage.clear();
});

function renderWithClient(root: ReturnType<typeof createRoot>, ui: React.ReactElement, client: QueryClient): void {
  root.render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

async function mountAuthGate(): Promise<HTMLElement> {
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
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (host.querySelector("form") !== null) return host;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
  }
  throw new Error("auth gate did not render a form");
}

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

describe("login failures name the problem (issue #100)", () => {
  it("a rejected password shows the credentials message, not the generic one", async () => {
    needsSetup = false;
    signInResult = { error: { code: "INVALID_USERNAME_OR_PASSWORD", message: "Invalid username or password", status: 401 } };
    const host = await mountAuthGate();

    setInputValue(inputByName(host, "username"), "0550123123");
    setInputValue(inputByName(host, "password"), "wrong-password");
    await submitForm(host);

    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe(i18n.t("AUTH_INVALID_CREDENTIALS"));
    expect(alert?.textContent).not.toBe(i18n.t("unexpected"));
    expect(signInCalls).toBe(1);
    // the form posts the canonical username, not the raw local form
    expect(signInArgs?.username).toBe("213550123123");
    // the copy names both fields, so the summary carries the message and no
    // single field is blamed (the field's own aria-invalid would lie)
    expect(document.activeElement).toBe(host.querySelector('[role="alert"]'));
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

    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe(i18n.t("INVALID_PHONE_NUMBER"));
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
});

describe("setup names the field (issue #100)", () => {
  it("setup: a three-character password is rejected in Arabic without a request", async () => {
    needsSetup = true;
    const host = await mountAuthGate();

    setInputValue(inputByName(host, "phone"), "0550123123");
    setInputValue(inputByName(host, "password"), "abc");
    await submitForm(host);

    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe(i18n.t("AUTH_PASSWORD_TOO_SHORT"));
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
    expect(host.querySelector('[role="alert"]')).toBeNull();
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

    const alert = host.querySelector('[role="alert"]');
    expect(alert?.textContent).toBe(i18n.t("SETUP_ALREADY_DONE"));
    expect(alert?.textContent).not.toBe(i18n.t("unexpected"));
    expect(firstTimeSetupCalls).toBe(1);
    // the message says "sign in", so the form that can do it must be on screen,
    // and the removed secret/reset entry points must not come back
    expect(host.querySelector('[data-testid="login-submit"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="setup-secret"]')).toBeNull();
    expect(host.querySelector('[data-testid="forgot-password"]')).toBeNull();
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
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(i18n.t("AUTH_PASSWORD_TOO_SHORT"));
    expect(password.getAttribute("aria-invalid")).toBe("true");

    // typing the correction drops the alert and the invalid marking with it
    setInputValue(password, "abcd");
    expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(password.getAttribute("aria-invalid")).toBe("false");

    // a phone error survives an edit to the password, and clears on its own
    setInputValue(inputByName(host, "username"), "12345");
    await submitForm(host);
    const phone = inputByName(host, "username");
    expect(phone.getAttribute("aria-invalid")).toBe("true");
    setInputValue(password, "another-password");
    expect(phone.getAttribute("aria-invalid")).toBe("true");
    setInputValue(phone, "0550123123");
    expect(host.querySelector('[role="alert"]')).toBeNull();
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
});
