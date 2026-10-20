import { describe, expect, it } from "bun:test";
import i18n from "i18next";
import type { TFunction } from "i18next";
import { logEvents } from "@dokan/contracts";

import "./i18n"; // side-effect: initializes i18next (ar)
import { logEventCopy, logMessageCopy } from "./log-copy";

// SAFETY: the initialized i18next instance is a TFunction; the module's default
// export is typed as a broader i18n interface, so the narrowing is asserted here
const t = i18n.t.bind(i18n) as TFunction;

/**
 * #253 — the diagnostics viewer's event badge and startup messages. The badge
 * must never fall back to the raw English code for a known event; the fixture
 * list is the contract constant, so a new event without a `logEvent_` key fails
 * here (mirrors `activity.test.tsx` for the activity tags).
 */
describe("diagnostics log copy (#253)", () => {
  it("gives every log event a translated badge, never the raw code", () => {
    for (const event of logEvents) {
      expect(logEventCopy(t, event), `missing i18n key logEvent_${event}`).not.toBe(event);
      expect(logEventCopy(t, event).trim().length, `empty copy for logEvent_${event}`).toBeGreaterThan(0);
    }
  });

  it("translates every curated startup message, and to the copy its entry names", () => {
    // The Arabic is pinned literally, not just "different from the English".
    // A map entry pointed at the wrong key keeps every English string away and
    // still shows the owner the wrong sentence; `bun run typecheck` cannot see
    // that (all eight keys exist) and `not.toBe(message)` does not catch it.
    const boots: Array<[event: string, message: string, copy: string]> = [
      ["FIRST_TIME_SETUP", "owner account created", "أُنشئ حساب المالك"],
      ["VAULT_CREATED", "vault created and unlocked", "أُنشئت الخزنة وفُتحت"],
      ["VAULT_SETUP_DONE", "vault created; recovery key shown once", "أُنشئت الخزنة؛ عُرض مفتاح الاسترداد مرة واحدة"],
      ["SERVER_BOOT_DONE", "database and auth ready", "قاعدة البيانات والمصادقة جاهزتان"],
      ["SERVER_BOOT_DONE", "vault store and auth ready", "الخزنة والمصادقة جاهزتان"],
      ["SERVER_STARTED", "Dokan API booted", "أُقلع خادم دكان"],
      ["VAULT_PASSPHRASE_CHANGED", "vault passphrase changed", "غُيّرت كلمة مرور الخزنة"],
      ["VAULT_PASSPHRASE_RESET", "vault passphrase set from a recovery key", "عُيّنت كلمة مرور الخزنة من مفتاح استرداد"],
    ];
    for (const [event, message, copy] of boots) {
      const rendered = logMessageCopy(t, event, message);
      expect(rendered, `untranslated message for ${event}: ${message}`).not.toBe(message);
      expect(rendered, `wrong copy for ${event}: ${message}`).toBe(copy);
      expect(rendered).toMatch(/[\u0600-\u06FF]/);
    }
    // eight distinct sentences: a copy-paste that points two entries at one key
    // renders here as a duplicate instead of as plausible-looking Arabic
    expect(new Set(boots.map(([, , copy]) => copy)).size).toBe(boots.length);
  });

  it("keeps the four steps that had no coverage anchored to their own key (#322)", () => {
    // These four were mapped but never read by a test, so swapping any two of
    // them used to pass the whole suite. Each is now read through its key, and
    // the value is checked against the catalogue entry that key names.
    expect(logMessageCopy(t, "VAULT_SETUP_DONE", "vault created; recovery key shown once")).toBe(
      i18n.t("logMessage_vaultSetupDone"),
    );
    expect(logMessageCopy(t, "SERVER_BOOT_DONE", "database and auth ready")).toBe(
      i18n.t("logMessage_serverBootPlaintext"),
    );
    expect(logMessageCopy(t, "VAULT_PASSPHRASE_CHANGED", "vault passphrase changed")).toBe(
      i18n.t("logMessage_vaultPassphraseChanged"),
    );
    expect(logMessageCopy(t, "VAULT_PASSPHRASE_RESET", "vault passphrase set from a recovery key")).toBe(
      i18n.t("logMessage_vaultPassphraseReset"),
    );
  });

  it("distinguishes the plaintext and vault boot messages", () => {
    const plaintext = logMessageCopy(t, "SERVER_BOOT_DONE", "database and auth ready");
    const vault = logMessageCopy(t, "SERVER_BOOT_DONE", "vault store and auth ready");
    expect(plaintext).not.toBe(vault);
  });

  it("renders an unknown event and message raw rather than dropping the row", () => {
    expect(logEventCopy(t, "BRAND_NEW_EVENT")).toBe("BRAND_NEW_EVENT");
    expect(logMessageCopy(t, "LOW_DISK", "disk nearly full")).toBe("disk nearly full");
    // a known event with a dynamic sentence keeps the sentence
    expect(logMessageCopy(t, "VAULT_ATTEMPT_FAILED", "vault attempt 3 failed; locked for 30s")).toBe(
      "vault attempt 3 failed; locked for 30s",
    );
  });
});
