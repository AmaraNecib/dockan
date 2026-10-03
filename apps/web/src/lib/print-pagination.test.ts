import { describe, expect, it } from "bun:test";

import { paginateLineSlices, textRowUnits, totalUnits, type PrintLineCaps } from "./print-pagination";

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
    // the closing sheet carries only the totals block
    const zeroClosing = { firstClosing: 0, restClosing: 1, firstContinuation: 10, continuation: 9 };
    expect(paginateLineSlices([2], zeroClosing)).toEqual([1, 1]);
  });

  it("falls back to one line per sheet when a line is heavier than every cap", () => {
    expect(paginateLineSlices([99, 99], caps)).toEqual([1, 2]);
  });

  it("moves a line heavier than the first sheet's cap onto a later sheet", () => {
    // the voucher shape: first continuation 11, later continuation 12
    const voucherCaps = { firstClosing: 7, restClosing: 8, firstContinuation: 11, continuation: 12 };
    const slices = paginateLineSlices([12], voucherCaps);
    expect(slices).toEqual([0, 1, 1]);
    // sheet 0 is empty, sheet 1 (cap 12) holds the line, sheet 2 closes
    expect(totalUnits([12].slice(0, slices[0] ?? 0))).toBe(0);
    expect(totalUnits([12].slice(slices[0] ?? 0, slices[1] ?? 0))).toBe(12);
  });
});

/** The capacity sequence the paginator derives for a sheet count. */
function capsSequence(caps: PrintLineCaps, pageCount: number): number[] {
  return Array.from({ length: pageCount }, (_, index) => {
    const isFirst = index === 0;
    const isClosing = index === pageCount - 1;
    if (isClosing) return isFirst ? caps.firstClosing : caps.restClosing;
    return isFirst ? caps.firstContinuation : caps.continuation;
  });
}

/** Brute-force placement (memoised): can `costs` fit `capacities` in order? */
function feasible(costs: readonly number[], capacities: readonly number[]): boolean {
  const memo = new Map<string, boolean>();
  const place = (cursor: number, page: number): boolean => {
    if (cursor >= costs.length) return true;
    if (page >= capacities.length) return false;
    const key = `${cursor}:${page}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result = false;
    let used = 0;
    for (let take = 0; cursor + take <= costs.length; take += 1) {
      if (take > 0) used += costs[cursor + take - 1] ?? 0;
      if (used > (capacities[page] ?? 0)) break;
      if (place(cursor + take, page + 1)) {
        result = true;
        break;
      }
    }
    memo.set(key, result);
    return result;
  };
  return place(0, 0);
}

/** The smallest sheet count a placement exists for, or null when none does. */
function minimalPages(costs: readonly number[], caps: PrintLineCaps): number | null {
  for (let pages = 1; pages <= costs.length + 2; pages += 1) {
    if (feasible(costs, capsSequence(caps, pages))) return pages;
  }
  return null;
}

describe("paginateLineSlices — capacity invariant", () => {
  it("never emits a sheet over its cap for random feasible vectors", () => {
    // deterministic LCG so the sweep cannot flake
    let seed = 20261001;
    const next = () => {
      seed = (seed * 48271) % 2147483647;
      return seed;
    };
    let checked = 0;
    for (let iteration = 0; iteration < 300; iteration += 1) {
      const lineCount = 1 + (next() % 5);
      const costs = Array.from({ length: lineCount }, () => 1 + (next() % 8));
      const caps: PrintLineCaps = {
        firstClosing: 1 + (next() % 12),
        restClosing: 1 + (next() % 12),
        firstContinuation: 1 + (next() % 12),
        continuation: 1 + (next() % 12),
      };
      const minimal = minimalPages(costs, caps);
      if (minimal === null) continue; // no placement at all: the documented fallback
      checked += 1;
      const slices = paginateLineSlices(costs, caps);
      // minimal sheet count, all lines once and in order
      expect(slices).toHaveLength(minimal);
      expect(slices[slices.length - 1]).toBe(costs.length);
      let cursor = 0;
      slices.forEach((end, index) => {
        expect(end).toBeGreaterThanOrEqual(cursor);
        const isFirst = index === 0;
        const isClosing = index === slices.length - 1;
        const cap = isClosing ? (isFirst ? caps.firstClosing : caps.restClosing) : isFirst ? caps.firstContinuation : caps.continuation;
        expect(totalUnits(costs.slice(cursor, end))).toBeLessThanOrEqual(cap);
        cursor = end;
      });
    }
    // the sweep must not silently degenerate into zero cases
    expect(checked).toBeGreaterThan(100);
  });
});
