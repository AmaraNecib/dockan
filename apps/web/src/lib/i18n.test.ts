import { describe, expect, it } from "bun:test";

import i18n, { authErrorKey, serverErrorKey, tError } from "./i18n";

/**
 * Issue #100 — a failure the app can name must say what it is. These cases are
 * the shapes that actually reach the web: better-auth error objects, oRPC
 * message keys, and raw validator sentences.
 */
describe("authErrorKey / serverErrorKey / tError (issue #100)", () => {
  it("gives each known auth failure its own key", () => {
    expect(authErrorKey({ code: "INVALID_USERNAME_OR_PASSWORD" })).toBe("AUTH_INVALID_CREDENTIALS");
    expect(authErrorKey({ code: "INVALID_USERNAME" })).toBe("INVALID_PHONE_NUMBER");
    expect(authErrorKey({ code: "USERNAME_TOO_SHORT" })).toBe("INVALID_PHONE_NUMBER");
    expect(authErrorKey({ code: "USERNAME_TOO_LONG" })).toBe("INVALID_PHONE_NUMBER");
    expect(authErrorKey({ code: "PASSWORD_TOO_SHORT" })).toBe("AUTH_PASSWORD_TOO_SHORT");
    // the rate limiter returns 429 without a code
    expect(authErrorKey({ status: 429, message: "Too many requests. Please try again later." })).toBe("AUTH_TOO_MANY_ATTEMPTS");
  });

  it("renders a distinct Arabic message per known failure", () => {
    const keys = [
      authErrorKey({ code: "INVALID_USERNAME_OR_PASSWORD" }),
      authErrorKey({ code: "INVALID_USERNAME" }),
      authErrorKey({ code: "PASSWORD_TOO_SHORT" }),
      authErrorKey({ status: 429 }),
      "SETUP_ALREADY_DONE" as const,
    ];
    const messages = keys.map((key) => i18n.t(key));
    expect(new Set(messages).size).toBe(messages.length);
    expect(i18n.t(authErrorKey({ code: "INVALID_USERNAME_OR_PASSWORD" }))).toBe(i18n.t("AUTH_INVALID_CREDENTIALS"));
    expect(i18n.t(authErrorKey({ status: 429 }))).toBe(i18n.t("AUTH_TOO_MANY_ATTEMPTS"));
  });

  it("prefers the stable code over the English sentence beside it", () => {
    expect(
      authErrorKey({
        code: "INVALID_USERNAME_OR_PASSWORD",
        message: "expected an Algerian mobile, e.g. +213550123123 or 0550123123",
      }),
    ).toBe("AUTH_INVALID_CREDENTIALS");
  });

  it("keeps translating the stable oRPC keys the app already used", () => {
    expect(tError("CATEGORY_EXISTS")).toBe(i18n.t("CATEGORY_EXISTS"));
    expect(tError("WRONG_BUILD_SECRET")).toBe(i18n.t("WRONG_BUILD_SECRET"));
    expect(tError("RESET_LOCKED")).toBe(i18n.t("RESET_LOCKED"));
  });

  it("falls back to raw validator sentences only when no code arrives", () => {
    expect(serverErrorKey("expected an Algerian mobile, e.g. +213550123123 or 0550123123")).toBe("INVALID_PHONE_NUMBER");
    expect(serverErrorKey("Too many requests. Please try again later.")).toBe("AUTH_TOO_MANY_ATTEMPTS");
    expect(serverErrorKey("Password too short")).toBe("AUTH_PASSWORD_TOO_SHORT");
    expect(authErrorKey({ message: "Invalid username or password" })).toBe("AUTH_INVALID_CREDENTIALS");
    // an unrecognised code still falls through to a matchable sentence
    expect(authErrorKey({ code: "NOT_A_REAL_CODE", message: "Too many requests. Please try again later." })).toBe("AUTH_TOO_MANY_ATTEMPTS");
  });

  it("ships real Arabic copy for every new key", () => {
    const keys = [
      "errorGeneric",
      "AUTH_INVALID_CREDENTIALS",
      "INVALID_PHONE_NUMBER",
      "AUTH_TOO_MANY_ATTEMPTS",
      "AUTH_PASSWORD_TOO_SHORT",
      "SETUP_ALREADY_DONE",
      "phoneExample",
    ] as const;
    for (const key of keys) {
      // a missing key would resolve to the key itself
      expect(i18n.t(key)).not.toBe(key);
      expect(i18n.t(key).length).toBeGreaterThan(0);
    }
    // the failure copy is Arabic, not a raw token
    for (const key of ["errorGeneric", "AUTH_INVALID_CREDENTIALS", "AUTH_TOO_MANY_ATTEMPTS", "AUTH_PASSWORD_TOO_SHORT", "SETUP_ALREADY_DONE"] as const) {
      expect(i18n.t(key)).toMatch(/[\u0600-\u06FF]/);
    }
  });

  it("says something honest and calm when the failure is unknown, never 'unexpected'", () => {
    const generic = i18n.t("errorGeneric");
    expect(tError("a sentence no i18n key matches")).toBe(generic);
    expect(serverErrorKey("a sentence no i18n key matches")).toBe("errorGeneric");
    expect(authErrorKey({ code: "SOME_FUTURE_SERVER_KEY" })).toBe("errorGeneric");
    expect(tError(undefined)).toBe(generic);
    expect(authErrorKey({})).toBe("errorGeneric");
    // the retired key cannot come back through any shape
    expect(tError("UNEXPECTED")).toBe(generic);
    expect(tError("unexpected")).toBe(generic);
    expect(serverErrorKey("a sentence no i18n key matches")).not.toBe("unexpected");
    expect(serverErrorKey("a sentence no i18n key matches")).not.toBe("UNEXPECTED");
  });
});
