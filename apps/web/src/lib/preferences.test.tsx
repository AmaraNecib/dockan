import { beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider, focusManager } from "@tanstack/react-query";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let store: Record<string, string>;
let failRead = false;
let failWrite = false;
let firstReadGate: Promise<void> | null = null;
let firstWriteGate: Promise<void> | null = null;

mock.module("@/lib/rpc", () => ({
  rpcClient: {
    preferencesGet: async () => {
      if (failRead) throw new Error("PREFERENCES_READ_FAILED");
      if (firstReadGate !== null) {
        const gate = firstReadGate;
        firstReadGate = null;
        await gate;
      }
      return { values: { ...store } };
    },
    preferencesSet: async (input: { key: string; value: string }) => {
      if (failWrite) throw new Error("PREFERENCES_WRITE_FAILED");
      if (firstWriteGate !== null) {
        const gate = firstWriteGate;
        firstWriteGate = null;
        await gate;
      }
      store[input.key] = input.value;
      return { key: input.key, value: input.value };
    },
  },
  orpc: {},
}));

const {
  parseBooleanPreference,
  readPreference,
  readPreferences,
  serializeBooleanPreference,
  usePreference,
  writePreference,
} = await import("./preferences");

function Probe() {
  const a = usePreference("ui.test.a", false, parseBooleanPreference, serializeBooleanPreference);
  const sibling = usePreference("ui.sibling.flag", false, parseBooleanPreference, serializeBooleanPreference);
  return (
    <div>
      <span data-testid="a">{String(a.value)}</span>
      <span data-testid="sibling">{String(sibling.value)}</span>
      <span data-testid="pending">{String(a.isPending || sibling.isPending)}</span>
      <button data-testid="set-a" onClick={() => a.setValue(true)}>set-a</button>
      <button data-testid="toggle-a" onClick={() => a.updateValue((value) => !value)}>toggle-a</button>
    </div>
  );
}

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function waitFor(check: () => boolean): Promise<boolean> {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (check()) return true;
    await flush();
  }
  return false;
}

function text(host: HTMLElement, testId: string): string | null {
  return host.querySelector(`[data-testid='${testId}']`)?.textContent ?? null;
}

interface ProbeHandle {
  host: HTMLElement;
  client: QueryClient;
  unmount: () => Promise<void>;
}

async function mountProbe(): Promise<ProbeHandle> {
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
  return {
    host,
    client,
    unmount: async () => {
      await act(async () => root.unmount());
      client.clear();
      host.remove();
    },
  };
}

