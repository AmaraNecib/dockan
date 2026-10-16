import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

import { VAULT_ERROR_CODES } from "@dokan/contracts";

import i18n, { PHONE_EXAMPLE_INTL, PHONE_EXAMPLE_LOCAL, authErrorKey, serverErrorKey, tError } from "./i18n";

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
    expect(tError("SETUP_DATABASE_NOT_EMPTY")).toBe(i18n.t("SETUP_DATABASE_NOT_EMPTY"));
  });

  it("names the moved opening-balance destination instead of the silent fallback (#184 round 3)", () => {
    // the page passes this refusal to tError(); while the key was missing the
    // owner got errorGeneric and never learned the destination had changed
    expect(serverErrorKey("OPENING_BALANCE_TARGET_CHANGED")).toBe("OPENING_BALANCE_TARGET_CHANGED");
    const copy = tError("OPENING_BALANCE_TARGET_CHANGED");
    expect(copy).not.toBe(i18n.t("errorGeneric"));
    expect(copy).toMatch(/[\u0600-\u06FF]/);
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

/** Issue #120 — the UI uses the canonical role words, never the retired «الطرف». */
/**
 * Round 6 — translation single-source: the API returns stable vault codes and
 * no Arabic; every code it (or the web vault client) can emit must have its
 * own key here, so no raw code can ever reach the owner.
 */
describe("vault error codes stay translatable (round 6)", () => {
  it("every stable vault code has its own Arabic key", () => {
    for (const code of VAULT_ERROR_CODES) {
      // serverErrorKey resolves a code only when its i18n key exists
      expect(serverErrorKey(code), `missing i18n key for ${code}`).toBe(code);
      const copy = tError(code);
      expect(copy, `missing copy for ${code}`).not.toBe(code);
      expect(copy.length, `empty copy for ${code}`).toBeGreaterThan(0);
      expect(copy, `non-Arabic copy for ${code}`).toMatch(/[\u0600-\u06FF]/);
    }
  });
});

describe("opening-balance refusals stay translatable (review round 3)", () => {
  /** Every refusal `suppliersOpeningBalances` / `suppliersResolveName` can
   * surface to the opening-balance screen, plus the session gate they both run
   * behind. `serverErrorKey` falls back to `errorGeneric` SILENTLY, so a missing
   * key is invisible unless the whole family is enumerated like this. */
  const OPENING_BALANCE_REFUSALS = [
    "OPENING_BALANCE_EXISTS",
    "OPENING_BALANCE_TARGET_CHANGED",
    "DUPLICATE_OPENING_BALANCE_ROW",
    "DUPLICATE_ADJUSTMENT",
    "PARTY_NOT_FOUND",
    "ADJUSTMENT_EXCEEDS_REMAINING",
    "ADJUSTMENT_INVOICE_DIRECTION",
    "ADJUSTMENT_LINK_INVALID",
    "ADJUSTMENT_INVALID_AMOUNT",
    "ADJUSTMENT_NOT_TRANSACTIONAL",
    "INVOICE_NOT_PURCHASE",
    "AUTH_REQUIRED",
    "FORBIDDEN",
  ] as const;

  it("gives every refusal its own Arabic key, never the silent fallback", () => {
    const copies: string[] = [];
    for (const key of OPENING_BALANCE_REFUSALS) {
      expect(serverErrorKey(key), `missing i18n key for ${key}`).toBe(key);
      expect(serverErrorKey(key), `${key} fell back to errorGeneric`).not.toBe("errorGeneric");
      const copy = tError(key);
      expect(copy, `missing copy for ${key}`).not.toBe(key);
      expect(copy.length, `empty copy for ${key}`).toBeGreaterThan(0);
      expect(copy, `non-Arabic copy for ${key}`).toMatch(/[\u0600-\u06FF]/);
      copies.push(copy);
    }
    // distinctness: two refusals sharing one sentence would still pass existence
    // checks while telling the owner the wrong thing
    expect(new Set(copies).size, "duplicate Arabic copy across refusals").toBe(copies.length);
  });
});

/**
 * Issue #113 — every refusal the router can send must be a translatable key.
 * `serverErrorKey` gates on SCREAMING_SNAKE plus a resource entry and returns
 * `errorGeneric` silently otherwise, so a missing or non-conforming code is
 * invisible without a scan that reads the router itself. Precedent for reading
 * real source in a test: `cell-ltr.test.ts`.
 */
describe("every router refusal stays translatable (issue #113)", () => {
  const routerSource = new URL("../../../api/src/rpc/router.ts", import.meta.url);
  const ledgerSource = new URL("../../../api/src/lib/stock-ledger.ts", import.meta.url);
  const messageField = /message:\s*"([^"]*)"/g;
  const screamingSnake = /^[A-Z][A-Z0-9_]*$/;

  function quotedIn(text: string): string[] {
    const codes: string[] = [];
    for (const match of text.matchAll(/"([^"]+)"/g)) {
      if (match[1] !== undefined) codes.push(match[1]);
    }
    return codes;
  }

  /**
   * Every message the router can hand the client. Most are `message: "CODE"`
   * literals. Two are forwarded by identifier and a regex cannot see their
   * value, so their source unions are read instead: `message: error.code`
   * (`StockLedgerError`) and `message: phoneKey` (`withPartyPhoneRefusals`).
   * The guard below fails if those shapes change, so this scan cannot silently
   * lose them.
   */
  function routerRefusals(): string[] {
    const router = readFileSync(routerSource, "utf8");
    const codes = new Set<string>();
    for (const match of router.matchAll(messageField)) {
      const code = match[1];
      // an empty `message: ""` is added so the SCREAMING_SNAKE check below
      // fails on it instead of it slipping through unseen
      if (code !== undefined) codes.add(code);
    }
    for (const code of quotedIn(/phoneKey:\s*([^,)]+)/.exec(router)?.[1] ?? "")) codes.add(code);
    for (const code of quotedIn(/readonly code:\s*([^,)]+)/.exec(readFileSync(ledgerSource, "utf8"))?.[1] ?? "")) codes.add(code);
    return [...codes].sort();
  }

  it("scans the real router, not an empty list", () => {
    // a moved file or a broken regex would otherwise pass every check below
    expect(routerRefusals().length).toBeGreaterThan(40);
  });

  it("names the identifier-forwarded refusals it reads from unions", () => {
    // a named-type refactor (phoneKey: PartyPhoneKey) would make the union
    // extractor return nothing while the shape guard above still passes, so the
    // codes are named here and a refactor fails loudly instead of losing them
    expect(routerRefusals()).toEqual(expect.arrayContaining([
      "STOCK_NEGATIVE",
      "CUSTOMER_PHONE_EXISTS",
      "SUPPLIER_PHONE_EXISTS",
    ]));
  });

  it("gives every refusal real Arabic copy, never the silent fallback", () => {
    for (const code of routerRefusals()) {
      // the regex `serverErrorKey` gates on; a new non-conforming code fails
      // here instead of quietly rendering `errorGeneric`
      expect(code, `${code} is not a SCREAMING_SNAKE server key`).toMatch(screamingSnake);
      // the ONE shared mapping path must land on a real key. An aliased code
      // (`INVALID_PARTY_PHONE` → `partyPhoneInvalid`) legitimately resolves to
      // a different key, so compare against the fallback, not against the code.
      expect(serverErrorKey(code), `${code} fell back to errorGeneric`).not.toBe("errorGeneric");
      const copy = tError(code);
      expect(copy, `missing copy for ${code}`).not.toBe(code);
      expect(copy, `empty copy for ${code}`).not.toBe("");
      expect(copy, `non-Arabic copy for ${code}`).toMatch(/[\u0600-\u06FF]/);
    }
  });
});

