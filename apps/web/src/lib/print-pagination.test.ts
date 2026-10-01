import { describe, expect, it } from "bun:test";

import { paginateLineSlices, textRowUnits, totalUnits } from "./print-pagination";

const caps = { firstClosing: 6, restClosing: 6, firstContinuation: 10, continuation: 9 };

describe("textRowUnits", () => {
  it("counts one row per charsPerRow, with a minimum of one", () => {
    expect(textRowUnits("", 32)).toBe(1);
    expect(textRowUnits("x".repeat(32), 32)).toBe(1);
    expect(textRowUnits("x".repeat(33), 32)).toBe(2);
    expect(textRowUnits("x".repeat(64), 32)).toBe(2);
  });
});

describe("paginateLineSlices", () => {
  it("returns one closing sheet for no lines", () => {
    expect(paginateLineSlices([], caps)).toEqual([0]);
  });

  it("keeps a short document on one sheet", () => {
    expect(paginateLineSlices([1, 1, 1, 1, 1], caps)).toEqual([5]);
  });

  it("never overruns a sheet when weights are uneven", () => {
    const costs = [6, 5, 1, 1, 1, 1, 1];
    const slices = paginateLineSlices(costs, caps);
    expect(slices).toEqual([1, 2, 7]);
    // first non-closing 10, later non-closing 9, closing 6
    const capacities = [10, 9, 6];
    let cursor = 0;
    slices.forEach((end, index) => {
      expect(totalUnits(costs.slice(cursor, end))).toBeLessThanOrEqual(capacities[index] ?? 0);
      cursor = end;
    });
  });

  it("allows a zero-line closing sheet when the line fits on an earlier sheet", () => {
    // one 2-unit line whose closing room is 0: the line goes on sheet 1 and
    // the closing sheet carries only the totals/payment block
    const zeroClosing = { firstClosing: 0, restClosing: 1, firstContinuation: 10, continuation: 9 };
    expect(paginateLineSlices([2], zeroClosing)).toEqual([1, 1]);
  });

  it("falls back to one line per sheet when a line is heavier than every cap", () => {
    expect(paginateLineSlices([99, 99], caps)).toEqual([1, 2]);
  });
});
