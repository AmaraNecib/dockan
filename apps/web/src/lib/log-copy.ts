import type { TFunction } from "i18next";

/**
 * #253 — the diagnostics viewer printed the api's JSONL `event` code and
 * `message` verbatim, so a fresh install showed the owner English boot rows
 * (`FIRST_TIME_SETUP` / "owner account created", `VAULT_CREATED` / "vault
 * created and unlocked", `SERVER_BOOT_DONE`, `SERVER_STARTED`). Those strings
 * have exactly one source: the `logger.info(event, message, ctx)` call sites in
 * `apps/api/src` (`main.ts`, `lib/vault/*`, `rpc/router.ts`). This module is the
 * web-side catalogue for them and nothing else — the api keeps logging English
 * (the JSONL is the support artifact).
 *
 * The mapping is deliberately bounded: every event BADGE is translated (a closed
 * vocabulary), and the message BODY only for the startup sentences a normal
 * owner sees. A dynamic failure sentence ("vault attempt 3 failed; locked for
 * 30s") stays raw, because rewriting it would move the debugging text further
 * from the log for no owner benefit. An unknown event or message also renders
 * raw, so nothing is ever silently dropped.
 */

/** Startup-path messages, keyed by `event::message` (the two SERVER_BOOT_DONE
 * variants are the plaintext and vault boot steps). */
const STARTUP_MESSAGES = new Map<string, string>([
  ["FIRST_TIME_SETUP::owner account created", "logMessage_firstTimeSetup"],
  ["VAULT_CREATED::vault created and unlocked", "logMessage_vaultCreated"],
  ["VAULT_SETUP_DONE::vault created; recovery key shown once", "logMessage_vaultSetupDone"],
  ["SERVER_BOOT_DONE::database and auth ready", "logMessage_serverBootPlaintext"],
  ["SERVER_BOOT_DONE::vault store and auth ready", "logMessage_serverBootVault"],
  ["SERVER_STARTED::Dokan API booted", "logMessage_serverStarted"],
  ["VAULT_PASSPHRASE_CHANGED::vault passphrase changed", "logMessage_vaultPassphraseChanged"],
  ["VAULT_PASSPHRASE_RESET::vault passphrase set from a recovery key", "logMessage_vaultPassphraseReset"],
]);

/**
 * The Arabic label for a log event badge. A missing key returns the raw event
 * code (i18next returns `defaultValue` literally), which is the pre-#253
 * behaviour and what keeps a new event visible.
 */
export function logEventCopy(t: TFunction, event: string): string {
  return t(`logEvent_${event}`, { defaultValue: event });
}

/**
 * The Arabic sentence for a log message, or the raw message when it is not a
 * curated startup step.
 */
export function logMessageCopy(t: TFunction, event: string, message: string): string {
  const key = STARTUP_MESSAGES.get(`${event}::${message}`);
  if (key === undefined) return message;
  return t(key, { defaultValue: message });
}
