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

  it("falls back to one line per sheet when a line is heavier than every cap", () => {
    expect(paginateLineSlices([99, 99], caps)).toEqual([1, 2]);
  });
});
