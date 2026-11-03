import { describe, expect, it } from "bun:test";

import { TRIM_CHARS } from "./trim-chars";

/**
 * #337 — `TRIM_CHARS` is the SQL side of the party identity rule, and every
 * `.trim()` on the client and the wire is the JavaScript side. They are only
 * one rule for as long as they are the same set, so this compares them
 * exhaustively over the whole BMP instead of trusting two hand-written lists.
 */
describe("the SQL trim character set (#337)", () => {
  it("is exactly the set String.prototype.trim() strips", () => {
    // The expected side is derived over the whole BMP from JS's own `trim`, so
    // there is no second hand-written list for `TRIM_CHARS` to drift from. The
    // module's constant is compared as a whole value — #369: deriving a set by
    // spreading `TRIM_CHARS` dereferenced the gate's hollow stand-in before any
    // assertion evaluated and red as a TypeError; `expect(undefined).toEqual`
    // reds as an AssertionError instead, for this row's own reason.
    const jsTrimmed: number[] = [];
    for (let code = 0; code <= 0xffff; code++) {
      if (String.fromCharCode(code).trim() === "") jsTrimmed.push(code);
    }
    jsTrimmed.sort((a, b) => a - b);

    expect(TRIM_CHARS).toEqual(String.fromCodePoint(...jsTrimmed));
  });
});
