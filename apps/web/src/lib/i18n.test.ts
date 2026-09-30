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
    // better-auth's own minimum is 8, so its code must not borrow our 4-char copy
    expect(authErrorKey({ code: "PASSWORD_TOO_SHORT" })).toBe("errorGeneric");
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
    // the sentence a Zod validator actually emits; "Password too short" is not
    // produced by anything, so it must not resolve to auth copy
    expect(serverErrorKey("Too small: expected string to have >=4 characters")).toBe("AUTH_PASSWORD_TOO_SHORT");
    expect(serverErrorKey("Password too short")).toBe("errorGeneric");
    expect(authErrorKey({ message: "Invalid username or password" })).toBe("AUTH_INVALID_CREDENTIALS");
    // an unrecognised code still falls through to a matchable sentence
    expect(authErrorKey({ code: "NOT_A_REAL_CODE", message: "Too many requests. Please try again later." })).toBe("AUTH_TOO_MANY_ATTEMPTS");
  });

  it("does not give better-auth's own minimum as our minimum", () => {
    // better-auth's username plugin enforces its own minPasswordLength (8), so
    // its PASSWORD_TOO_SHORT would tell the owner to use 4 and loop forever
    expect(authErrorKey({ code: "PASSWORD_TOO_SHORT", message: "Password too short" })).toBe("errorGeneric");
  });

  it("isolates the ASCII phone runs inside the RTL sentence", () => {
    const copy = i18n.t("INVALID_PHONE_NUMBER", { phoneExample: i18n.t("phoneExample"), phoneExampleIntl: i18n.t("phoneExampleIntl") });
    // a bare ASCII run in an RTL sentence can render with its sign displaced
    expect(copy).toContain(`\u2066${i18n.t("phoneExample")}\u2069`);
    expect(copy).toContain(`\u2066${i18n.t("phoneExampleIntl")}\u2069`);
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
    // a UI key a stray Error happened to carry is not an error key
    expect(tError("password")).toBe(generic);
    expect(serverErrorKey("a sentence no i18n key matches")).not.toBe("unexpected");
    expect(serverErrorKey("a sentence no i18n key matches")).not.toBe("UNEXPECTED");
  });
});
