import { useReducer } from "react";

import { usePreference } from "../lib/preferences";
import { DEFAULT_PAGE_SIZE, paginationReducer, parsePageSize, serializePageSize } from "../lib/pagination";

/** Server-side pagination preference key: the owner's chosen page size. */
export const PAGE_SIZE_PREFERENCE_KEY = "ui.pageSize";

/**
 * One list's server-side pagination state. Owns the offset and reads/writes
 * the persisted page size, so every list applies the two rules identically:
 *
 * - `reset()` after a search or filter change puts the list back on page 1
 *   (the old offset may no longer address the same rows);
 * - the page size survives navigation and restarts because it lives in the
 *   preferences store, not in component state.
 *
 * The returned `pagination` is what a list query sends as input.
 */
export function usePagination() {
  const size = usePreference(PAGE_SIZE_PREFERENCE_KEY, DEFAULT_PAGE_SIZE, parsePageSize, serializePageSize);
  const [offset, dispatch] = useReducer(paginationReducer, 0);

  return {
    /** request input for the list query */
    pagination: { limit: size.value, offset },
    offset,
    pageSize: size.value,
    /** change the visible page */
    setOffset: (next: number) => dispatch({ type: "goto", offset: next }),
    /** a search or filter changed: back to page 1 */
    reset: () => dispatch({ type: "reset" }),
    /** persist the chosen page size; also puts the list back on page 1 */
    setPageSize: (next: number) => {
      dispatch({ type: "reset" });
      size.setValue(next);
    },
    pageSizePending: size.isPending,
  };
}

export type Pagination = ReturnType<typeof usePagination>;
