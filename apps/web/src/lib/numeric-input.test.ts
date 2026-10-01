import { describe, expect, it } from "bun:test";

import { resolveOpeningStock } from "./numeric-input";

/**
 * The one opening-stock rule both item forms call (issue #125): the plain
 * create path reads blank as zero, the scan's "create with stock" path
 * requires a positive whole number, and an unreadable value is reported as
 * its own reason so each form can show its own message.
 */
describe("resolveOpeningStock (shared opening-stock rule, issue #125)", () => {
  it("reads a blank field as zero on the plain path (no opening movement)", () => {
    expect(resolveOpeningStock("", false)).toEqual({ ok: true, value: 0 });
    expect(resolveOpeningStock("   ", false)).toEqual({ ok: true, value: 0 });
  });

  it("accepts an explicit zero on the plain path", () => {
    expect(resolveOpeningStock("0", false)).toEqual({ ok: true, value: 0 });
  });

  it("requires a positive value when the path promised an opening movement", () => {
    expect(resolveOpeningStock("", true)).toEqual({ ok: false, reason: "required" });
    expect(resolveOpeningStock("   ", true)).toEqual({ ok: false, reason: "required" });
    expect(resolveOpeningStock("0", true)).toEqual({ ok: false, reason: "required" });
    expect(resolveOpeningStock("00", true)).toEqual({ ok: false, reason: "required" });
  });

  it("reports an unreadable value as invalid, even when a value is required", () => {
    for (const bad of ["-1", "2.5", "abc", "1e3", "٥"]) {
      expect(resolveOpeningStock(bad, false)).toEqual({ ok: false, reason: "invalid" });
      expect(resolveOpeningStock(bad, true)).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("accepts positive whole values on both paths and trims them", () => {
    expect(resolveOpeningStock("7", false)).toEqual({ ok: true, value: 7 });
    expect(resolveOpeningStock(" 7 ", true)).toEqual({ ok: true, value: 7 });
    expect(resolveOpeningStock("0042", true)).toEqual({ ok: true, value: 42 });
  });

  it("rejects values too large to represent exactly", () => {
    expect(resolveOpeningStock("9007199254740993", true)).toEqual({ ok: false, reason: "invalid" });
    expect(resolveOpeningStock("9007199254740993", false)).toEqual({ ok: false, reason: "invalid" });
  });
});
