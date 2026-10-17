import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "../lib/i18n"; // side-effect: initializes i18next (ar) for useTranslation
import i18n from "../lib/i18n";

/** today's tail the api returns — newest-last (chronological append order) */
interface TailFixture {
  file: string;
  lines: string[];
}

let fixture: TailFixture = { file: "logs/2026-08-25.jsonl", lines: [] };
let lastInput: { lines?: number } | undefined;
let failNextFetch = false;
let refetchCount = 0;

mock.module("@/lib/rpc", () => ({
  orpc: {
    diagnosticsLogsTail: {
      queryOptions: ({ input }: { input: { lines?: number } }) => {
        lastInput = input;
        return {
          queryKey: ["diagnosticsLogsTail", input],
          queryFn: async (): Promise<TailFixture> => {
            refetchCount += 1;
            if (failNextFetch) {
              failNextFetch = false;
              throw new Error("RPC unavailable");
            }
            return fixture;
          },
        };
      },
      // SAFETY: mirror the real tanstack-query utils signature ({ input })
      queryKey: (args: { input: { lines?: number } }) => ["diagnosticsLogsTail", args.input],
    },
  },
  rpcClient: {},
}));

const { DiagnosticsPage } = await import("./diagnostics");

/** mounts are registered so afterEach tears them down even on assertion failure */
let mountedRoots: Array<{ root: Root; container: HTMLDivElement }> = [];

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
  const entry = { root, container };
  mountedRoots.push(entry);
  return {
    text: () => container.textContent ?? "",
    /** per-row text, in DOM order (top = newest) */
    rowsText: () =>
      [...container.querySelectorAll("[data-testid='diagnostics-row']")].map((el) => el.textContent ?? ""),
    rows: () => container.querySelectorAll("[data-testid='diagnostics-row']").length,
    rowElements: () => [...container.querySelectorAll("[data-testid='diagnostics-row']")],
    empty: () => container.querySelector("[data-testid='diagnostics-empty']"),
    retryButton: () => [...container.querySelectorAll("button")].find((b) => b.textContent?.includes("إعادة المحاولة")),
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
      mountedRoots = mountedRoots.filter((m) => m !== entry);
    },
  };
}

const boot = JSON.stringify({ ts: "2026-08-25T08:00:00", level: "info", event: "SERVER_BOOT_DONE", message: "database and auth ready" });
const warn = JSON.stringify({ ts: "2026-08-25T08:00:01", level: "warn", event: "LOW_DISK", message: "disk nearly full" });
const seen = { n: 0 };
const err = (message: string) => {
  seen.n += 1;
  return JSON.stringify({
    ts: `2026-08-25T08:00:0${seen.n % 10}`, // valid distinct seconds, never >59
    level: "error",
    event: "RPC_ERROR",
    message,
    code: "DKN-A03C6A02",
    errorName: "ORPCError",
    stack: `ORPCError: ${message}\n    at probe (app.ts:1)`,
  });
};

