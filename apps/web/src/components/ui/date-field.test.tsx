import { afterEach, describe, expect, it } from "bun:test";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import i18n from "@/lib/i18n";
import { DateField, type DateFieldProps } from "./date-field";

let mounted: Array<ReturnType<typeof createRoot>> = [];

afterEach(() => {
  const roots = mounted;
  mounted = [];
  for (const root of roots) act(() => root.unmount());
  document.body.innerHTML = "";
});

/** Controlled input through the native setter so React's onChange fires. */
function typeInto(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** React routes onBlur through the bubbling focusout event. */
function blur(input: HTMLInputElement) {
  act(() => {
    input.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
}

function mount(extra: Partial<DateFieldProps> = {}, initial = "") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push(root);

  function Harness() {
    const [value, setValue] = useState(initial);
    return <DateField value={value} onValueChange={setValue} testId="date" {...extra} />;
  }

  act(() => root.render(<Harness />));
  const query = (testid: string) => container.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
  return {
    query,
    // SAFETY: the testid addresses the field's own text input
    input: () => query("date") as HTMLInputElement,
    clickNow: () => act(() => query("date-now")!.dispatchEvent(new MouseEvent("click", { bubbles: true }))),
  };
}

/** The device-local instant a `DD/MM/YYYY HH:mm` field value names. */
function fieldInstant(value: string): number {
  const match = /^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/.exec(value);
  if (match === null) throw new Error(`field value is not day-first: ${value}`);
  return new Date(Number(match[3]), Number(match[2]) - 1, Number(match[1]), Number(match[4]), Number(match[5])).getTime();
}

/**
 * A field whose parent can unmount and remount it, the way `preset === "CUSTOM"`
 * does. The value lives in the parent, so it survives the round trip and the
 * remounted field must derive its state from it.
 */
function mountToggled(initial = "") {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push(root);

  function Harness() {
    const [value, setValue] = useState(initial);
    const [shown, setShown] = useState(true);
    return (
      <div>
        <button type="button" data-testid="toggle" onClick={() => setShown((current) => !current)} />
        {shown && <DateField value={value} onValueChange={setValue} testId="date" />}
      </div>
    );
  }

  act(() => root.render(<Harness />));
  const query = (testid: string) => container.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
  return {
    query,
    toggle: () => act(() => query("toggle")!.dispatchEvent(new MouseEvent("click", { bubbles: true }))),
    // SAFETY: the testid addresses the field's own text input
    input: () => query("date") as HTMLInputElement,
  };
}

describe("DateField (#123)", () => {
  it("wears the app's day-first text shape, never a datetime-local control", () => {
    const ui = mount({}, "01/10/2026 00:34");
    const input = ui.input();

    expect(input.type).toBe("text");
    expect(input.value).toBe("01/10/2026 00:34");
    // the example is i18n copy, not a literal in the component
    expect(input.getAttribute("placeholder")).toBe(i18n.t("expenseDateHint"));
  });

  it("reports every edit as the raw text it holds", () => {
    const ui = mount();
    typeInto(ui.input(), "15/01/2026 08:05");
    expect(ui.input().value).toBe("15/01/2026 08:05");
  });

  it("fills a live now-shaped value from «الآن»", () => {
    const ui = mount({}, "15/01/2026 08:05");
    ui.clickNow();

    const value = ui.input().value;
    expect(value).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
    expect(value).not.toBe("15/01/2026 08:05");
    // not just a shape: the stamp is the device's own moment
    expect(Math.abs(fieldInstant(value) - Date.now())).toBeLessThan(90_000);
  });

  it("refuses a half-typed value only after the field is left (uncontrolled)", () => {
    const ui = mount();
    typeInto(ui.input(), "31/02/2026 00:00");

    // still typing: no scolding mid-keystroke
    expect(ui.input().getAttribute("aria-invalid")).toBeNull();
    expect(ui.query("date-error")).toBeNull();

    blur(ui.input());
    expect(ui.input().getAttribute("aria-invalid")).toBe("true");
    expect(ui.input().getAttribute("aria-describedby")).toBe("date-error");
    const error = ui.query("date-error");
    expect(error?.getAttribute("role")).toBe("alert");
    expect(error?.textContent).toContain(i18n.t("expenseDateInvalid"));

    // a readable value clears the marker and the node
    typeInto(ui.input(), "28/02/2026 00:00");
    expect(ui.input().getAttribute("aria-invalid")).toBeNull();
    expect(ui.query("date-error")).toBeNull();
  });

  it("defers to the parent's alert when a form owns the refusal (controlled)", () => {
    const ui = mount({ invalid: true, errorId: "expense-error" }, "2026-01-15T08:05");

    const input = ui.input();
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect(input.getAttribute("aria-describedby")).toBe("expense-error");
    // the parent's alert carries the message; the field renders no second node
    expect(ui.query("date-error")).toBeNull();
  });

  it("runs the parent's onNow hook after «الآن» writes the value", () => {
    let nowCalls = 0;
    const ui = mount({ onNow: () => { nowCalls += 1; } });
    ui.clickNow();
    expect(nowCalls).toBe(1);
    expect(ui.input().value).toMatch(/^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}$/);
  });

  it("disables both the input and «الآن» when the field is disabled", () => {
    const ui = mount({ disabled: true });
    expect(ui.input().disabled).toBe(true);
    // SAFETY: the now control is the field's own button
    expect((ui.query("date-now") as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps a refusal across an unmount/remount (a preset switch)", () => {
    const ui = mountToggled();

    typeInto(ui.input(), "31/02/2026 00:00");
    blur(ui.input());
    expect(ui.query("date-error")).not.toBeNull();

    // the field unmounts (the preset left CUSTOM); the parent still holds the text
    ui.toggle();
    expect(ui.query("date")).toBeNull();

    // and remounts: the unreadable value derives its refusal again, not clean
    ui.toggle();
    const remounted = ui.input();
    expect(remounted.value).toBe("31/02/2026 00:00");
    expect(remounted.getAttribute("aria-invalid")).toBe("true");
    expect(remounted.getAttribute("aria-describedby")).toBe("date-error");
    expect(ui.query("date-error")?.textContent).toContain(i18n.t("expenseDateInvalid"));
  });

  it("remounts clean for a readable value", () => {
    const ui = mountToggled("28/02/2026 00:00");
    ui.toggle();
    ui.toggle();

    const remounted = ui.input();
    expect(remounted.value).toBe("28/02/2026 00:00");
    expect(remounted.getAttribute("aria-invalid")).toBeNull();
    expect(ui.query("date-error")).toBeNull();
  });
});
