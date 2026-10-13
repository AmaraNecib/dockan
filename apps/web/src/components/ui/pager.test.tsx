import { afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "../../lib/i18n"; // side-effect: initializes i18next (ar) for useTranslation

import { Pager } from "./pager";

let mounted: Array<{ unmount: () => void }> = [];

afterEach(() => {
  const roots = mounted;
  mounted = [];
  for (const root of roots) act(() => root.unmount());
  document.body.innerHTML = "";
});

interface PagerHandle {
  host: HTMLElement;
  offsets: number[];
  sizes: number[];
}

async function mountPager(props: { total: number; pageSize: number; offset: number }): Promise<PagerHandle> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted.push(root);
  const offsets: number[] = [];
  const sizes: number[] = [];
  // stable callbacks: the pager's clamp effect depends on the identity, and a
  // fresh function per render would make that effect re-run for no reason
  const onOffsetChange = (offset: number) => offsets.push(offset);
  const onPageSizeChange = (size: number) => sizes.push(size);
  await act(async () => {
    root.render(<Pager {...props} onOffsetChange={onOffsetChange} onPageSizeChange={onPageSizeChange} testId="pager" />);
  });
  return { host, offsets, sizes };
}

const q = (host: HTMLElement, id: string) => host.querySelector<HTMLElement>(`[data-testid='${id}']`);

/** React tracks the value on the instance, so a plain assignment is ignored;
 * go through the native setter like the other input tests do. */
function setInput(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (setter === undefined) throw new Error("HTMLInputElement value setter is unavailable");
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function submitCustomSize(host: HTMLElement): void {
  q(host, "pager-custom-apply")!.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
}

describe("Pager (issue 163)", () => {
  it("is hidden when the whole list fits one page", async () => {
    const { host } = await mountPager({ total: 10, pageSize: 10, offset: 0 });
    expect(q(host, "pager")).toBeNull();
  });

  it("shows the range copy and page buttons once the list spans pages", async () => {
    const { host } = await mountPager({ total: 25, pageSize: 10, offset: 0 });
    expect(q(host, "pager")).not.toBeNull();
    const range = q(host, "pager-range")?.textContent ?? "";
    expect(range).toContain("1");
    expect(range).toContain("10");
    expect(range).toContain("25");
    expect(q(host, "pager-page-1")?.getAttribute("aria-current")).toBe("page");
    expect(q(host, "pager-page-3")).not.toBeNull();
    // first page: prev disabled, next enabled
    expect(q(host, "pager-prev")?.hasAttribute("disabled")).toBe(true);
    expect(q(host, "pager-next")?.hasAttribute("disabled")).toBe(false);
  });

  it("moves to a numbered page and to the next page", async () => {
    const { host, offsets } = await mountPager({ total: 25, pageSize: 10, offset: 0 });
    await act(async () => q(host, "pager-page-2")!.click());
    expect(offsets).toEqual([10]);
    await act(async () => q(host, "pager-next")!.click());
    expect(offsets).toEqual([10, 10]);
  });

  it("disables next on the last page", async () => {
    const { host } = await mountPager({ total: 25, pageSize: 10, offset: 20 });
    expect(q(host, "pager-next")?.hasAttribute("disabled")).toBe(true);
    const range = q(host, "pager-range")?.textContent ?? "";
    expect(range).toContain("21");
    expect(range).toContain("25");
  });

  it("applies a preset page size", async () => {
    const { host, sizes } = await mountPager({ total: 100, pageSize: 10, offset: 0 });
    await act(async () => q(host, "pager-size-50")!.click());
    expect(sizes).toEqual([50]);
    // every preset is offered
    for (const preset of [20, 25, 50, 100]) expect(q(host, `pager-size-${preset}`)).not.toBeNull();
    // the active preset carries the pressed state (10 is the default, not a preset)
    const active = await mountPager({ total: 100, pageSize: 50, offset: 0 });
    expect(q(active.host, "pager-size-50")?.getAttribute("aria-pressed")).toBe("true");
  });

  it("accepts a manual page size through «مخصّص…»", async () => {
    const { host, sizes } = await mountPager({ total: 100, pageSize: 10, offset: 0 });
    await act(async () => q(host, "pager-custom-toggle")!.click());
    const input = host.querySelector<HTMLInputElement>("[data-testid='pager-custom-input']")!;
    await act(async () => setInput(input, "30"));
    await act(async () => submitCustomSize(host));
    expect(sizes).toEqual([30]);
  });

  it("refuses a zero or malformed manual page size", async () => {
    const { host, sizes } = await mountPager({ total: 100, pageSize: 10, offset: 0 });
    await act(async () => q(host, "pager-custom-toggle")!.click());
    const input = host.querySelector<HTMLInputElement>("[data-testid='pager-custom-input']")!;
    await act(async () => setInput(input, "0"));
    await act(async () => submitCustomSize(host));
    expect(sizes).toEqual([]);
    expect(q(host, "pager-custom-invalid")).not.toBeNull();

    // above the server ceiling (MAX_PAGE_SIZE = 500) is refused too
    await act(async () => setInput(input, "501"));
    await act(async () => submitCustomSize(host));
    expect(sizes).toEqual([]);
    expect(q(host, "pager-custom-invalid")).not.toBeNull();
  });

  it("snaps an out-of-range offset back to the last real page", async () => {
    const { offsets } = await mountPager({ total: 25, pageSize: 10, offset: 999 });
    expect(offsets).toEqual([20]);
  });
});
