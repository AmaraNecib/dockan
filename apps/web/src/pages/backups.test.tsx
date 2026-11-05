import { afterEach, beforeEach, expect, it } from "bun:test";
import assert from "node:assert/strict";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ExternalBackupStatus } from "@dokan/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";

import "../lib/i18n";
import { BackupsPage } from "./backups";
import { clearVaultSessionToken, storeVaultSessionToken } from "../lib/vault-client";

// SAFETY: React's test environment flag is the only global modified here.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
// SAFETY: happy-dom supplies setURL so the real RPC link has a browser origin.
(window as { happyDOM?: { setURL: (url: string) => void } }).happyDOM?.setURL("http://localhost:5173/");

type RevealCall = { command: string; args: { path: string; sessionToken: string } };
type TestBridge = { invoke: (command: string, args: { path: string; sessionToken: string }) => Promise<void> };
const sessionToken = "a".repeat(43);
const completedPath = "C:/نسخ المحل/backup, completed.db.enc";
const originalFetch = globalThis.fetch;
let calls: RevealCall[] = [];
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;

function bridge(invoke: TestBridge["invoke"]): void {
  // SAFETY: tests substitute the same IPC global the desktop webview injects.
  (window as { __TAURI_INTERNALS__?: TestBridge }).__TAURI_INTERNALS__ = { invoke };
}

function externalDestinationInput(): HTMLInputElement {
  const input = host.querySelector<HTMLInputElement>("#external-backup-destination");
  assert.ok(input, "Missing external backup destination input");
  return input;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

function button(label: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll("button")).find((entry) => entry.textContent === label);
  assert.ok(found, `Missing button: ${label}`);
  return found;
}

