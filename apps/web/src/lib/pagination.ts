import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, PAGE_SIZE_PRESETS } from "@dokan/contracts";

/**
 * Pagination math shared by every list page and the shared `<Pager>`. Pure
 * functions (no React, no DOM) so the offset/page rules are unit-tested
 * without mounting anything.
 *
 * The rule the whole app depends on: a search or filter change resets the
 * offset to 0 (`paginationReducer` with a `reset` action), while the chosen
 * page size is kept — it is a preference, not part of the query.
 */
export { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, PAGE_SIZE_PRESETS };

/** The two actions a list's offset can receive. */
export type PaginationAction =
  | { type: "goto"; offset: number }
  /** a search or filter changed: always back to the first page */
  | { type: "reset" };

/** The one implementation of the offset-reset rule. */
export function paginationReducer(offset: number, action: PaginationAction): number {
  if (action.type === "reset") return 0;
  return Number.isInteger(action.offset) && action.offset > 0 ? action.offset : 0;
}

/** A page size is valid when it is a positive whole number inside the server
 * ceiling (`MAX_PAGE_SIZE`). */
export function isPageSize(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= MAX_PAGE_SIZE;
}

/** Coerce a persisted or typed value; anything invalid falls back to the
 * default so a corrupt preference can never break a list request. */
export function clampPageSize(value: number): number {
  return isPageSize(value) ? value : DEFAULT_PAGE_SIZE;
}

/** Total pages for a list; always at least 1 so an empty list has page 1. */
export function pageCount(total: number, pageSize: number): number {
  const size = clampPageSize(pageSize);
  if (!Number.isFinite(total) || total <= 0) return 1;
  return Math.max(1, Math.ceil(total / size));
}

/** Keep an offset inside the list: a page past the end snaps to the last. */
export function clampOffset(offset: number, total: number, pageSize: number): number {
  const size = clampPageSize(pageSize);
  const last = (pageCount(total, size) - 1) * size;
  if (!Number.isInteger(offset) || offset < 0) return 0;
  return Math.min(offset, last);
}

/** 1-based first and last row numbers shown, for «عرض X–Y من Z». */
export function pageRange(offset: number, pageSize: number, total: number) {
  if (!Number.isFinite(total) || total <= 0) return { from: 0, to: 0 };
  const size = clampPageSize(pageSize);
  const start = clampOffset(offset, total, size);
  return { from: start + 1, to: Math.min(start + size, total) };
}

/**
 * The numbered page buttons, with `"ellipsis"` gaps. Always shows the first
 * and last page plus the current page and its neighbours, so a 40-page list
 * stays a handful of buttons.
 */
export function pagerPages(currentPage: number, pages: number): Array<number | "ellipsis"> {
  const last = Math.max(1, Math.floor(pages));
  const page = Math.min(Math.max(1, Math.floor(currentPage)), last);
  const wanted = new Set<number>([1, last, page, page - 1, page + 1]);
  const sorted = [...wanted].filter((n) => n >= 1 && n <= last).sort((a, b) => a - b);
  const out: Array<number | "ellipsis"> = [];
  let previous = 0;
  for (const n of sorted) {
    if (n - previous > 1) out.push("ellipsis");
    out.push(n);
    previous = n;
  }
  return out;
}

/** Read the persisted page size; a missing or non-numeric value is the default. */
export function parsePageSize(raw: string | undefined): number {
  if (raw === undefined) return DEFAULT_PAGE_SIZE;
  const parsed = Number(raw);
  return clampPageSize(parsed);
}

export function serializePageSize(value: number): string {
  return String(clampPageSize(value));
}
