import { afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { useKeyboardShortcuts, type KeyboardShortcuts } from "./use-keyboard-shortcuts";

// SAFETY: React's test environment flag changes no production state.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let cleanup: (() => void) | undefined;
afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  document.body.innerHTML = "";
});

function mount(actions: KeyboardShortcuts) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  function Harness() {
    useKeyboardShortcuts(actions);
    return <input aria-label="Draft" />;
  }
  act(() => root.render(<Harness />));
  cleanup = () => act(() => root.unmount());
  const field = host.querySelector("input");
  if (!field) throw new Error("Shortcut harness did not render its draft field");
  return field;
}

function press(target: EventTarget, key: string, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
  act(() => { target.dispatchEvent(event); });
  return event;
}

describe("workflow keyboard actions", () => {
  it("starts sale and purchase inside an editable field without swallowing plain letters", () => {
    const actions: string[] = [];
    const field = mount({ onSale: () => actions.push("sale"), onPurchase: () => actions.push("purchase") });
    expect(press(field, "n").defaultPrevented).toBe(false);
    expect(actions).toEqual([]);
    expect(press(field, "n", { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(press(field, "b", { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(actions).toEqual(["sale", "purchase"]);
  });

  it.each(["input", "textarea", "select", "contenteditable"])("keeps Ctrl-letter actions available in %s", (tag) => {
    let calls = 0;
    mount({ onSale: () => { calls++; } });
    const field = document.createElement(tag === "contenteditable" ? "div" : tag);
    if (tag === "contenteditable") field.setAttribute("contenteditable", "true");
    document.body.append(field);
    press(field, "n", { ctrlKey: true });
    expect(calls).toBe(1);
  });

  it.each(["dialog", "alertdialog", "native"])("blocks navigation behind an open %s without invoking browser defaults", (role) => {
    const actions: string[] = [];
    const field = mount({ onSale: () => actions.push("sale"), onPurchase: () => actions.push("purchase") });
    const dialog = document.createElement(role === "native" ? "dialog" : "div");
    if (role === "native") dialog.setAttribute("open", "");
    else dialog.setAttribute("role", role);
    document.body.append(dialog);
    expect(press(field, "n", { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(press(field, "b", { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(actions).toEqual([]);
    dialog.remove();
    press(field, "n", { ctrlKey: true });
    expect(actions).toEqual(["sale"]);
  });

  it("does not block on a dialog that has closed or is hidden", () => {
    let calls = 0;
    const field = mount({ onSale: () => { calls++; } });
    for (const attribute of ["hidden", "data-closed", "aria-hidden"]) {
      const dialog = document.createElement("div");
      dialog.setAttribute("role", "dialog");
      dialog.setAttribute(attribute, "true");
      document.body.append(dialog);
    }
    press(field, "n", { ctrlKey: true });
    expect(calls).toBe(1);
  });

  it("keeps sidebar, help and Escape distinct from navigation and text entry", () => {
    const actions: string[] = [];
    const field = mount({
      onPurchase: () => actions.push("purchase"),
      onToggleSidebar: () => actions.push("sidebar"),
      onHelp: () => actions.push("help"),
      onClose: () => actions.push("close"),
    });
    press(field, "B", { ctrlKey: true, shiftKey: true });
    press(field, "B", { metaKey: true, shiftKey: true });
    expect(press(field, "?").defaultPrevented).toBe(false);
    expect(press(field, "Escape").defaultPrevented).toBe(false);
    expect(press(window, "?").defaultPrevented).toBe(true);
    expect(press(window, "Escape").defaultPrevented).toBe(true);
    expect(actions).toEqual(["sidebar", "sidebar", "close", "help", "close"]);
  });

  it("ignores composition, repeat and extra modifiers, and matches physical Ctrl letters on Arabic layouts", () => {
    let calls = 0;
    const field = mount({ onSale: () => { calls++; } });
    press(field, "n", { ctrlKey: true, altKey: true });
    press(field, "n", { ctrlKey: true, shiftKey: true });
    press(field, "n", { ctrlKey: true, metaKey: true });
    press(field, "n", { metaKey: true });
    press(field, "n", { ctrlKey: true, isComposing: true });
    expect(press(field, "n", { ctrlKey: true, repeat: true }).defaultPrevented).toBe(true);
    expect(calls).toBe(0);
    press(field, "ى", { ctrlKey: true, code: "KeyN" });
    expect(calls).toBe(1);
  });

  // red-on-parent-waive: "leaves unavailable and already-handled actions alone" — missing navigation callbacks already leave these keys alone on the parent; this pins refusal and cleanup behavior that must stay unchanged.
  it("leaves unavailable and already-handled actions alone", () => {
    let calls = 0;
    const field = mount({ onSale: () => { calls++; } });
    expect(press(field, "b", { ctrlKey: true }).defaultPrevented).toBe(false);
    field.addEventListener("keydown", (event) => event.preventDefault());
    press(field, "n", { ctrlKey: true });
    expect(calls).toBe(0);
    cleanup?.();
    cleanup = undefined;
    press(window, "n", { ctrlKey: true });
    expect(calls).toBe(0);
  });
});
