import { afterEach, describe, expect, it } from "bun:test";

import { focusByTestId } from "./focus";

/**
 * #248 — one mechanism for "focus the element with this testid, if it is
 * rendered, and tell me whether it moved". The two callers keep their own
 * fallback policies; what is pinned here is the boolean they branch on, because
 * a helper that reported a move it did not make would hide the exact failure
 * the clear-filters hand-offs exist to prevent.
 */

afterEach(() => {
  document.body.innerHTML = "";
  document.body.focus();
});

function button(testId: string): HTMLButtonElement {
  const el = document.createElement("button");
  el.setAttribute("data-testid", testId);
  document.body.appendChild(el);
  return el;
}

describe("focusByTestId", () => {
  it("focuses the rendered element and reports the move", () => {
    const target = button("expense-filter-cat-2");

    expect(focusByTestId("expense-filter-cat-2")).toBe(true);
    expect(document.activeElement).toBe(target);
  });

  it("reports no move and leaves the previous focus alone when the testid is gone", () => {
    const previous = button("expenses-empty-action");
    previous.focus();
    expect(document.activeElement).toBe(previous);

    expect(focusByTestId("expense-filter-cat-2")).toBe(false);
    expect(document.activeElement).toBe(previous);
  });
});
