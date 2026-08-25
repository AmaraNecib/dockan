import { afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from "./select";

let mountedRoots: Array<{ unmount: () => void }> = [];

function render(ui: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  act(() => root.render(ui));
  return { host };
}

function renderSelect(onValueChange?: (value: string | null) => void) {
  return render(
    <Select
      defaultValue="in-stock"
      onValueChange={onValueChange}
      items={[
        { value: "in-stock", label: "In stock" },
        { value: "low", label: "Low" },
      ]}
    >
      <SelectTrigger data-testid="stock-trigger">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectLabel>Status</SelectLabel>
          <SelectItem value="in-stock" label="In stock">
            In stock
          </SelectItem>
          <SelectItem value="low" label="Low">
            Low
          </SelectItem>
        </SelectGroup>
        <SelectSeparator />
      </SelectContent>
    </Select>,
  );
}

/** act-wrapped polling so floating-ui positioning and store updates settle inside React */
const waitFor = async (predicate: () => boolean) => {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
  }
  throw new Error("condition not met within timeout");
};

afterEach(() => {
  const roots = mountedRoots;
  mountedRoots = [];
  for (const root of roots) act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("Select (Base UI primitive)", () => {
  it("renders trigger with the selected value and icon", () => {
    const { host } = renderSelect();
    const trigger = host.querySelector('[data-testid="stock-trigger"]')!;
    expect(trigger).not.toBeNull();
    expect(trigger.getAttribute("data-slot")).toBe("select-trigger");
    expect(host.querySelector('[data-slot="select-value"]')).not.toBeNull();
    // the chevron icon part renders inside the trigger
    expect(trigger.querySelector("svg")).not.toBeNull();
  });

  const openPopup = (trigger: HTMLElement) => {
    act(() => {
      trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      trigger.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
  };

  it("opens the popup on trigger interaction and lists items", async () => {
    const { host } = renderSelect();
    const trigger = host.querySelector<HTMLElement>('[data-testid="stock-trigger"]')!;
    openPopup(trigger);

    await waitFor(() => document.querySelectorAll("[role='option']").length >= 2);
    const options = document.querySelectorAll("[role='option']");
    expect(options.length).toBeGreaterThanOrEqual(2);
    expect(options[0]!.textContent).toContain("In stock");

    // group label and separator render inside the popup list
    expect(document.querySelector('[data-slot="select-label"]')!.textContent).toBe("Status");
    expect(document.querySelector('[data-slot="select-separator"]')).not.toBeNull();
  });

  it("selects an item and updates the trigger value", async () => {
    const changed: Array<string | null> = [];
    const { host } = renderSelect((value) => changed.push(value));
    const trigger = host.querySelector<HTMLElement>('[data-testid="stock-trigger"]')!;
    openPopup(trigger);

    await waitFor(() => document.querySelectorAll("[role='option']").length >= 2);
    const option = Array.from(document.querySelectorAll<HTMLElement>("[role='option']")).find(
      (element) => element.textContent?.includes("Low"),
    )!;
    act(() => {
      // Base UI items arm mouse selection on pointerdown, then commit on click.
      option.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }));
      option.dispatchEvent(
        new PointerEvent("click", { bubbles: true, cancelable: true, pointerType: "mouse", detail: 1 }),
      );
    });

    expect(changed).toContain("low");
    // SelectValue resolves the item label from the Root `items` prop
    await waitFor(() => host.querySelector('[data-slot="select-value"]')!.textContent === "Low");
    expect(host.querySelector('[data-slot="select-value"]')!.textContent).toBe("Low");
  });
});