import { describe, expect, it } from "bun:test";

import { tokenMatches } from "./boot-token";

describe("tokenMatches (PR #51 finding 1 — sidecar identity)", () => {
  it("accepts the exact token", () => {
    expect(tokenMatches("abc123", "abc123")).toBe(true);
  });

  it("rejects any different token", () => {
    expect(tokenMatches("abc124", "abc123")).toBe(false);
    expect(tokenMatches("ABC123", "abc123")).toBe(false);
  });

  it("rejects missing or empty input", () => {
    expect(tokenMatches(undefined, "abc123")).toBe(false);
    expect(tokenMatches(null, "abc123")).toBe(false);
    expect(tokenMatches("", "abc123")).toBe(false);
  });

  it("rejects a token when the expected value is empty", () => {
    // the endpoint must never accept anything when no token is configured
    expect(tokenMatches("anything", "")).toBe(false);
  });

  it("does not leak length: unequal-length inputs compare via hash", () => {
    expect(tokenMatches("a", "abc")).toBe(false);
    expect(tokenMatches("abcd", "abc")).toBe(false);
  });

  it("is deterministic and whitespace-sensitive", () => {
    expect(tokenMatches(" abc123", "abc123")).toBe(false);
    expect(tokenMatches("abc123 ", "abc123")).toBe(false);
  });
});