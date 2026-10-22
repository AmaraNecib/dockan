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
    const jsTrimmed = new Set<number>();
    for (let code = 0; code <= 0xffff; code++) {
      if (String.fromCharCode(code).trim() === "") jsTrimmed.add(code);
    }
    const sqlTrimmed = new Set([...TRIM_CHARS].map((char) => char.codePointAt(0) ?? -1));

    expect([...sqlTrimmed].sort((a, b) => a - b)).toEqual([...jsTrimmed].sort((a, b) => a - b));
  });
});