describe("preferences client (issue 97 follow-up)", () => {
  beforeEach(() => {
    store = {};
    failRead = false;
    failWrite = false;
    firstReadGate = null;
    firstWriteGate = null;
    focusManager.setFocused(undefined);
  });

  it("surfaces a failed read so the query can retry later", async () => {
    failRead = true;
    await expect(readPreferences()).rejects.toThrow("PREFERENCES_READ_FAILED");
  });

  it("falls back to undefined for the imperative read guard", async () => {
    failRead = true;
    expect(await readPreference("ui.test.a")).toBeUndefined();
  });

  it("reports a failed write without throwing", async () => {
    failWrite = true;
    expect(await writePreference("ui.test.a", "true")).toBe(false);
  });

  it("writes a preference and reports success", async () => {
    expect(await writePreference("ui.test.a", "true")).toBe(true);
    expect(store["ui.test.a"]).toBe("true");
  });

  it("parses only the explicit true flag", () => {
    expect(parseBooleanPreference("true")).toBe(true);
    expect(parseBooleanPreference("false")).toBe(false);
    expect(parseBooleanPreference("legacy")).toBe(false);
    expect(parseBooleanPreference(undefined)).toBe(false);
    expect(serializeBooleanPreference(true)).toBe("true");
    expect(serializeBooleanPreference(false)).toBe("false");
  });

  it("reads the server value and writes one key optimistically", async () => {
    store["ui.test.a"] = "true";
    const handle = await mountProbe();

    expect(await waitFor(() => text(handle.host, "pending") === "false")).toBe(true);
    expect(text(handle.host, "a")).toBe("true");

    store["ui.test.a"] = "false";
    await act(async () => handle.host.querySelector<HTMLButtonElement>("[data-testid='set-a']")?.click());
    expect(await waitFor(() => text(handle.host, "a") === "true")).toBe(true);
    expect(await waitFor(() => store["ui.test.a"] === "true")).toBe(true);

    await handle.unmount();
  });

  it("reverts the optimistic value when the write ultimately fails", async () => {
    failWrite = true;
    const handle = await mountProbe();
    expect(await waitFor(() => text(handle.host, "pending") === "false")).toBe(true);

    await act(async () => handle.host.querySelector<HTMLButtonElement>("[data-testid='set-a']")?.click());
    // optimistic: the click shows immediately, then the retries exhaust
    expect(await waitFor(() => text(handle.host, "a") === "true")).toBe(true);
    expect(await waitFor(() => text(handle.host, "a") === "false")).toBe(true);
    expect(store["ui.test.a"]).toBeUndefined();

    await handle.unmount();
  });

  it("re-fetches an errored read on the next mount (self-heal)", async () => {
    failRead = true;
    const failed = await mountProbe();
    expect(await waitFor(() => text(failed.host, "pending") === "false")).toBe(true);
    expect(text(failed.host, "a")).toBe("false");
    await failed.unmount();

    failRead = false;
    store["ui.test.a"] = "true";
    const healed = await mountProbe();
    expect(await waitFor(() => text(healed.host, "a") === "true")).toBe(true);
    await healed.unmount();
  });

  it("does not drop sibling preferences when a write races the initial read", async () => {
    store["ui.sibling.flag"] = "true";
    let releaseFirstRead = () => {};
    firstReadGate = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });

    const handle = await mountProbe();
    await act(async () => handle.host.querySelector<HTMLButtonElement>("[data-testid='set-a']")?.click());
    releaseFirstRead();

    expect(await waitFor(() => text(handle.host, "a") === "true")).toBe(true);
    expect(await waitFor(() => text(handle.host, "sibling") === "true")).toBe(true);
    await handle.unmount();
  });

  it("never leaves the cache partial when a write races the initial read and fails", async () => {
    store["ui.sibling.flag"] = "true";
    failWrite = true;
    let releaseFirstRead = () => {};
    firstReadGate = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });

    const handle = await mountProbe();
    await act(async () => handle.host.querySelector<HTMLButtonElement>("[data-testid='set-a']")?.click());
    releaseFirstRead();

    // the sibling survives the full read, and the rejected write is not claimed
    expect(await waitFor(() => text(handle.host, "sibling") === "true")).toBe(true);
    expect(await waitFor(() => text(handle.host, "a") === "false")).toBe(true);
    expect(store["ui.test.a"]).toBeUndefined();
    await handle.unmount();
  });

  it("applies rapid toggles in order and settles on the last intent", async () => {
    const handle = await mountProbe();
    expect(await waitFor(() => text(handle.host, "pending") === "false")).toBe(true);

    await act(async () => {
      const toggle = handle.host.querySelector<HTMLButtonElement>("[data-testid='toggle-a']");
      toggle?.click();
      toggle?.click();
    });
    expect(await waitFor(() => store["ui.test.a"] === "false")).toBe(true);
    expect(await waitFor(() => text(handle.host, "a") === "false")).toBe(true);

    await handle.unmount();
  });

  it("serialises writes so an earlier choice cannot land after a later one", async () => {
    let releaseFirstWrite = () => {};
    firstWriteGate = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });

    const handle = await mountProbe();
    expect(await waitFor(() => text(handle.host, "pending") === "false")).toBe(true);

    await act(async () => {
      const toggle = handle.host.querySelector<HTMLButtonElement>("[data-testid='toggle-a']");
      toggle?.click(); // true, held by the gate
      toggle?.click(); // false, queued behind the held write
    });
    releaseFirstWrite();

    expect(await waitFor(() => store["ui.test.a"] === "false")).toBe(true);
    expect(await waitFor(() => text(handle.host, "a") === "false")).toBe(true);
    await handle.unmount();
  });

  it("picks up a preference changed outside this window on focus", async () => {
    const handle = await mountProbe();
    expect(await waitFor(() => text(handle.host, "pending") === "false")).toBe(true);
    expect(text(handle.host, "a")).toBe("false");

    store["ui.test.a"] = "true"; // another window wrote it
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(await waitFor(() => text(handle.host, "a") === "true")).toBe(true);
    await handle.unmount();
  });
});
