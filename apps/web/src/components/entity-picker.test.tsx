import { afterEach, describe, expect, it } from "bun:test";
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";

import "../lib/i18n";
import { EntityPicker, type EntityOption } from "./entity-picker";

// SAFETY: React's test environment flag is the only global property this test writes.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const options: EntityOption[] = [
  { id: "first", name: "منتج أول" },
  { id: "late", name: "آلات التخزين" },
  { id: "article", name: "السعيد" },
];

const mounted: Array<{ root: Root; host: HTMLElement }> = [];

function Harness({ onCreate }: { onCreate?: (query: string) => void }) {
  const [value, setValue] = useState("first");
  return (
    <>
      <EntityPicker
        label="المنتج"
        options={options}
        value={value}
        onChange={setValue}
        testId="entity"
        onCreate={onCreate}
        createLabel={(name) => `إنشاء ${name}`}
      />
      <output data-testid="selected">{value}</output>
    </>
  );
}

async function mount(onCreate?: (query: string) => void): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<Harness onCreate={onCreate} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  mounted.push({ root, host });
  return host;
}

async function type(host: HTMLElement, value: string): Promise<void> {
  const input = host.querySelector<HTMLInputElement>('[data-testid="entity"]');
  if (!input) throw new Error("missing entity picker input");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function press(host: HTMLElement, key: string): Promise<void> {
  const input = host.querySelector<HTMLInputElement>('[data-testid="entity"]');
  if (!input) throw new Error("missing entity picker input");
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

afterEach(async () => {
  for (const { root, host } of mounted.splice(0)) {
    await act(async () => root.unmount());
    host.remove();
  }
});

describe("EntityPicker", () => {
  it("normalizes Arabic search, including alef variants and the definite article", async () => {
    const host = await mount();
    await type(host, "سعيد");

    const optionsFound = [...host.querySelectorAll('[role="option"]')].map((option) => option.textContent);
    expect(optionsFound).toContain("السعيد");
  });

  it("selects a typed match with arrow and Enter without changing it by typing alone", async () => {
    const host = await mount();
    await type(host, "آلات");

    expect(host.querySelector('[data-testid="selected"]')?.textContent).toBe("first");
    await press(host, "ArrowDown");
    await press(host, "Enter");

    expect(host.querySelector('[data-testid="selected"]')?.textContent).toBe("late");
  });

  it("offers an explicit create action only when there is no match", async () => {
    const create = (query: string) => { expect(query).toBe("تصنيف جديد"); };
    const host = await mount(create);
    await type(host, "تصنيف جديد");

    const action = host.querySelector<HTMLButtonElement>('[data-testid="entity-create"]');
    expect(action?.textContent).toBe("إنشاء تصنيف جديد");
    await act(async () => action?.click());
    expect(host.querySelector('[data-testid="selected"]')?.textContent).toBe("first");
  });
});
