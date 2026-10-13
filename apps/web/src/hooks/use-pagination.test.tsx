import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// SAFETY: React 19 act() requires the environment flag to be set explicitly;
// only this flag is written and globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let store: Record<string, string>;

mock.module("@/lib/rpc", () => ({
  rpcClient: {
    preferencesGet: async () => ({ values: { ...store } }),
    preferencesSet: async (input: { key: string; value: string }) => {
      store[input.key] = input.value;
      return { key: input.key, value: input.value };
    },
  },
  orpc: {},
}));

const { usePagination } = await import("./use-pagination");

/**
 * Two live paginators sharing one `ui.pageSize` preference. The bug this pins
 * (issue #163 review): changing the size in one list left the OTHER list on its
 * old offset under the new size, so it highlighted page one while showing the
 * wrong rows. Every hook must reset when its observed size changes.
 */
function Probe() {
  const a = usePagination();
  const b = usePagination();
  return (
    <div>
      <span data-testid="a-offset">{a.offset}</span>
      <span data-testid="b-offset">{b.offset}</span>
      <span data-testid="a-size">{a.pageSize}</span>
      <button data-testid="a-page3" onClick={() => a.setOffset(20)}>a3</button>
      <button data-testid="b-page2" onClick={() => b.setOffset(10)}>b2</button>
      <button data-testid="b-size25" onClick={() => b.setPageSize(25)}>b25</button>
    </div>
  );
}

let host: HTMLDivElement;
let root: Root | null = null;

beforeEach(() => {
  store = {};
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  root = null;
  host.remove();
});

async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 80; attempt++) {
    if (predicate()) return;
    await flush();
  }
  throw new Error("condition not met within timeout");
}

function text(id: string): string | null {
  return host.querySelector(`[data-testid='${id}']`)?.textContent ?? null;
}

function click(id: string) {
  act(() => host.querySelector<HTMLElement>(`[data-testid='${id}']`)!.click());
}

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  root = createRoot(host);
  await act(async () => {
    root!.render(
      <QueryClientProvider client={client}>
        <Probe />
      </QueryClientProvider>,
    );
  });
  await waitFor(() => text("a-size") === "10");
}

describe("usePagination (issue #163)", () => {
  it("resets every live hook's offset when the shared page size changes", async () => {
    await mount();

    // both lists move away from page one
    click("a-page3");
    click("b-page2");
    expect(text("a-offset")).toBe("20");
    expect(text("b-offset")).toBe("10");

    // one list changes the shared size: the OTHER list's offset must reset too,
    // or it keeps rows 21+ while highlighting page one
    click("b-size25");
    await waitFor(() => text("a-size") === "25");
    await waitFor(() => text("a-offset") === "0");
    expect(text("b-offset")).toBe("0");
  });

  it("keeps the offset when the page size does not change", async () => {
    await mount();
    click("a-page3");
    expect(text("a-offset")).toBe("20");
    await flush();
    // a re-render with the same size must not reset the offset
    expect(text("a-offset")).toBe("20");
  });
});
