import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "../lib/i18n"; // side-effect: initializes i18next (ar) for useTranslation

/** today's tail the api returns — newest-last (chronological append order) */
interface TailFixture {
  file: string;
  lines: string[];
}

let fixture: TailFixture = { file: "logs/2026-08-25.jsonl", lines: [] };
let lastInput: { lines?: number } | undefined;

mock.module("@/lib/rpc", () => ({
  orpc: {
    diagnosticsLogsTail: {
      queryOptions: ({ input }: { input: { lines?: number } }) => {
        lastInput = input;
        return {
          queryKey: ["diagnosticsLogsTail", input],
          queryFn: async (): Promise<TailFixture> => fixture,
        };
      },
      // SAFETY: mirror the real tanstack-query utils signature ({ input })
      queryKey: (args: { input: { lines?: number } }) => ["diagnosticsLogsTail", args.input],
    },
  },
  rpcClient: {},
}));

const { DiagnosticsPage } = await import("./diagnostics");

async function mountPage(queryClient: QueryClient) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <DiagnosticsPage />
      </QueryClientProvider>,
    );
  });
  return {
    text: () => container.textContent ?? "",
    rows: () => container.querySelectorAll("[data-testid='diagnostics-row']").length,
    waitFor: async (check: () => boolean) => {
      for (let attempt = 0; attempt < 50; attempt++) {
        if (check()) return true;
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 20));
        });
      }
      return false;
    },
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const boot = JSON.stringify({ ts: "2026-08-25T08:00:00", level: "info", event: "SERVER_BOOT_DONE", message: "database ready" });
const err = (message: string) =>
  JSON.stringify({
    ts: `2026-08-25T08:00:0${message.length}`,
    level: "error",
    event: "RPC_ERROR",
    message,
    code: "DKN-A03C6A02",
    errorName: "ORPCError",
    stack: `ORPCError: ${message}\n    at probe (app.ts:1)`,
  });

describe("DiagnosticsPage (ticket 14 viewer)", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    fixture = { file: "logs/2026-08-25.jsonl", lines: [] };
    lastInput = undefined;
  });

  afterEach(() => {
    queryClient.clear();
  });

  it("requests a bounded tail (200 lines) and shows the log file name", async () => {
    fixture = { file: "logs/2026-08-25.jsonl", lines: [boot] };
    const page = await mountPage(queryClient);
    expect(await page.waitFor(() => page.text().includes("SERVER_BOOT_DONE"))).toBe(true);
    expect(lastInput).toEqual({ lines: 200 });
    expect(page.text()).toContain("logs/2026-08-25.jsonl");
    await page.unmount();
  });

  it("renders newest first and keeps the stable DKN code visible on every row", async () => {
    fixture = { file: "logs/2026-08-25.jsonl", lines: [boot, err("rpc call failed #1"), err("rpc call failed #2")] };
    const page = await mountPage(queryClient);
    expect(await page.waitFor(() => page.rows() === 3)).toBe(true);

    // newest-last from the api → newest first on screen
    const firstRowMessage = page.text().indexOf("rpc call failed #2");
    const secondRowMessage = page.text().indexOf("rpc call failed #1");
    expect(firstRowMessage).toBeGreaterThan(-1);
    expect(secondRowMessage).toBeGreaterThan(firstRowMessage);

    // same site → same DKN code on every RPC_ERROR row (stability, not random)
    const matches = page.text().match(/DKN-[0-9A-F]{8}/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect([...new Set(matches)]).toEqual(["DKN-A03C6A02"]);
    await page.unmount();
  });

  it("shows malformed lines as raw text instead of dropping them", async () => {
    fixture = { file: "logs/2026-08-25.jsonl", lines: ["this is not json", boot] };
    const page = await mountPage(queryClient);
    expect(await page.waitFor(() => page.text().includes("this is not json"))).toBe(true);
    expect(page.text()).toContain("SERVER_BOOT_DONE");
    await page.unmount();
  });

  it("shows the empty state when today's file has no lines", async () => {
    fixture = { file: "logs/2026-08-25.jsonl", lines: [] };
    const page = await mountPage(queryClient);
    expect(await page.waitFor(() => page.text().includes("لا توجد سجلات بعد"))).toBe(true);
    expect(page.rows()).toBe(0);
    await page.unmount();
  });
});