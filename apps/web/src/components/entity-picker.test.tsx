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

function Harness({
  onCreate,
  pickerOptions = options,
  autoSelectFirst = false,
}: {
  onCreate?: (query: string) => void;
  pickerOptions?: EntityOption[];
  autoSelectFirst?: boolean;
}) {
  const [value, setValue] = useState(autoSelectFirst ? "" : "first");
  const [submits, setSubmits] = useState(0);
  const selectedValue = autoSelectFirst ? value || pickerOptions[0]?.id || "" : value;
  return (
    <form onSubmit={(event) => { event.preventDefault(); setSubmits((count) => count + 1); }}>
      <EntityPicker
        label="المنتج"
        options={pickerOptions}
        value={selectedValue}
        onChange={setValue}
        testId="entity"
        onCreate={onCreate}
        createLabel={(name) => `إنشاء ${name}`}
      />
      <output data-testid="selected">{selectedValue}</output>
      <output data-testid="submits">{submits}</output>
    </form>
  );
}

async function mount(
  onCreate?: (query: string) => void,
  pickerOptions: EntityOption[] = options,
  autoSelectFirst = false,
): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<Harness onCreate={onCreate} pickerOptions={pickerOptions} autoSelectFirst={autoSelectFirst} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  mounted.push({ root, host });
  return host;
}

async function updateOptions(host: HTMLElement, pickerOptions: EntityOption[], autoSelectFirst: boolean): Promise<void> {
  const entry = mounted.find((candidate) => candidate.host === host);
  if (entry === undefined) throw new Error("missing mounted picker");
  await act(async () => {
    entry.root.render(<Harness pickerOptions={pickerOptions} autoSelectFirst={autoSelectFirst} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function type(host: HTMLElement, value: string): Promise<void> {
  const input = host.querySelector<HTMLInputElement>('[data-testid="entity"]');
  if (!input) throw new Error("missing entity picker input");
  await act(async () => {
    input.focus();
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
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    input.dispatchEvent(event);
    // The browser's implicit form submission is the default Enter action. JSDOM
    // does not synthesize it, so model that default only when the picker did not cancel it.
    if (key === "Enter" && !event.defaultPrevented) input.form?.requestSubmit();
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

    const optionsFound = [...document.querySelectorAll('[role="option"]')].map((option) => option.textContent);
    expect(optionsFound).toContain("السعيد");
  });

  it("keeps a typed search when options load and the default selection changes", async () => {
    const host = await mount(undefined, [], true);
    await type(host, "تصنيف متأخر");
    await updateOptions(host, [{ id: "default", name: "تصنيف حالي" }, { id: "late", name: "تصنيف متأخر" }], true);

    expect(host.querySelector<HTMLInputElement>('[data-testid="entity"]')?.value).toBe("تصنيف متأخر");
    expect(document.querySelector('[role="option"]')?.textContent).toBe("تصنيف متأخر");
    expect(host.querySelector('[data-testid="selected"]')?.textContent).toBe("default");
  });

  it("prevents Enter from submitting the caller form when no option is active", async () => {
    const host = await mount();
    await type(host, "missing category");
    await press(host, "Enter");

    expect(host.querySelector('[data-testid="selected"]')?.textContent).toBe("first");
    expect(host.querySelector('[data-testid="submits"]')?.textContent).toBe("0");
  });

  it("does not select a different record when options reorder before Enter", async () => {
    const host = await mount();
    await type(host, "منتج");
    await press(host, "ArrowDown");
    await updateOptions(host, [
      { id: "second", name: "منتج ثاني" },
      { id: "first", name: "منتج أول" },
    ], false);
    await press(host, "Enter");

    expect(host.querySelector('[data-testid="selected"]')?.textContent).toBe("first");
  });

  it("selects a typed match with arrow and Enter without changing it by typing alone", async () => {
    const host = await mount();
    await type(host, "آلات");

    expect(host.querySelector('[data-testid="selected"]')?.textContent).toBe("first");
    await press(host, "ArrowDown");
    await press(host, "Enter");

    expect(host.querySelector('[data-testid="selected"]')?.textContent).toBe("late");
  });

  it("renders the option list outside its field container", async () => {
    const host = await mount();
    await type(host, "منتج");
    const menu = document.querySelector(`[data-testid="entity-menu"]`);
    expect(menu).not.toBeNull();
    expect(host.contains(menu)).toBe(false);
  });

  it("reopens after picking when the still-focused field is clicked", async () => {
    const host = await mount();
    await type(host, "آلات");
    await press(host, "ArrowDown");
    await press(host, "Enter");
    const input = host.querySelector<HTMLInputElement>('[data-testid="entity"]');
    if (input === null) throw new Error("missing entity picker input");
    expect(input.getAttribute("aria-expanded")).toBe("false");

    await act(async () => {
      input.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[role="option"]')?.textContent).toBe("آلات التخزين");
  });

  it("reopens a dismissed search when ArrowDown is pressed again", async () => {
    const host = await mount();
    await type(host, "آلات");
    await press(host, "Escape");
    const input = host.querySelector<HTMLInputElement>('[data-testid="entity"]');
    if (input === null) throw new Error("missing entity picker input");
    expect(input.getAttribute("aria-expanded")).toBe("false");

    await press(host, "ArrowDown");

    expect(input.getAttribute("aria-expanded")).toBe("true");
    expect(document.querySelector('[role="option"]')?.textContent).toBe("منتج أول");
  });

  it("offers an explicit create action only when there is no match", async () => {
    const create = (query: string) => { expect(query).toBe("تصنيف جديد"); };
    const host = await mount(create);
    await type(host, "تصنيف جديد");

    const action = document.querySelector<HTMLButtonElement>('[data-testid="entity-create"]');
    expect(action?.textContent).toBe("إنشاء تصنيف جديد");
    await act(async () => action?.click());
    expect(host.querySelector('[data-testid="selected"]')?.textContent).toBe("first");
  });
});