describe("DiagnosticsPage (ticket 14 viewer)", () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
    fixture = { file: "logs/2026-08-25.jsonl", lines: [] };
    lastInput = undefined;
    failNextFetch = false;
    refetchCount = 0;
    seen.n = 0;
  });

  afterEach(() => {
    queryClient.clear();
    // teardown any mount left behind by a failed assertion — a dangling root
    // would leak DOM (and act() warnings) into the next test in the file
    for (const { root, container } of mountedRoots) {
      root.unmount();
      container.remove();
    }
    mountedRoots = [];
  });

  it("requests a bounded tail (200 lines) and shows the log file name", async () => {
    fixture = { file: "logs/2026-08-25.jsonl", lines: [boot] };
    const page = await mountPage(queryClient);
    // #253 — the event badge is translated; the raw code stays on data-event
    expect(await page.waitFor(() => page.text().includes(i18n.t("logEvent_SERVER_BOOT_DONE")))).toBe(true);
    expect(lastInput).toEqual({ lines: 200 });
    expect(page.text()).toContain("logs/2026-08-25.jsonl");
    // issue #96 — the non-empty render must not show the empty state
    expect(page.empty()).toBeNull();
    await page.unmount();
  });

  it("renders newest first and keeps the stable DKN code visible on every row", async () => {
    fixture = { file: "logs/2026-08-25.jsonl", lines: [boot, warn, err("rpc call failed #1"), err("rpc call failed #2")] };
    const page = await mountPage(queryClient);
    expect(await page.waitFor(() => page.rows() === 4)).toBe(true);

    // newest-last from the api → newest first on screen (DOM order)
    const rows = page.rowsText();
    expect(rows[0]).toContain("rpc call failed #2");
    expect(rows[1]).toContain("rpc call failed #1");
    expect(rows[2]).toContain("LOW_DISK"); // unknown event badge renders raw
    expect(rows[3]).toContain(i18n.t("logEvent_SERVER_BOOT_DONE"));

    // same site → same DKN code on every RPC_ERROR row (stability, not random)
    const matches = rows.join("\n").match(/DKN-[0-9A-F]{8}/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
    expect([...new Set(matches)]).toEqual(["DKN-A03C6A02"]);
    await page.unmount();
  });

  it("shows malformed lines as raw text instead of dropping them", async () => {
    fixture = { file: "logs/2026-08-25.jsonl", lines: ["this is not json", '{"event": 5}', boot] };
    const page = await mountPage(queryClient);
    expect(await page.waitFor(() => page.text().includes("this is not json"))).toBe(true);
    expect(page.text()).toContain('"event": 5'); // valid JSON, wrong shape → raw too
    expect(page.text()).toContain(i18n.t("logEvent_SERVER_BOOT_DONE"));
    await page.unmount();
  });

  /** #253 — the owner named the first-run boot rows as untranslated English. */
  describe("boot rows are translated (#253)", () => {
    const firstRun = [
      JSON.stringify({ ts: "2026-08-25T08:00:01", level: "info", event: "FIRST_TIME_SETUP", message: "owner account created" }),
      JSON.stringify({ ts: "2026-08-25T08:00:02", level: "info", event: "VAULT_CREATED", message: "vault created and unlocked" }),
      JSON.stringify({ ts: "2026-08-25T08:00:03", level: "info", event: "SERVER_BOOT_DONE", message: "vault store and auth ready" }),
      JSON.stringify({ ts: "2026-08-25T08:00:04", level: "info", event: "SERVER_STARTED", message: "Dokan API booted" }),
    ];

    it("renders Arabic copy for every boot row the owner named", async () => {
      fixture = { file: "logs/2026-08-25.jsonl", lines: firstRun };
      const page = await mountPage(queryClient);
      expect(await page.waitFor(() => page.rows() === 4)).toBe(true);
      const shown = page.rowsText().join("\n");

      for (const key of ["logEvent_FIRST_TIME_SETUP", "logEvent_VAULT_CREATED", "logEvent_SERVER_BOOT_DONE", "logEvent_SERVER_STARTED"]) {
        expect(shown).toContain(i18n.t(key));
      }
      for (const key of ["logMessage_firstTimeSetup", "logMessage_vaultCreated", "logMessage_serverBootVault", "logMessage_serverStarted"]) {
        expect(shown).toContain(i18n.t(key));
      }
      // no raw English event code or sentence leaks for these rows
      for (const raw of ["FIRST_TIME_SETUP", "VAULT_CREATED", "SERVER_BOOT_DONE", "SERVER_STARTED", "owner account created", "vault created and unlocked", "vault store and auth ready", "Dokan API booted"]) {
        expect(shown).not.toContain(raw);
      }
      await page.unmount();
    });

    it("keeps the raw event code on the row for support", async () => {
      fixture = { file: "logs/2026-08-25.jsonl", lines: firstRun };
      const page = await mountPage(queryClient);
      expect(await page.waitFor(() => page.rows() === 4)).toBe(true);
      const codes = page.rowElements().map((el) => el.querySelector("[data-event]")?.getAttribute("data-event"));
      // DOM order is newest first, so the seeded order is reversed here
      expect(codes).toEqual(["SERVER_STARTED", "SERVER_BOOT_DONE", "VAULT_CREATED", "FIRST_TIME_SETUP"]);
      await page.unmount();
    });

    it("falls back to the raw English for an event and message outside the catalogue", async () => {
      fixture = { file: "logs/2026-08-25.jsonl", lines: [warn] };
      const page = await mountPage(queryClient);
      expect(await page.waitFor(() => page.rows() === 1)).toBe(true);
      expect(page.rowsText()[0]).toContain("LOW_DISK");
      expect(page.rowsText()[0]).toContain("disk nearly full");
      await page.unmount();
    });
  });

  it("shows the empty state when today's file has no lines", async () => {
    fixture = { file: "logs/2026-08-25.jsonl", lines: [] };
    const page = await mountPage(queryClient);
    expect(await page.waitFor(() => page.text().includes(i18n.t("diagnosticsEmpty")))).toBe(true);
    // issue #96 — a read-only log names what fills it instead of faking a step
    expect(page.empty()?.textContent).toContain(i18n.t("diagnosticsEmptyHint"));
    expect(page.empty()?.querySelector("button, a")).toBeNull();
    expect(page.rows()).toBe(0);
    await page.unmount();
  });

  it("surfaces the error state and recovers through the retry button", async () => {
    fixture = { file: "logs/2026-08-25.jsonl", lines: [err("first attempt failed")] };
    failNextFetch = true; // the initial fetch rejects
    const page = await mountPage(queryClient);
    expect(await page.waitFor(() => page.text().includes("تعذّر تحميل السجل"))).toBe(true);
    expect(page.rows()).toBe(0);

    // refetch succeeds once the next call goes through
    await act(async () => {
      page.retryButton()?.click();
    });
    expect(await page.waitFor(() => page.rows() === 1)).toBe(true);
    expect(page.text()).toContain("first attempt failed");
    expect(refetchCount).toBeGreaterThanOrEqual(2);
    await page.unmount();
  });
});