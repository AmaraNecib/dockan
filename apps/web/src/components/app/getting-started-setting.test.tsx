import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "../../lib/i18n"; // side-effect: initializes i18next (ar) for useTranslation
import {
  ONBOARDING_COMPLETED_KEY,
  ONBOARDING_DISMISSED_KEY,
} from "./onboarding-state";

let store: Record<string, string>;
let failRead = false;
let failWrite = false;
/** When set, only writes for this exact key fail. */
let failWriteFor: string | null = null;
let writeCalls = 0;

mock.module("@/lib/rpc", () => ({
  rpcClient: {
    preferencesGet: async () => {
      if (failRead) throw new Error("PREFERENCES_READ_FAILED");
      return { values: { ...store } };
    },
    preferencesSet: async (input: { key: string; value: string }) => {
      writeCalls += 1;
      if (failWrite || (failWriteFor !== null && input.key === failWriteFor)) {
        throw new Error("PREFERENCES_WRITE_FAILED");
      }
      store[input.key] = input.value;
      return { key: input.key, value: input.value };
    },
  },
  orpc: {},
}));

const { GettingStartedSetting } = await import("./getting-started-setting");

/**
 * Issue #115 — the settings escape hatch. The pin that matters is that turning
 * it on clears BOTH persisted flags: clearing only one leaves
 * `hidden = dismissed || completed` true and reproduces the one-way door.
 */

let mounted: Array<{ root: ReturnType<typeof createRoot>; host: HTMLElement }> = [];

afterEach(() => {
  for (const entry of mounted) act(() => entry.root.unmount());
  mounted = [];
  document.body.innerHTML = "";
});

function freshClient(): QueryClient {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function waitFor(check: () => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (check()) return true;
    await flush();
  }
  return false;
}

async function mount(client: QueryClient): Promise<{
  host: HTMLElement;
  toggle: () => HTMLInputElement | null;
  readError: () => HTMLElement | null;
  writeError: () => HTMLElement | null;
  unmount: () => Promise<void>;
}> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push({ root, host });
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <GettingStartedSetting />
      </QueryClientProvider>,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  return {
    host,
    toggle: () => host.querySelector<HTMLInputElement>("[data-testid='settings-getting-started-toggle']"),
    readError: () => host.querySelector<HTMLElement>("[data-testid='settings-getting-started-read-error']"),
    writeError: () => host.querySelector<HTMLElement>("[data-testid='settings-getting-started-write-error']"),
    unmount: async () => {
      await act(async () => root.unmount());
      // the module afterEach must not unmount the same root twice
      mounted = mounted.filter((entry) => entry.root !== root);
      host.remove();
    },
  };
}

