import { afterEach, beforeEach, expect, it } from "bun:test";
import assert from "node:assert/strict";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
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

function button(label: string): HTMLButtonElement {
  const found = Array.from(host.querySelectorAll("button")).find((entry) => entry.textContent === label);
  assert.ok(found, `Missing button: ${label}`);
  return found;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

async function click(label: string): Promise<void> {
  await act(async () => button(label).click());
  await settle();
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

it("reveals only the actual successfully completed backup", async () => {
  expect(host.textContent).not.toContain("إظهار الملف في المجلد");
  await click("إنشاء نسخة احتياطية الآن");
  expect(host.querySelector('[data-testid="backup-done"]')?.textContent).toContain(completedPath);
  await click("إظهار الملف في المجلد");
  expect(calls).toEqual([{ command: "backup_reveal", args: { path: completedPath, sessionToken } }]);
});

it("invalidates the completed-file claim when native reveal refuses a missing file", async () => {
  bridge(async () => { throw "BACKUP_REVEAL_MISSING"; });
  await click("إنشاء نسخة احتياطية الآن");
  await click("إظهار الملف في المجلد");
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "لم يعد ملف النسخة الاحتياطية موجوداً. أنشئ نسخة جديدة ثم حاول إظهارها.",
  );
  expect(host.querySelector('[data-testid="backup-done"]')).toBeNull();
  expect(host.textContent).not.toContain("إظهار الملف في المجلد");
  await click("إنشاء نسخة احتياطية الآن");
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.querySelector('[data-testid="backup-done"]')?.textContent).toContain(completedPath);
});

it("reports a native failure in Arabic and allows retry of the same completed path", async () => {
  bridge(async () => { throw new Error("private OS error"); });
  await click("إنشاء نسخة احتياطية الآن");
  await click("إظهار الملف في المجلد");
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "تعذّر إظهار الملف في المجلد. حاول مجدداً أو افتح المسار الظاهر يدوياً.",
  );
  expect(host.textContent).not.toContain("private OS error");
  expect(host.querySelector('[data-testid="backup-done"]')?.textContent).toContain(completedPath);
  bridge(async (command, args) => { calls.push({ command, args }); });
  await click("إظهار الملف في المجلد");
  expect(calls).toEqual([{ command: "backup_reveal", args: { path: completedPath, sessionToken } }]);
  expect(host.querySelector('[role="alert"]')).toBeNull();
});

it("explains browser-only mode without pretending to reveal a file", async () => {
  // SAFETY: remove this test's optional desktop bridge to simulate a browser.
  delete (window as { __TAURI_INTERNALS__?: TestBridge }).__TAURI_INTERNALS__;
  await click("إنشاء نسخة احتياطية الآن");
  expect(button("إظهار الملف في المجلد").disabled).toBe(true);
  expect(host.textContent).toContain("إظهار الملف متاح في تطبيق دكان على Windows فقط.");
  expect(calls).toEqual([]);
});

it("removes the old success and reveal error while a new creation is pending or failed", async () => {
  await click("إنشاء نسخة احتياطية الآن");
  bridge(async () => { throw "BACKUP_REVEAL_FAILED"; });
  await click("إظهار الملف في المجلد");
  let refuse: ((reason: Error) => void) | undefined;
  globalThis.fetch = Object.assign(() => new Promise<Response>((_resolve, reject) => {
    refuse = reject;
  }), { preconnect: originalFetch.preconnect });
  await click("إنشاء نسخة احتياطية الآن");
  expect(button("جاري الإنشاء…").disabled).toBe(true);
  expect(host.querySelector('[data-testid="backup-done"]')).toBeNull();
  expect(host.querySelector('[role="alert"]')).toBeNull();
  expect(host.textContent).not.toContain("إظهار الملف في المجلد");
  await act(async () => refuse?.(new Error("write failed")));
  await settle();
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  expect(host.querySelector('[data-testid="backup-done"]')).toBeNull();
  expect(button("إنشاء نسخة احتياطية الآن").disabled).toBe(false);
});

it("maps unsupported native reveal to the Arabic desktop-only explanation", async () => {
  bridge(async () => { throw "BACKUP_REVEAL_UNSUPPORTED"; });
  await click("إنشاء نسخة احتياطية الآن");
  await click("إظهار الملف في المجلد");
  expect(host.querySelector('[role="alert"]')?.textContent).toBe(
    "إظهار الملف متاح في تطبيق دكان على Windows فقط. يمكنك فتح المسار الظاهر يدوياً.",
  );
  expect(host.querySelector('[data-testid="backup-done"]')?.textContent).toContain(completedPath);
});

it("blocks same-turn competing dispatches before React commits pending state", async () => {
  await click("إنشاء نسخة احتياطية الآن");
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
  await settle();
  expect(calls).toHaveLength(1);
  expect(creations).toBe(0);
  await act(async () => finish?.());
  await settle();
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
  await settle();
  expect(creations).toBe(1);
  await act(async () => complete?.(Response.json({ json: { path: completedPath, createdAt: "2026-10-28T09:00:00" } })));
  await settle();
  expect(host.querySelector('[data-testid="backup-done"]')?.textContent).toContain(completedPath);
});

it("prevents a new backup or duplicate reveal until the native call settles", async () => {
  let finish: (() => void) | undefined;
  bridge(() => new Promise<void>((resolve) => { finish = resolve; }));
  await click("إنشاء نسخة احتياطية الآن");
  await click("إظهار الملف في المجلد");
  expect(button("جاري إظهار الملف…").disabled).toBe(true);
  expect(button("إنشاء نسخة احتياطية الآن").disabled).toBe(true);
  await act(async () => finish?.());
  await settle();
  expect(button("إظهار الملف في المجلد").disabled).toBe(false);
  expect(button("إنشاء نسخة احتياطية الآن").disabled).toBe(false);
});
