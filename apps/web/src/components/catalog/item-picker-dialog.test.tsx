import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "../../lib/i18n"; // side-effect: initializes i18next (ar) for useTranslation
import type { CatalogMatch, Item } from "@dokan/contracts";

const item = (id: string, name: string, barcode?: string): Item => ({
  id,
  name,
  categoryId: "00000000-0000-4000-8000-000000000001",
  costPrice: 100,
  sellingPrice: 200,
  lowStockThreshold: 0,
  stockOnHand: 5,
  barcode: barcode ?? null,
  createdAt: "2026-01-01T08:00:00",
  updatedAt: "2026-01-01T08:00:00",
});

const match = (it: Item, matchedBy: CatalogMatch["matchedBy"]): CatalogMatch => ({
  item: it,
  category: null,
  matchedBy,
});

/** selection holder avoids TS narrowing a callback-assigned local to never */
interface SelectionState {
  selected: Item | null;
}

/** mirrors the catalogSearch output shape; the api-local result type is not in contracts */
interface SearchFixture {
  exact: CatalogMatch | null;
  matches: CatalogMatch[];
}

let fixture: SearchFixture = { exact: null, matches: [] };

interface RenderedPicker {
  closeCalls: number;
}

let mountedRoots: Array<{ unmount: () => void }> = [];
let previousPickers: RenderedPicker[] = [];

// The picker resolves matches through orpc.catalogSearch.queryOptions; mock
// the rpc module so tests drive fixtures without a network seam.
mock.module("@/lib/rpc", () => ({
  orpc: {
    catalogSearch: {
      queryOptions: ({ input }: { input: { query: string } }) => ({
        queryKey: ["catalogSearch", input],
        queryFn: async (): Promise<SearchFixture> => fixture,
      }),
    },
  },
  rpcClient: {},
}));

const { ItemPickerDialog } = await import("./item-picker-dialog");

/** renders the dialog open; inference keeps the host/root pair concrete */
function renderPicker(handlers: { onClose: () => void; onSelect: (item: Item) => void }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  const picker: RenderedPicker = { closeCalls: 0 };
  const root = createRoot(host);
  mountedRoots.push(root);
  previousPickers.push(picker);
  act(() => {
    root.render(
      <QueryClientProvider client={client}>
        <ItemPickerDialog
          open={true}
          onClose={() => {
            picker.closeCalls++;
            handlers.onClose();
          }}
          onSelect={handlers.onSelect}
        />
      </QueryClientProvider>,
    );
  });
  return { host };
}

/** act-wrapped polling so every deferred state update stays inside React */
const waitFor = async (host: HTMLElement, predicate: () => boolean) => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error("condition not met within timeout");
};

const typeQuery = async (host: HTMLElement, text: string) => {
  const input = host.querySelector("input")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  // debounce is 150 ms real time; wait past it AND until the fixture has
  // actually rendered, so callers never race the network seam
  await waitFor(host, () => host.querySelectorAll("ul li button").length > 0);
};

const pressKey = (key: string, target: EventTarget = window, init: KeyboardEventInit = {}) => {
  act(() => {
    target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
  });
};