describe("getting-started settings escape hatch (issue #115)", () => {
  let client: QueryClient;

  beforeEach(() => {
    store = {};
    failRead = false;
    failWrite = false;
    failWriteFor = null;
    writeCalls = 0;
    client = freshClient();
  });

  afterEach(() => {
    client.clear();
  });

  it("is on when neither flag is hidden", async () => {
    const page = await mount(client);
    expect(await waitFor(() => page.toggle()?.checked === true)).toBe(true);
    await page.unmount();
  });

  it("clears BOTH flags and returns to on", async () => {
    store[ONBOARDING_DISMISSED_KEY] = "true";
    store[ONBOARDING_COMPLETED_KEY] = "true";
    const page = await mount(client);
    // both flags hidden → the checklist is gone and the switch reads off
    expect(await waitFor(() => page.toggle()?.checked === false)).toBe(true);
    expect(await waitFor(() => page.toggle()?.disabled === false)).toBe(true);

    await act(async () => page.toggle()?.click());
    expect(await waitFor(() => store[ONBOARDING_COMPLETED_KEY] === "false")).toBe(true);
    expect(await waitFor(() => store[ONBOARDING_DISMISSED_KEY] === "false")).toBe(true);
    expect(await waitFor(() => page.toggle()?.checked === true)).toBe(true);
    await page.unmount();
  });

  it("clears the completion milestone even when only it is set", async () => {
    // the record-derived milestone alone keeps the checklist hidden; clearing
    // only `dismissed` here would reproduce the one-way door the issue reports
    store[ONBOARDING_COMPLETED_KEY] = "true";
    const page = await mount(client);
    expect(await waitFor(() => page.toggle()?.checked === false)).toBe(true);
    expect(await waitFor(() => page.toggle()?.disabled === false)).toBe(true);

    await act(async () => page.toggle()?.click());
    expect(await waitFor(() => store[ONBOARDING_COMPLETED_KEY] === "false")).toBe(true);
    expect(await waitFor(() => page.toggle()?.checked === true)).toBe(true);
    await page.unmount();
  });

  it("turning it off dismisses without touching the milestone", async () => {
    const page = await mount(client);
    expect(await waitFor(() => page.toggle()?.checked === true)).toBe(true);
    expect(await waitFor(() => page.toggle()?.disabled === false)).toBe(true);

    await act(async () => page.toggle()?.click());
    expect(await waitFor(() => store[ONBOARDING_DISMISSED_KEY] === "true")).toBe(true);
    expect(store[ONBOARDING_COMPLETED_KEY]).toBeUndefined();
    expect(await waitFor(() => page.toggle()?.checked === false)).toBe(true);
    await page.unmount();
  });

  it("surfaces a failed write and leaves the flags unchanged", async () => {
    store[ONBOARDING_DISMISSED_KEY] = "true";
    failWrite = true;
    const page = await mount(client);
    expect(await waitFor(() => page.toggle()?.checked === false)).toBe(true);
    expect(await waitFor(() => page.toggle()?.disabled === false)).toBe(true);

    await act(async () => page.toggle()?.click());
    expect(await waitFor(() => page.writeError() !== null)).toBe(true);
    expect(page.writeError()?.getAttribute("role")).toBe("alert");
    // the control actually attempted both writes, and did not claim success
    expect(writeCalls).toBe(2);
    // no false claim: the server value still stands on screen
    expect(store[ONBOARDING_DISMISSED_KEY]).toBe("true");
    expect(page.toggle()?.checked).toBe(false);
    await page.unmount();
  });

  it("surfaces a half-applied clear instead of reading it as success", async () => {
    store[ONBOARDING_DISMISSED_KEY] = "true";
    store[ONBOARDING_COMPLETED_KEY] = "true";
    // fail only the `dismissed` clear, after `completed` landed
    failWriteFor = ONBOARDING_DISMISSED_KEY;
    const page = await mount(client);
    expect(await waitFor(() => page.toggle()?.checked === false)).toBe(true);
    expect(await waitFor(() => page.toggle()?.disabled === false)).toBe(true);

    await act(async () => page.toggle()?.click());
    expect(await waitFor(() => store[ONBOARDING_COMPLETED_KEY] === "false")).toBe(true);
    // the second flag did not land, so the panel is still hidden and the owner
    // is told (the retry converges because both writes are idempotent)
    expect(store[ONBOARDING_DISMISSED_KEY]).toBe("true");
    expect(await waitFor(() => page.writeError() !== null)).toBe(true);
    expect(page.toggle()?.checked).toBe(false);
    await page.unmount();
  });

  it("disables the control and says so when the read fails", async () => {
    failRead = true;
    const page = await mount(client);
    expect(await waitFor(() => page.readError() !== null)).toBe(true);
    expect(page.readError()?.getAttribute("role")).toBe("alert");
    expect(page.toggle()?.disabled).toBe(true);
    await page.unmount();
  });

  it("keeps the switched-on choice across a remount (server, not session state)", async () => {
    store[ONBOARDING_DISMISSED_KEY] = "true";
    store[ONBOARDING_COMPLETED_KEY] = "true";
    const first = await mount(client);
    expect(await waitFor(() => first.toggle()?.checked === false)).toBe(true);
    expect(await waitFor(() => first.toggle()?.disabled === false)).toBe(true);
    await act(async () => first.toggle()?.click());
    expect(await waitFor(() => first.toggle()?.checked === true)).toBe(true);
    await first.unmount();

    const remounted = await mount(freshClient());
    expect(await waitFor(() => remounted.toggle()?.checked === true)).toBe(true);
    await remounted.unmount();
  });
});
