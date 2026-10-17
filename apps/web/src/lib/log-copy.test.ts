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

  it("translates the first-run boot messages the owner named", () => {
    const boots: [string, string][] = [
      ["FIRST_TIME_SETUP", "owner account created"],
      ["VAULT_CREATED", "vault created and unlocked"],
      ["VAULT_SETUP_DONE", "vault created; recovery key shown once"],
      ["SERVER_BOOT_DONE", "database and auth ready"],
      ["SERVER_BOOT_DONE", "vault store and auth ready"],
      ["SERVER_STARTED", "Dokan API booted"],
    ];
    for (const [event, message] of boots) {
      const copy = logMessageCopy(t, event, message);
      expect(copy, `untranslated message for ${event}: ${message}`).not.toBe(message);
      expect(copy.trim().length).toBeGreaterThan(0);
    }
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
