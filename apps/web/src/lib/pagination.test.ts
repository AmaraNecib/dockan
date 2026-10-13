import { describe, expect, it } from "bun:test";

import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  clampOffset,
  clampPageSize,
  isPageSize,
  pageCount,
  pageRange,
  pagerPages,
  paginationReducer,
  parsePageSize,
  serializePageSize,
} from "./pagination";

describe("paginationReducer — the offset-reset rule", () => {
  it("returns to the first page on a search or filter change", () => {
    expect(paginationReducer(40, { type: "reset" })).toBe(0);
    expect(paginationReducer(0, { type: "reset" })).toBe(0);
  });

  it("moves to an explicit page and rejects a negative or non-integer offset", () => {
    expect(paginationReducer(0, { type: "goto", offset: 30 })).toBe(30);
    expect(paginationReducer(30, { type: "goto", offset: 0 })).toBe(0);
    expect(paginationReducer(30, { type: "goto", offset: -10 })).toBe(0);
    expect(paginationReducer(30, { type: "goto", offset: 1.5 })).toBe(0);
  });
});

describe("page size", () => {
  it("accepts a positive whole number inside the server ceiling", () => {
    expect(isPageSize(1)).toBe(true);
    expect(isPageSize(100)).toBe(true);
    expect(isPageSize(MAX_PAGE_SIZE)).toBe(true);
    expect(isPageSize(0)).toBe(false);
    expect(isPageSize(-5)).toBe(false);
    expect(isPageSize(1.5)).toBe(false);
    expect(isPageSize(MAX_PAGE_SIZE + 1)).toBe(false);
    expect(isPageSize(Number.NaN)).toBe(false);
  });

  it("falls back to the default for anything invalid", () => {
    expect(clampPageSize(25)).toBe(25);
    expect(clampPageSize(0)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampPageSize(Number.NaN)).toBe(DEFAULT_PAGE_SIZE);
    expect(clampPageSize(10_000)).toBe(DEFAULT_PAGE_SIZE);
  });

  it("round-trips through the persisted preference encoding", () => {
    expect(parsePageSize(undefined)).toBe(DEFAULT_PAGE_SIZE);
    expect(parsePageSize("50")).toBe(50);
    expect(parsePageSize("abc")).toBe(DEFAULT_PAGE_SIZE);
    expect(parsePageSize("0")).toBe(DEFAULT_PAGE_SIZE);
    expect(serializePageSize(100)).toBe("100");
    expect(serializePageSize(0)).toBe(String(DEFAULT_PAGE_SIZE));
  });
});

describe("page math", () => {
  it("counts pages, always at least one", () => {
    expect(pageCount(0, 10)).toBe(1);
    expect(pageCount(10, 10)).toBe(1);
    expect(pageCount(11, 10)).toBe(2);
    expect(pageCount(100, 25)).toBe(4);
    expect(pageCount(101, 25)).toBe(5);
  });

  it("clamps an offset inside the list", () => {
    expect(clampOffset(0, 25, 10)).toBe(0);
    expect(clampOffset(10, 25, 10)).toBe(10);
    expect(clampOffset(20, 25, 10)).toBe(20);
    // past the end snaps to the last page, and an empty list to zero
    expect(clampOffset(999, 25, 10)).toBe(20);
    expect(clampOffset(999, 0, 10)).toBe(0);
    expect(clampOffset(-5, 25, 10)).toBe(0);
  });

  it("reports the 1-based row window for the copy", () => {
    expect(pageRange(0, 10, 25)).toEqual({ from: 1, to: 10 });
    expect(pageRange(10, 10, 25)).toEqual({ from: 11, to: 20 });
    expect(pageRange(20, 10, 25)).toEqual({ from: 21, to: 25 });
    expect(pageRange(0, 10, 0)).toEqual({ from: 0, to: 0 });
  });
});

describe("pagerPages", () => {
  it("shows the ends, the current page and its neighbours", () => {
    expect(pagerPages(1, 10)).toEqual([1, 2, "ellipsis", 10]);
    expect(pagerPages(5, 10)).toEqual([1, "ellipsis", 4, 5, 6, "ellipsis", 10]);
    expect(pagerPages(10, 10)).toEqual([1, "ellipsis", 9, 10]);
  });

  it("collapses a short list with no gaps", () => {
    expect(pagerPages(1, 3)).toEqual([1, 2, 3]);
    expect(pagerPages(2, 3)).toEqual([1, 2, 3]);
  });

  it("stays sane at the boundaries", () => {
    expect(pagerPages(0, 1)).toEqual([1]);
    expect(pagerPages(99, 1)).toEqual([1]);
  });
});
