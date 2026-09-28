import { afterEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import i18n from "./lib/i18n";

let needsSetup = false;
/** The better-auth error shape the login page maps (code/message/status). */
type AuthErrorStub = { code?: string; message?: string; status?: number };
type SignInResult = { error: AuthErrorStub | null };
let signInResult: SignInResult = { error: null };
let signInCalls = 0;

mock.module("@/lib/rpc", () => ({
  rpcClient: {
    needsSetup: async () => ({ needsSetup }),
    firstTimeSetup: async () => ({}),
    authResetPassword: async () => ({}),
  },
  orpc: {},
}));

mock.module("@/lib/auth-client", () => ({
  useSession: () => ({ data: null, isPending: false }),
  authClient: {
    signIn: {
      username: async () => {
        signInCalls += 1;
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
  signInResult = { error: null };
  signInCalls = 0;
});

async function mountAuthGate(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => {
    root.render(<RequireSession>{null}</RequireSession>);
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
    // either field could be the typo, so the summary takes focus
    expect(document.activeElement).toBe(alert);
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
    expect(document.activeElement).toBe(inputByName(host, "username"));
    expect(signInCalls).toBe(0);
  });
});
