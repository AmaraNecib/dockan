import { beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let store: Record<string, string>;
let failRead = false;
let failWrite = false;

mock.module("@/lib/rpc", () => ({
  rpcClient: {
    preferencesGet: async () => {
      if (failRead) throw new Error("PREFERENCES_READ_FAILED");
      return { values: { ...store } };
    },
    preferencesSet: async (input: { key: string; value: string }) => {
      if (failWrite) throw new Error("PREFERENCES_WRITE_FAILED");
      store[input.key] = input.value;
      return { key: input.key, value: input.value };
    },
  },
  orpc: {},
}));

const { readPreferences, writePreference, usePreference } = await import("./preferences");

function Probe() {
  const pref = usePreference("ui.test.flag", false, (raw) => raw === "true", (value) => String(value));
  return (
    <div>
      <span data-testid="value">{String(pref.value)}</span>
      <span data-testid="pending">{String(pref.isPending)}</span>
      <button data-testid="set" onClick={() => pref.setValue(true)}>set</button>
    </div>
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function waitFor(check: () => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (check()) return true;
    await flush();
  }
  return false;
}

describe("preferences client (issue 97 follow-up)", () => {
  beforeEach(() => {
    store = {};
    failRead = false;
    failWrite = false;
  });

  it("returns an empty map when the read fails (guard, never throws)", async () => {
    failRead = true;
    expect(await readPreferences()).toEqual({});
  });

  it("does not throw when the write fails (guard, never throws)", async () => {
    failWrite = true;
    await expect(writePreference("ui.test.flag", "true")).resolves.toBeUndefined();
  });

  it("reads the server value and writes one key optimistically", async () => {
    store["ui.test.flag"] = "true";
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Probe />
        </QueryClientProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    expect(await waitFor(() => host.querySelector("[data-testid='pending']")?.textContent === "false")).toBe(true);
    expect(host.querySelector("[data-testid='value']")?.textContent).toBe("true");

    store["ui.test.flag"] = "false";
    await act(async () => host.querySelector<HTMLButtonElement>("[data-testid='set']")?.click());
    expect(await waitFor(() => host.querySelector("[data-testid='value']")?.textContent === "true")).toBe(true);
    expect(await waitFor(() => store["ui.test.flag"] === "true")).toBe(true);

    await act(async () => root.unmount());
    client.clear();
    host.remove();
  });

  it("keeps the in-memory value when the write fails", async () => {
    failWrite = true;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Probe />
        </QueryClientProvider>,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(await waitFor(() => host.querySelector("[data-testid='pending']")?.textContent === "false")).toBe(true);

    await act(async () => host.querySelector<HTMLButtonElement>("[data-testid='set']")?.click());
    expect(await waitFor(() => host.querySelector("[data-testid='value']")?.textContent === "true")).toBe(true);
    expect(store["ui.test.flag"]).toBeUndefined();

    await act(async () => root.unmount());
    client.clear();
    host.remove();
  });
});
