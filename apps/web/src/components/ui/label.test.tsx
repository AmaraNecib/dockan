import { afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { Label } from "./label";

let mountedRoots: Array<{ unmount: () => void }> = [];

function render(ui: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  act(() => root.render(ui));
  return { host };
}

afterEach(() => {
  const roots = mountedRoots;
  mountedRoots = [];
  for (const root of roots) act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("Label (native element after radix removal)", () => {
  it("renders a native label with the data slot and base classes", () => {
    const { host } = render(<Label>Item name</Label>);
    const label = host.querySelector("label")!;
    expect(label).not.toBeNull();
    expect(label.getAttribute("data-slot")).toBe("label");
    expect(label.className).toContain("font-medium");
    expect(label.textContent).toBe("Item name");
  });

  it("forwards htmlFor to associate with a control", () => {
    const { host } = render(<Label htmlFor="sku">SKU</Label>);
    const label = host.querySelector("label")!;
    expect(label.getAttribute("for")).toBe("sku");
  });
});