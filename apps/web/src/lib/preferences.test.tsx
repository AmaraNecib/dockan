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
let firstReadGate: Promise<void> | null = null;

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
  for (let attempt = 0; attempt < 50; attempt++) {
    if (check()) return true;
    await flush();
  }
  return false;
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

    expect(await waitFor(() => handle.host.querySelector("[data-testid='pending']")?.textContent === "false")).toBe(true);
    expect(handle.host.querySelector("[data-testid='a']")?.textContent).toBe("true");

    store["ui.test.a"] = "false";
    await act(async () => handle.host.querySelector<HTMLButtonElement>("[data-testid='set-a']")?.click());
    expect(await waitFor(() => handle.host.querySelector("[data-testid='a']")?.textContent === "true")).toBe(true);
    expect(await waitFor(() => store["ui.test.a"] === "true")).toBe(true);

    await handle.unmount();
  });

  it("keeps the in-memory value when the write fails", async () => {
    failWrite = true;
    const handle = await mountProbe();
    expect(await waitFor(() => handle.host.querySelector("[data-testid='pending']")?.textContent === "false")).toBe(true);

    await act(async () => handle.host.querySelector<HTMLButtonElement>("[data-testid='set-a']")?.click());
    expect(await waitFor(() => handle.host.querySelector("[data-testid='a']")?.textContent === "true")).toBe(true);
    expect(store["ui.test.a"]).toBeUndefined();

    await handle.unmount();
  });

  it("re-fetches an errored read on the next mount (self-heal)", async () => {
    failRead = true;
    const failed = await mountProbe();
    expect(await waitFor(() => failed.host.querySelector("[data-testid='pending']")?.textContent === "false")).toBe(true);
    expect(failed.host.querySelector("[data-testid='a']")?.textContent).toBe("false");
    await failed.unmount();

    failRead = false;
    store["ui.test.a"] = "true";
    const healed = await mountProbe();
    expect(await waitFor(() => healed.host.querySelector("[data-testid='a']")?.textContent === "true")).toBe(true);
    await healed.unmount();
  });

  it("does not drop sibling preferences when a write races the initial read", async () => {
    store["ui.sibling.flag"] = "true";
    let releaseFirstRead = () => {};
    firstReadGate = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });

    const handle = await mountProbe();
    // the first read is held; write before it settles
    await act(async () => handle.host.querySelector<HTMLButtonElement>("[data-testid='set-a']")?.click());
    releaseFirstRead();

    expect(await waitFor(() => handle.host.querySelector("[data-testid='a']")?.textContent === "true")).toBe(true);
    expect(await waitFor(() => handle.host.querySelector("[data-testid='sibling']")?.textContent === "true")).toBe(true);
    await handle.unmount();
  });

  it("toggles from the latest cached value", async () => {
    const handle = await mountProbe();
    expect(await waitFor(() => handle.host.querySelector("[data-testid='pending']")?.textContent === "false")).toBe(true);

    await act(async () => handle.host.querySelector<HTMLButtonElement>("[data-testid='toggle-a']")?.click());
    expect(await waitFor(() => handle.host.querySelector("[data-testid='a']")?.textContent === "true")).toBe(true);
    expect(await waitFor(() => store["ui.test.a"] === "true")).toBe(true);

    await handle.unmount();
  });
});
