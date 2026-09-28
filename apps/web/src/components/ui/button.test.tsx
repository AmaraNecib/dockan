import { afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { Button } from "./button";

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

describe("Button (Base UI primitive)", () => {
  it("renders a native button with data slots and variant classes", () => {
    const { host } = render(<Button>Save</Button>);
    const button = host.querySelector("button")!;
    expect(button).not.toBeNull();
    expect(button.getAttribute("data-slot")).toBe("button");
    expect(button.getAttribute("data-variant")).toBe("default");
    expect(button.getAttribute("data-size")).toBe("default");
    expect(button.className).toContain("bg-primary");
    expect(button.textContent).toBe("Save");
  });

  it("applies variant and size props", () => {
    const { host } = render(
      <Button variant="outline" size="sm">
        Edit
      </Button>,
    );
    const button = host.querySelector("button")!;
    expect(button.getAttribute("data-variant")).toBe("outline");
    expect(button.getAttribute("data-size")).toBe("sm");
    expect(button.className).toContain("h-7");
  });

  it("forwards native button props like onClick and data attributes", () => {
    let clicks = 0;
    const { host } = render(
      <Button onClick={() => clicks++} data-testid="save-button">
        Save
      </Button>,
    );
    const button = host.querySelector("button")!;
    expect(button.getAttribute("data-testid")).toBe("save-button");
    act(() => button.click());
    expect(clicks).toBe(1);
  });

  it("honors the disabled attribute", () => {
    let clicks = 0;
    const { host } = render(
      <Button onClick={() => clicks++} disabled>
        Save
      </Button>,
    );
    const button = host.querySelector("button")!;
    expect(button.disabled).toBe(true);
    act(() => button.click());
    expect(clicks).toBe(0);
  });

  it("keeps the radix-era asChild compat: renders the child element with button classes", () => {
    const { host } = render(
      <Button asChild>
        <a href="/settings">Settings</a>
      </Button>,
    );
    const link = host.querySelector("a")!;
    expect(link).not.toBeNull();
    expect(host.querySelector("button")).toBeNull();
    expect(link.getAttribute("href")).toBe("/settings");
    expect(link.getAttribute("data-slot")).toBe("button");
    expect(link.className).toContain("bg-primary");
    expect(link.textContent).toBe("Settings");
  });

  it("asChild with a non-button child keeps valid anchor semantics (no type, no dev warning)", () => {
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const { host } = render(
        <Button asChild>
          <a href="/settings">Settings</a>
        </Button>,
      );
      const link = host.querySelector<HTMLAnchorElement>("a")!;
      // Base UI's nativeButton=false path: role instead of button-only type attr
      expect(link.hasAttribute("type")).toBe(false);
      expect(link.getAttribute("role")).toBe("button");
      expect(link.getAttribute("href")).toBe("/settings");
    } finally {
      console.error = originalError;
    }
    // Base UI raises a dev error when nativeButton defaults to true but the
    // rendered child is not a <button>; the shim must never hit that path.
    expect(errors).toHaveLength(0);
  });

  it("asChild with a real button child keeps native button semantics", () => {
    const errors: unknown[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args);
    try {
      const { host } = render(
        <Button asChild>
          <button className="underline">Go</button>
        </Button>,
      );
      const button = host.querySelector("button")!;
      expect(button.getAttribute("type")).toBe("button");
      expect(button.getAttribute("role")).toBeNull();
      expect(button.className).toContain("underline");
      expect(button.className).toContain("bg-primary");
    } finally {
      console.error = originalError;
    }
    expect(errors).toHaveLength(0);
  });
});