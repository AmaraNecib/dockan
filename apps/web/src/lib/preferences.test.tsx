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
let writeCalls = 0;
let writeGate: Promise<void> | null = null;
/** Mimics a server that normalizes the value: the hook must use the echo. */
let canonicalize: ((value: string) => string) | null = null;

mock.module("@/lib/rpc", () => ({
  rpcClient: {
    preferencesGet: async () => {
      if (failRead) throw new Error("PREFERENCES_READ_FAILED");
      return { values: { ...store } };
    },
    preferencesSet: async (input: { key: string; value: string }) => {
      writeCalls += 1;
      if (failWrite) throw new Error("PREFERENCES_WRITE_FAILED");
      if (writeGate !== null) {
        const gate = writeGate;
        writeGate = null;
        await gate;
      }
      const stored = canonicalize !== null ? canonicalize(input.value) : input.value;
      store[input.key] = stored;
      return { key: input.key, value: stored };
    },
  },
  orpc: {},
}));

const { hasPreferenceWrite, onPreferenceWriteSettled, parseBooleanPreference, readPreferences, serializeBooleanPreference, usePreference } =
  await import("./preferences");

function Probe({ prefKey = "ui.test.a" }: { prefKey?: string } = {}) {
  const pref = usePreference(prefKey, false, parseBooleanPreference, serializeBooleanPreference);
  return (
    <div>
      <span data-testid="value">{String(pref.value)}</span>
      <span data-testid="loading">{String(pref.isPending)}</span>
      <span data-testid="writing">{String(pref.isWriting)}</span>
      <span data-testid="read-error">{String(pref.isError)}</span>
      <span data-testid="write-failed">{String(pref.writeFailed)}</span>
      <button data-testid="set" onClick={() => pref.setValue(true)}>set</button>
      <button data-testid="unset" onClick={() => pref.setValue(false)}>unset</button>
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

async function mountProbe(prefKey = "ui.test.a"): Promise<ProbeHandle> {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Probe prefKey={prefKey} />
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
    writeCalls = 0;
    writeGate = null;
    canonicalize = null;
    focusManager.setFocused(undefined);
  });

  it("surfaces a failed read so the query can retry later", async () => {
    failRead = true;
    await expect(readPreferences()).rejects.toThrow("PREFERENCES_READ_FAILED");
  });

  it("reports a failed read to the caller instead of failing open", async () => {
    failRead = true;
    const handle = await mountProbe("ui.test.b");
    expect(await waitFor(() => text(handle.host, "read-error") === "true")).toBe(true);
    // the caller must be able to tell "not set" from "we could not ask"
    await handle.unmount();
  });

  it("reports a failed write instead of pretending it landed", async () => {
    failWrite = true;
    const handle = await mountProbe("ui.test.c");
    expect(await waitFor(() => text(handle.host, "loading") === "false")).toBe(true);

    await act(async () => handle.host.querySelector<HTMLButtonElement>("[data-testid='set']")?.click());
    expect(await waitFor(() => text(handle.host, "write-failed") === "true")).toBe(true);
    // the value stays the server's, and the control knows why
    expect(text(handle.host, "value")).toBe("false");
    expect(store["ui.test.c"]).toBeUndefined();
    await handle.unmount();
  });

  it("does not drop a second change made while a write is in flight", async () => {
    let release: (() => void) | null = null;
    writeGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const handle = await mountProbe("ui.test.d");
    expect(await waitFor(() => text(handle.host, "loading") === "false")).toBe(true);

    // two fast toggles: the second must not be discarded
    await act(async () => handle.host.querySelector<HTMLButtonElement>("[data-testid='set']")?.click());
    await act(async () => handle.host.querySelector<HTMLButtonElement>("[data-testid='unset']")?.click());
    await act(async () => {
      release?.();
      await new Promise((resolve) => setTimeout(resolve, 30));
    });

    expect(await waitFor(() => writeCalls === 2)).toBe(true);
    expect(await waitFor(() => store["ui.test.d"] === "false")).toBe(true);
    expect(text(handle.host, "value")).toBe("false");
    // let the queued write settle before the next test shares the mock
    expect(await waitFor(() => text(handle.host, "writing") === "false")).toBe(true);
    await handle.unmount();
  });

  it("parses only the explicit true flag", () => {
    expect(parseBooleanPreference("true")).toBe(true);
    expect(parseBooleanPreference("false")).toBe(false);
    expect(parseBooleanPreference("legacy")).toBe(false);
    expect(parseBooleanPreference(undefined)).toBe(false);
    expect(serializeBooleanPreference(true)).toBe("true");
    expect(serializeBooleanPreference(false)).toBe("false");
  });

  it("shows the server value and writes it through", async () => {
    const handle = await mountProbe();
    expect(await waitFor(() => text(handle.host, "loading") === "false")).toBe(true);
    expect(text(handle.host, "value")).toBe("false");
    expect(hasPreferenceWrite("ui.test.a")).toBe(false);

    await act(async () => handle.host.querySelector<HTMLButtonElement>("[data-testid='set']")?.click());
    expect(hasPreferenceWrite("ui.test.a")).toBe(true);
    expect(await waitFor(() => text(handle.host, "value") === "true")).toBe(true);
    expect(store["ui.test.a"]).toBe("true");
    expect(await waitFor(() => text(handle.host, "writing") === "false")).toBe(true);
    await handle.unmount();
  });

  it("installs the server's returned value, never the sent guess", async () => {
    canonicalize = () => "false"; // the server refuses to store true
    const handle = await mountProbe();
    expect(await waitFor(() => text(handle.host, "loading") === "false")).toBe(true);

    await act(async () => handle.host.querySelector<HTMLButtonElement>("[data-testid='set']")?.click());
    expect(await waitFor(() => writeCalls === 1)).toBe(true);
    // the sent value was true; the server returned false and that is what shows
    expect(text(handle.host, "value")).toBe("false");
    expect(store["ui.test.a"]).toBe("false");
    await handle.unmount();
  });

  it("leaves the server value showing when the write fails", async () => {
    failWrite = true;
    const handle = await mountProbe();
    expect(await waitFor(() => text(handle.host, "loading") === "false")).toBe(true);
    expect(text(handle.host, "value")).toBe("false");

    await act(async () => handle.host.querySelector<HTMLButtonElement>("[data-testid='set']")?.click());
    // no optimistic value: the UI never claims the rejected change
    expect(text(handle.host, "value")).toBe("false");
    expect(await waitFor(() => text(handle.host, "writing") === "false")).toBe(true);
    expect(store["ui.test.a"]).toBeUndefined();
    await handle.unmount();
  });

  it("remembers a second write made while the first is in flight", async () => {
    let releaseWrite = () => {};
    writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });

    const handle = await mountProbe();
    expect(await waitFor(() => text(handle.host, "loading") === "false")).toBe(true);

    // two clicks in one tick: the second is queued, not discarded, so the
    // server ends on the last intent
    await act(async () => {
      const set = handle.host.querySelector<HTMLButtonElement>("[data-testid='set']");
      set?.click();
      set?.click();
    });
    expect(writeCalls).toBe(1);
    expect(text(handle.host, "writing")).toBe("true");

    releaseWrite();
    expect(await waitFor(() => store["ui.test.a"] === "true")).toBe(true);
    expect(await waitFor(() => text(handle.host, "value") === "true")).toBe(true);
    expect(writeCalls).toBe(2);
    await handle.unmount();
  });

  it("re-fetches an errored read on the next mount (self-heal)", async () => {
    failRead = true;
    const failed = await mountProbe();
    expect(await waitFor(() => text(failed.host, "loading") === "false")).toBe(true);
    expect(text(failed.host, "value")).toBe("false");
    await failed.unmount();

    failRead = false;
    store["ui.test.a"] = "true";
    const healed = await mountProbe();
    expect(await waitFor(() => text(healed.host, "value") === "true")).toBe(true);
    await healed.unmount();
  });

  it("notifies observers of a settled write and forgets a failed one", async () => {
    const events: Array<{ key: string; ok: boolean }> = [];
    const unsubscribe = onPreferenceWriteSettled((key, ok) => events.push({ key, ok }));
    const handle = await mountProbe("ui.test.e");
    try {
      expect(await waitFor(() => text(handle.host, "loading") === "false")).toBe(true);

      await act(async () => handle.host.querySelector<HTMLButtonElement>("[data-testid='set']")?.click());
      expect(await waitFor(() => events.length === 1)).toBe(true);
      expect(events[0]).toEqual({ key: "ui.test.e", ok: true });
      // a landed write is a choice the legacy import must not overtake
      expect(hasPreferenceWrite("ui.test.e")).toBe(true);

      failWrite = true;
      await act(async () => handle.host.querySelector<HTMLButtonElement>("[data-testid='unset']")?.click());
      expect(await waitFor(() => events.length === 2)).toBe(true);
      expect(events[1]).toEqual({ key: "ui.test.e", ok: false });
      // a failed write is not a choice, so the import may take over
      expect(hasPreferenceWrite("ui.test.e")).toBe(false);
    } finally {
      // a mid-test failure must not leak the listener into later tests
      unsubscribe();
      await handle.unmount();
    }
  });

  it("picks up a preference changed outside this window on focus", async () => {
    const handle = await mountProbe();
    expect(await waitFor(() => text(handle.host, "loading") === "false")).toBe(true);
    expect(text(handle.host, "value")).toBe("false");

    store["ui.test.a"] = "true"; // another window wrote it
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await new Promise((resolve) => setTimeout(resolve, 20));
    });
    expect(await waitFor(() => text(handle.host, "value") === "true")).toBe(true);
    await handle.unmount();
  });
});
