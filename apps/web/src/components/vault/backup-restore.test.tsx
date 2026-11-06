import { afterEach, beforeEach, expect, it } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import "../../lib/i18n";
import { BackupRestore } from "./backup-restore";
import { clearVaultSessionToken, storeVaultSessionToken } from "../../lib/vault-client";

import type { NativeRestoreReply, RestoreInvokeArgs, RestorePreview } from "../../lib/backup-restore";
// SAFETY: React's documented test flag is the only global changed here.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
type Bridge = { invoke: (command: string, args?: RestoreInvokeArgs) => Promise<NativeRestoreReply> };
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let calls: { command: string; args?: RestoreInvokeArgs }[];
const selected = { id: "native-selection", name: "shop.dknvbak" };
const preview: RestorePreview = { vaultId: "fixture", vaultCreatedAt: "2020-01-01T00:00:00Z", fileModifiedAt: "2026-10-20T12:00:00Z", schemaVersion: 0, supportedSchemaVersion: 1, compatible: true, sha256: "a".repeat(64) };
function bridge(invoke: Bridge["invoke"]) {
  // SAFETY: substitutes only the IPC bridge that the native Webview injects.
  (window as { __TAURI_INTERNALS__?: Bridge }).__TAURI_INTERNALS__ = { invoke };
}
function button(label: string) {
  const found = [...host.querySelectorAll("button")].find(b => b.textContent === label);
  if (!found) throw new Error(`Missing ${label}`);
  return found;
}
async function click(label: string) { await act(async () => { button(label).click(); }); }
async function input(id: string, value: string) {
  const field = host.querySelector<HTMLInputElement>(`#${id}`);
  if (!field) throw new Error(`Missing ${id}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
beforeEach(async () => {
  calls = [];
  storeVaultSessionToken("s".repeat(43));
  bridge(async (command, args) => {
    calls.push({ command, args });
    if (command === "backup_restore_choose") return selected;
    if (command === "backup_restore_preview") return preview;
    return null;
  });
  host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  await act(async () => root.render(<BackupRestore />));
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); clearVaultSessionToken();
  // SAFETY: removes only this test's injected bridge.
  delete (window as { __TAURI_INTERNALS__?: Bridge }).__TAURI_INTERNALS__;
});
it("explains native-only restore without offering a browser file upload", async () => {
  // SAFETY: removes only this test's injected bridge.
  delete (window as { __TAURI_INTERNALS__?: Bridge }).__TAURI_INTERNALS__;
  await act(async () => root.render(<BackupRestore />));
  expect(host.textContent).toContain("تطبيق دكان على Windows");
  expect(button("اختيار نسخة للاستعادة").disabled).toBe(true);
  expect(host.querySelector('input[type="file"]')).toBeNull();
});
it("allows picker cancellation without preview or replacement", async () => {
  bridge(async (command, args) => { calls.push({ command, args }); return null; });
  await click("اختيار نسخة للاستعادة");
  expect(calls.map(c => c.command)).toEqual(["backup_restore_outcome", "backup_restore_choose"]);
  expect(host.querySelector("#restore-backup-secret")).toBeNull();
});
it("shows honest file time and schema, then cancels confirmation without replacement", async () => {
  await click("اختيار نسخة للاستعادة");
  await input("restore-backup-secret", "incoming fixture");
  await click("فحص النسخة");
  expect(host.textContent).toContain("آخر تعديل للملف");
  expect(host.textContent).toContain("ليس تاريخ إنشاء النسخة");
  expect(host.textContent).toContain("ستُحدّث");
  expect(host.textContent).not.toContain("2020");
  await click("إلغاء الاستعادة");
  expect(calls.map(c => c.command)).toEqual(["backup_restore_outcome", "backup_restore_choose", "backup_restore_preview", "backup_restore_cancel"]);
  expect(host.querySelector("#restore-current-secret")).toBeNull();
  await click("اختيار نسخة للاستعادة");
  expect(host.querySelector<HTMLInputElement>("#restore-backup-secret")?.value).toBe("");
});
it("requires explicit confirmation and current credentials, submits only once while waiting", async () => {
  let finish: (() => void) | undefined;
  bridge(async (command, args) => {
    calls.push({ command, args });
    if (command === "backup_restore_choose") return selected;
    if (command === "backup_restore_preview") return preview;
    if (command === "backup_restore_confirmed") return new Promise<void>(resolve => { finish = resolve; });
    return null;
  });
  await click("اختيار نسخة للاستعادة");
  await input("restore-backup-secret", "incoming fixture"); await click("فحص النسخة");
  expect(button("استبدال بيانات المتجر").disabled).toBe(true);
  await input("restore-current-secret", "current fixture");
  await act(async () => host.querySelector<HTMLInputElement>("#restore-confirm")?.click());
  await act(async () => { button("استبدال بيانات المتجر").click(); button("استبدال بيانات المتجر").click(); });
  expect(calls.filter(c => c.command === "backup_restore_confirmed")).toEqual([{ command: "backup_restore_confirmed", args: {
    sessionToken: "s".repeat(43), confirmation: { selectionId: selected.id, expectedSha256: preview.sha256,
      credential: { passphrase: "incoming fixture" }, currentCredential: { passphrase: "current fixture" }, confirmed: true },
  } }]);
  expect(button("إلغاء الاستعادة").disabled).toBe(true);
  expect(host.textContent).toContain("لا تغلق التطبيق");
  await act(async () => finish?.());
});
it("retains the selection after a refused credential and lets the owner retry", async () => {
  let attempts = 0;
  bridge(async (command, args) => {
    calls.push({ command, args });
    if (command === "backup_restore_choose") return selected;
    if (command === "backup_restore_preview") { if (++attempts === 1) throw "VAULT_RESTORE_FAILED"; return preview; }
    return null;
  });
  await click("اختيار نسخة للاستعادة"); await input("restore-backup-secret", "wrong fixture"); await click("فحص النسخة");
  expect(host.querySelector('[role="alert"]')?.textContent).toContain("تحقّق");
  expect(host.textContent).toContain(selected.name);
  await input("restore-backup-secret", "incoming fixture"); await click("فحص النسخة");
  expect(host.querySelector("#restore-confirm")).not.toBeNull();
  expect(calls.filter(c => c.command === "backup_restore_choose")).toHaveLength(1);
});
