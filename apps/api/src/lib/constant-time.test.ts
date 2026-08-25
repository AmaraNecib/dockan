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
});
