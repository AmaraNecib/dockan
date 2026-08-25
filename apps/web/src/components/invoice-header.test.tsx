import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "../lib/i18n"; // side-effect: initializes i18next (ar) for useTranslation

/** drives the mocked settingsGet seam deterministically per test */
let mode: "loading" | "error" | "ready" = "loading";

// The header resolves the identity through orpc.settingsGet.queryOptions;
// mock the rpc module so tests control loading/error/ready without a network.
mock.module("@/lib/rpc", () => ({
  orpc: {
    settingsGet: {
      queryOptions: () => ({
        queryKey: ["settingsGet"],
        queryFn: async () => {
          if (mode === "error") throw new Error("network down");
          if (mode === "loading") return new Promise<never>(() => {});
          return { storeName: "متجر الاختبار", storePhone: "+213550123123" };
        },
      }),
    },
  },
  rpcClient: {},
}));

const { InvoiceHeader } = await import("./invoice-header");

let roots: Array<{ unmount: () => void }> = [];
let host = document.createElement("div");

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
});

afterEach(() => {
  for (const root of roots) root.unmount();
  roots = [];
  host.remove();
});

function renderHeader() {
  // retry:false so a rejected settingsGet lands on the error branch
  // immediately instead of spinning through react-query retries
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const root = createRoot(host);
  roots.push(root);
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <InvoiceHeader />
      </QueryClientProvider>,
    );
  });
}

/** act-wrapped polling so every deferred state update stays inside React */
const waitFor = async (predicate: () => boolean) => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error("condition not met within timeout");
};

const text = () => host.textContent ?? "";

describe("InvoiceHeader states", () => {
  it("shows a loading skeleton instead of a silent blank while settings are pending", () => {
    mode = "loading";
    renderHeader();
    expect(host.querySelector('[data-testid="invoice-header-loading"]')).not.toBeNull();
    // nothing of the identity leaks through while pending
    expect(text()).not.toContain("متجر الاختبار");
  });

  it("renders the identity once the settings land", async () => {
    mode = "ready";
    renderHeader();
    await waitFor(() => text().includes("متجر الاختبار"));
    expect(text()).toContain("متجر الاختبار");
    expect(text()).toContain("+213550123123");
  });

  it("shows an alert + retry on query failure and recovers to the identity", async () => {
    mode = "error";
    renderHeader();
    await waitFor(() => host.querySelector('[data-testid="invoice-header-error"]') !== null);
    // never a silent blank: an alert names the failure and offers recovery
    expect(host.querySelector('[data-testid="invoice-header-error"]')).not.toBeNull();
    expect(text()).not.toContain("متجر الاختبار");

    // retry re-reads settings; the seam is healed so the identity appears
    mode = "ready";
    const retry = host.querySelector<HTMLButtonElement>('[data-testid="invoice-header-retry"]');
    expect(retry).not.toBeNull();
    act(() => {
      retry!.click();
    });
    await waitFor(() => text().includes("متجر الاختبار"));
    expect(text()).toContain("+213550123123");
  });
});