describe("item-picker-dialog keyboard behavior", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
    fixture = {
      exact: match(item("00000000-0000-4000-8000-00000000000a", "بطارية", "ABC1"), "BARCODE_EXACT"),
      matches: [
        match(item("00000000-0000-4000-8000-00000000000b", "فلتر زيت"), "NAME"),
        match(item("00000000-0000-4000-8000-00000000000c", "مصباح"), "CATEGORY"),
      ],
    };
  });

  afterEach(() => {
    const roots = mountedRoots;
    mountedRoots = [];
    try {
      for (const root of roots) act(() => root.unmount());
      // A leaked root would still receive this event after its host is removed.
      for (const picker of previousPickers) {
        const closeCalls = picker.closeCalls;
        pressKey("Escape");
        expect(picker.closeCalls).toBe(closeCalls);
      }
    } finally {
      previousPickers = [];
      document.body.innerHTML = "";
    }
  });

  it("Enter selects the first ranked match", async () => {
    const state: SelectionState = { selected: null };
    const { host } = renderPicker({ onClose: () => {}, onSelect: (it) => (state.selected = it) });
    await typeQuery(host, "بط");
    // Enter selection lives on the input's onKeyDown — target the field itself
    pressKey("Enter", host.querySelector("input")!);
    expect(state.selected?.id).toBe("00000000-0000-4000-8000-00000000000b"); // فلتر زيت ranks first
  });

  it("moves the visual active row with arrows and wraps in both directions", async () => {
    let selections = 0;
    const { host } = renderPicker({ onClose: () => {}, onSelect: () => selections++ });
    await typeQuery(host, "بط");

    const input = host.querySelector<HTMLInputElement>("input")!;
    const options = () => Array.from(host.querySelectorAll<HTMLElement>("[role='option']"));

    expect(input.getAttribute("aria-activedescendant")).toBeNull();

    // Down starts at the first ranked row and announces it to assistive tech.
    pressKey("ArrowDown", input);
    expect(input.getAttribute("aria-activedescendant")).toBe(options()[0]!.id);
    expect(options()[0]!.getAttribute("aria-selected")).toBe("true");
    expect(options()[0]!.querySelector("button")!.className).toContain("bg-stone-200");

    // Down advances, then wraps to the first row at the end.
    pressKey("ArrowDown", input);
    expect(input.getAttribute("aria-activedescendant")).toBe(options()[1]!.id);
    expect(options()[0]!.getAttribute("aria-selected")).toBe("false");
    pressKey("ArrowDown", input);
    expect(input.getAttribute("aria-activedescendant")).toBe(options()[0]!.id);

    // Up from the first row wraps to the final ranked row.
    pressKey("ArrowUp", input);
    expect(input.getAttribute("aria-activedescendant")).toBe(options()[1]!.id);
    expect(options()[1]!.getAttribute("aria-selected")).toBe("true");
    expect(selections).toBe(0);
  });

  it("keeps arrow navigation on the combobox without tabbable row divergence", async () => {
    const state: SelectionState = { selected: null };
    const { host } = renderPicker({ onClose: () => {}, onSelect: (it) => (state.selected = it) });
    await typeQuery(host, "بط");

    const input = host.querySelector<HTMLInputElement>("input")!;
    const rowButtons = Array.from(host.querySelectorAll<HTMLButtonElement>("[role='option'] button"));
    expect(rowButtons.map((button) => button.tabIndex)).toEqual([-1, -1]);

    input.focus();
    pressKey("ArrowDown", input);
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute("aria-activedescendant")).toBe(host.querySelector("[role='option']")!.id);

    // The native exact-match action remains available, but ranked row buttons
    // are not candidates for the modal's forward or reverse Tab movement.
    pressKey("Tab", input);
    expect(rowButtons.some((button) => button === document.activeElement)).toBe(false);
    input.focus();
    pressKey("Tab", input, { shiftKey: true });
    expect(rowButtons.some((button) => button === document.activeElement)).toBe(false);

    // Removing a row from the Tab sequence does not remove mouse selection.
    act(() => rowButtons[0]!.click());
    expect(state.selected?.id).toBe("00000000-0000-4000-8000-00000000000b");
  });

  it("clears the active row when the query changes", async () => {
    const { host } = renderPicker({ onClose: () => {}, onSelect: () => {} });
    await typeQuery(host, "بط");
    const input = host.querySelector<HTMLInputElement>("input")!;

    pressKey("ArrowDown", input);
    expect(input.getAttribute("aria-activedescendant")).not.toBeNull();

    await typeQuery(host, "مص");
    expect(input.getAttribute("aria-activedescendant")).toBeNull();
    expect(host.querySelectorAll("[aria-selected='true']")).toHaveLength(0);
  });

  it("Enter selects the active ranked row instead of resetting to the first", async () => {
    const state: SelectionState = { selected: null };
    const { host } = renderPicker({ onClose: () => {}, onSelect: (it) => (state.selected = it) });
    await typeQuery(host, "بط");
    const input = host.querySelector<HTMLInputElement>("input")!;

    pressKey("ArrowDown", input);
    pressKey("ArrowDown", input);
    pressKey("Enter", input);

    expect(state.selected?.id).toBe("00000000-0000-4000-8000-00000000000c"); // مصباح, the second ranked match
  });

  it("Escape closes through the shared modal-dialog seam", async () => {
    let closed = false;
    const { host } = renderPicker({ onClose: () => (closed = true), onSelect: () => {} });
    await typeQuery(host, "بط");
    pressKey("Escape");
    expect(closed).toBe(true);
  });

  it("traps Tab focus inside the dialog and wraps in both directions", async () => {
    const { host } = renderPicker({ onClose: () => {}, onSelect: () => {} });
    await typeQuery(host, "بط");

    const panel = host.querySelector<HTMLElement>("[role='dialog']")!;
    const focusables = Array.from(panel.querySelectorAll<HTMLElement>("input, button")).filter((element) => element.tabIndex >= 0);
    const input = host.querySelector("input")!;
    input.focus();
    expect(document.activeElement).toBe(input);

    // Tab from the last element wraps to the first
    const last = focusables[focusables.length - 1]!;
    last.focus();
    pressKey("Tab");
    expect(panel.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).toBe(focusables[0]!);

    // Shift+Tab from the first element wraps to the last
    input.focus();
    pressKey("Tab");
    // (forward from input moves to the next focusable)
    const afterForward = document.activeElement;
    expect(panel.contains(afterForward)).toBe(true);

    input.focus();
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(last);
  });

  it("backdrop mousedown closes without selecting", () => {
    let closed = false;
    let selected = 0;
    const { host } = renderPicker({ onClose: () => (closed = true), onSelect: () => selected++ });
    const backdrop = host.querySelector<HTMLElement>("[data-testid='picker-dialog']")!;
    act(() => {
      backdrop.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    expect(closed).toBe(true);
    expect(selected).toBe(0);
  });
});