async function settle(assertSettled: () => void, description: string): Promise<void> {
  await act(async () => {
    const deadline = Date.now() + 1000;
    let consecutiveMatches = 0;
    while (Date.now() < deadline) {
      try {
        assertSettled();
        consecutiveMatches++;
        if (consecutiveMatches === 7) return;
      } catch {
        consecutiveMatches = 0;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Timed out waiting for ${description}`);
  });
}

async function click(label: string, assertSettled: () => void, description: string): Promise<void> {
  await act(async () => button(label).click());
  await settle(assertSettled, description);
}

beforeEach(async () => {
  calls = [];
  storeVaultSessionToken(sessionToken);
  bridge(async (command, args) => { calls.push({ command, args }); });
  globalThis.fetch = Object.assign(async () => Response.json({ json: {
    path: completedPath, createdAt: "2026-10-28T09:00:00",
  } }), { preconnect: originalFetch.preconnect });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root.render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}>
      <BackupsPage />
    </QueryClientProvider>,
  ));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  globalThis.fetch = originalFetch;
  clearVaultSessionToken();
  // SAFETY: remove only the bridge installed by this test.
  delete (window as { __TAURI_INTERNALS__?: TestBridge }).__TAURI_INTERNALS__;
});

it("cancels an edited destination without saving it", async () => {
  let setCalls = 0;
  globalThis.fetch = Object.assign(async () => {
    setCalls++;
    return Response.json({ json: {} });
  }, { preconnect: originalFetch.preconnect });
  await act(async () => setInputValue(externalDestinationInput(), "E:/draft"));
  expect(externalDestinationInput().value).toBe("E:/draft");
  await act(async () => button("إلغاء التعديل").click());
  expect(externalDestinationInput().value).toBe("");
  expect(setCalls).toBe(0);
});

it("saves a destination, shows the successful copy path, and resets without deleting backup files", async () => {
  let status: ExternalBackupStatus = { destination: null, lastAttemptAt: null, lastSuccessAt: null, lastError: null, lastPath: null };
  let setCalls = 0;
  globalThis.fetch = Object.assign(async (request: RequestInfo | URL) => {
    const url = request instanceof Request ? request.url : String(request);
    if (url.includes("externalBackupStatus")) return Response.json({ json: status });
    if (url.includes("externalBackupDevice")) return Response.json({ json: "same" });
    if (url.includes("externalBackupDestinationSet")) {
      setCalls++;
      status = setCalls === 1
        ? { ...status, destination: "D:/backup", lastAttemptAt: null, lastSuccessAt: null, lastError: null, lastPath: null }
        : { ...status, destination: null, lastAttemptAt: null, lastSuccessAt: null, lastError: null, lastPath: null };
      return Response.json({ json: status });
    }
    if (url.includes("externalBackupRun")) {
      status = { ...status, lastAttemptAt: "2026-11-05T10:00:00", lastSuccessAt: "2026-11-05T10:00:00", lastPath: "D:/backup/dokan-backup-1/dokan-backup.dknvbak" };
      return Response.json({ json: status });
    }
    return Response.json({ json: { path: completedPath, createdAt: "2026-10-28T09:00:00" } });
  }, { preconnect: originalFetch.preconnect });
  await act(async () => setInputValue(externalDestinationInput(), "D:/backup"));
  await click("حفظ المجلد", () => expect(externalDestinationInput().value).toBe("D:/backup"), "destination saved");
  expect(setCalls).toBe(1);
  await settle(() => expect(host.textContent).toContain("القرص الفعلي نفسه"), "same-drive warning");
  await click("نسخ الآن", () => expect(host.querySelector('[data-testid="external-backup-success"]')?.textContent).toContain("dokan-backup.dknvbak"), "external copy outcome");
  await click("إزالة الوجهة", () => expect(externalDestinationInput().value).toBe(""), "destination reset");
  expect(setCalls).toBe(2);
  expect(status.destination).toBeNull();
});

it("reveals only the actual successfully completed backup", async () => {
  expect(host.textContent).not.toContain("إظهار الملف في المجلد");
  await click("إنشاء نسخة احتياطية الآن", () => {
    expect(host.querySelector('[data-testid="backup-done"]')?.textContent).toContain(completedPath);
  }, "completed backup state");
  await click("إظهار الملف في المجلد", () => {
    expect(calls).toEqual([{ command: "backup_reveal", args: { path: completedPath, sessionToken } }]);
  }, "native reveal dispatch");
});

it("reveals the latest successful path with the rotated session token", async () => {
  const latestPath = "C:/نسخ المحل/second backup #401.db.enc";
  const responses = [
    { json: { path: completedPath, createdAt: "2026-10-28T09:00:00" } },
    { json: { path: latestPath, createdAt: "2026-10-28T09:01:00" } },
  ];
  globalThis.fetch = Object.assign(async () => {
    const response = responses.shift();
    assert.ok(response, "the test expects exactly two successful backup creations");
    return Response.json(response);
  }, { preconnect: originalFetch.preconnect });

  await click("إنشاء نسخة احتياطية الآن", () => {
    expect(host.querySelector('[data-testid="backup-done"]')?.textContent).toContain(completedPath);
  }, "first completed backup");
  await click("إنشاء نسخة احتياطية الآن", () => {
    expect(host.querySelector('[data-testid="backup-done"]')?.textContent).toContain(latestPath);
  }, "latest completed backup");

  const rotatedToken = "b".repeat(43);
  storeVaultSessionToken(rotatedToken);
  await click("إظهار الملف في المجلد", () => {
    expect(calls).toEqual([
      { command: "backup_reveal", args: { path: latestPath, sessionToken: rotatedToken } },
    ]);
  }, "reveal with rotated token");
});

it("invalidates the completed-file claim when native reveal refuses a missing file", async () => {
  bridge(async () => { throw "BACKUP_REVEAL_MISSING"; });
  await click("إنشاء نسخة احتياطية الآن", () => {
    expect(host.querySelector('[data-testid="backup-done"]')?.textContent).toContain(completedPath);
  }, "completed backup before missing-file refusal");
  await click("إظهار الملف في المجلد", () => {
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      "لم يعد ملف النسخة الاحتياطية موجوداً. أنشئ نسخة جديدة ثم حاول إظهارها.",
    );
  }, "missing-file refusal message");
  expect(host.querySelector('[data-testid="backup-done"]')).toBeNull();
  expect(host.textContent).not.toContain("إظهار الملف في المجلد");
  expect(document.activeElement).toBe(button("إنشاء نسخة احتياطية الآن"));
  await click("إنشاء نسخة احتياطية الآن", () => {
    expect(host.querySelector('[data-testid="backup-done"]')?.textContent).toContain(completedPath);
  }, "new completed backup after refusal");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.querySelector('[data-testid="backup-done"]')?.textContent).toContain(completedPath);
});

it("refuses reveal without a stored session token and keeps the completed backup", async () => {
  clearVaultSessionToken();
  bridge(async (_command, args) => {
    calls.push({ command: _command, args });
    if (!args.sessionToken) throw "BACKUP_REVEAL_FAILED";
  });
  await click("إنشاء نسخة احتياطية الآن", () => {
    expect(host.querySelector('[data-testid="backup-done"]')?.textContent).toContain(completedPath);
  }, "completed backup without stored token");
  await click("إظهار الملف في المجلد", () => {
    expect(calls).toEqual([{ command: "backup_reveal", args: { path: completedPath, sessionToken: "" } }]);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      "تعذّر إظهار الملف في المجلد. حاول مجدداً أو افتح المسار الظاهر يدوياً.",
    );
  }, "native request failure with empty token");
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "تعذّر إظهار الملف في المجلد. حاول مجدداً أو افتح المسار الظاهر يدوياً.",
  );
  expect(host.querySelector('[data-testid="backup-done"]')?.textContent).toContain(completedPath);
});

it("reports a native failure in Arabic and allows retry of the same completed path", async () => {
  bridge(async () => { throw new Error("private OS error"); });
  await click("إنشاء نسخة احتياطية الآن", () => {
    expect(host.querySelector('[data-testid="backup-done"]')?.textContent).toContain(completedPath);
  }, "completed backup before native failure");
  await click("إظهار الملف في المجلد", () => {
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      "تعذّر إظهار الملف في المجلد. حاول مجدداً أو افتح المسار الظاهر يدوياً.",
    );
  }, "native failure message");
  expect(host.textContent).not.toContain("private OS error");
  expect(host.querySelector('[data-testid="backup-done"]')?.textContent).toContain(completedPath);
  bridge(async (command, args) => { calls.push({ command, args }); });
  await click("إظهار الملف في المجلد", () => {
    expect(calls).toEqual([{ command: "backup_reveal", args: { path: completedPath, sessionToken } }]);
  }, "retry native reveal dispatch");
  await settle(() => expect(host.querySelector('[role="alert"]')).toBeNull(), "successful retry clears native error");
});

it("explains browser-only mode without pretending to reveal a file", async () => {
  // SAFETY: remove this test's optional desktop bridge to simulate a browser.
  delete (window as { __TAURI_INTERNALS__?: TestBridge }).__TAURI_INTERNALS__;
  await click("إنشاء نسخة احتياطية الآن", () => {
    expect(host.querySelector('[data-testid="backup-done"]')?.textContent).toContain(completedPath);
  }, "completed backup in browser-only mode");
  expect(button("إظهار الملف في المجلد").disabled).toBe(true);
  expect(host.textContent).toContain("إظهار الملف متاح في تطبيق دكان على Windows فقط.");
  expect(calls).toEqual([]);
});

it("removes the old success and reveal error while a new creation is pending or failed", async () => {
  await click("إنشاء نسخة احتياطية الآن", () => {
    expect(host.querySelector('[data-testid="backup-done"]')?.textContent).toContain(completedPath);
  }, "initial completed backup");
  bridge(async () => { throw "BACKUP_REVEAL_FAILED"; });
  await click("إظهار الملف في المجلد", () => {
    expect(host.querySelector('[role="alert"]')).not.toBeNull();
  }, "initial reveal error");
  let refuse: ((reason: Error) => void) | undefined;
  globalThis.fetch = Object.assign(() => new Promise<Response>((_resolve, reject) => {
    refuse = reject;
  }), { preconnect: originalFetch.preconnect });
  await click("إنشاء نسخة احتياطية الآن", () => {
    expect(button("جاري الإنشاء…").disabled).toBe(true);
    expect(host.querySelector('[data-testid="backup-done"]')).toBeNull();
  }, "pending creation state");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).not.toContain("إظهار الملف في المجلد");
  await act(async () => refuse?.(new Error("write failed")));
  await settle(() => expect(host.querySelector('[role="alert"]')).not.toBeNull(), "creation error state");
  expect(host.querySelector('[data-testid="backup-done"]')).toBeNull();
  expect(button("إنشاء نسخة احتياطية الآن").disabled).toBe(false);
});

it("maps unsupported native reveal to the Arabic desktop-only explanation", async () => {
  bridge(async () => { throw "BACKUP_REVEAL_UNSUPPORTED"; });
  await click("إنشاء نسخة احتياطية الآن", () => {
    expect(host.querySelector('[data-testid="backup-done"]')?.textContent).toContain(completedPath);
  }, "completed backup before unsupported reveal");
  await click("إظهار الملف في المجلد", () => {
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      "إظهار الملف متاح في تطبيق دكان على Windows فقط. يمكنك فتح المسار الظاهر يدوياً.",
    );
  }, "unsupported reveal message");
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "إظهار الملف متاح في تطبيق دكان على Windows فقط. يمكنك فتح المسار الظاهر يدوياً.",
  );
  expect(host.querySelector('[data-testid="backup-done"]')?.textContent).toContain(completedPath);
});

it("blocks same-turn competing dispatches before React commits pending state", async () => {
  await click("إنشاء نسخة احتياطية الآن", () => {
    expect(host.querySelector('[data-testid="backup-done"]')?.textContent).toContain(completedPath);
  }, "completed backup before competing dispatches");
  let finish: (() => void) | undefined;
  bridge((command, args) => {
    calls.push({ command, args });
    return new Promise<void>((resolve) => { finish = resolve; });
  });
  let creations = 0;
  globalThis.fetch = Object.assign(async () => {
    creations++;
    return Response.json({ json: { path: completedPath, createdAt: "2026-10-28T09:00:00" } });
  }, { preconnect: originalFetch.preconnect });
  const reveal = button("إظهار الملف في المجلد");
  const create = button("إنشاء نسخة احتياطية الآن");
  await act(async () => {
    reveal.click();
    reveal.click();
    create.click();
  });
  await settle(() => expect(calls).toHaveLength(1), "single native dispatch");
  expect(creations).toBe(0);
  await act(async () => finish?.());
  await settle(() => expect(button("إظهار الملف في المجلد").disabled).toBe(false), "settled native reveal");
});

it("sends one creation when duplicate clicks arrive in the same turn", async () => {
  let creations = 0;
  let complete: ((value: Response) => void) | undefined;
  globalThis.fetch = Object.assign(() => {
    creations++;
    return new Promise<Response>((resolve) => { complete = resolve; });
  }, { preconnect: originalFetch.preconnect });
  const create = button("إنشاء نسخة احتياطية الآن");
  await act(async () => { create.click(); create.click(); });
  await settle(() => expect(button("جاري الإنشاء…").disabled).toBe(true), "pending single creation");
  expect(creations).toBe(1);
  await act(async () => complete?.(Response.json({ json: { path: completedPath, createdAt: "2026-10-28T09:00:00" } })));
  await settle(() => {
    expect(host.querySelector('[data-testid="backup-done"]')?.textContent).toContain(completedPath);
  }, "completed single creation");
  expect(host.querySelector('[data-testid="backup-done"]')?.textContent).toContain(completedPath);
});

it("prevents a new backup or duplicate reveal until the native call settles", async () => {
  let finish: (() => void) | undefined;
  bridge(() => new Promise<void>((resolve) => { finish = resolve; }));
  await click("إنشاء نسخة احتياطية الآن", () => {
    expect(host.querySelector('[data-testid="backup-done"]')?.textContent).toContain(completedPath);
  }, "completed backup before reveal pending");
  await click("إظهار الملف في المجلد", () => {
    expect(button("جاري إظهار الملف…").disabled).toBe(true);
  }, "pending native reveal state");
  expect(button("إنشاء نسخة احتياطية الآن").disabled).toBe(true);
  await act(async () => finish?.());
  await settle(() => expect(button("إظهار الملف في المجلد").disabled).toBe(false), "settled native reveal");
  expect(button("إنشاء نسخة احتياطية الآن").disabled).toBe(false);
});