describe("party labels (issue 120)", () => {
  it("labels an invoice's party with the canonical زبون/مورّد pair", () => {
    expect(i18n.t("invoiceParty")).toContain("الزبون");
    expect(i18n.t("invoiceParty")).toContain("المورّد");
    expect(i18n.t("invoiceParty")).not.toContain("الطرف");
  });

  it("names both roles and their role-specific phone conflicts", () => {
    expect(i18n.t("partyCustomer")).toBe("زبون");
    expect(i18n.t("partySupplier")).toBe("مورّد");
    expect(i18n.t("CUSTOMER_PHONE_EXISTS")).toContain("زبون");
    expect(i18n.t("SUPPLIER_PHONE_EXISTS")).toContain("مورّد");
  });

  it("translates the non-numeric phone refusal to clear isolated Arabic (issue 129)", () => {
    expect(serverErrorKey("INVALID_PARTY_PHONE")).toBe("partyPhoneInvalid");
    const copy = tError("INVALID_PARTY_PHONE");
    expect(copy).toMatch(/[\u0600-\u06FF]/);
    expect(copy).toContain(`\u2066${PHONE_EXAMPLE_LOCAL}\u2069`);
    expect(copy).toContain(`\u2066${PHONE_EXAMPLE_INTL}\u2069`);
  });
});
