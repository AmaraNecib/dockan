import { describe, expect, it } from "bun:test";

import { constantTimeEqual } from "./constant-time";

describe("constantTimeEqual", () => {
  it("returns true for equal strings", () => {
    expect(constantTimeEqual("dokan-secret-123", "dokan-secret-123")).toBe(true);
    expect(constantTimeEqual("", "")).toBe(true);
  });

  it("returns false for a same-length mismatch without throwing", () => {
    // timingSafeEqual itself throws on unequal buffers; the guard must turn
    // that into false so callers can branch on one boolean
    expect(constantTimeEqual("dokan-secret-123", "dokan-secret-124")).toBe(false);
    expect(constantTimeEqual("aaaaaaaaaa", "baaaaaaaaa")).toBe(false);
  });

  it("returns false for wrong-length inputs", () => {
    expect(constantTimeEqual("short", "a-much-longer-guess")).toBe(false);
    expect(constantTimeEqual("", "x")).toBe(false);
    expect(constantTimeEqual("x", "")).toBe(false);
  });

  it("never throws on non-ASCII inputs with equal code-unit but different byte length", () => {
    // "é" and "a" are both one UTF-16 unit but 2 vs 1 UTF-8 bytes — the guard
    // must compare bytes or timingSafeEqual throws (critic finding)
    expect(() => constantTimeEqual("é", "a")).not.toThrow();
    expect(constantTimeEqual("é", "a")).toBe(false);
    expect(() => constantTimeEqual("مرحبا", "abcde")).not.toThrow();
  });

  it("handles non-ASCII equal-byte-length mismatches and matches", () => {
    // both sides are 3 UTF-8 bytes with different content
    expect(constantTimeEqual("éa", "aé")).toBe(false);
    expect(constantTimeEqual("مرحبا", "مرحبا")).toBe(true);
  });
});
