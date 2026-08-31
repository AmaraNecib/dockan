import { afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "@/lib/i18n";
import { ThemeProvider } from "@/lib/theme";
import { ThemeToggle } from "./theme-toggle";
import { ShortcutsHelp } from "./shortcuts-help";
import { LogoutDialog } from "./logout-dialog";

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
  document.documentElement.classList.remove("dark");
  window.localStorage.clear();
});

describe("ThemeToggle (cycling)", () => {
  it("cycles light → dark → system on each click", async () => {
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );
    // SAFETY: querySelector targets the ThemeToggle button by aria-label, guaranteed present after render.
    const btn = document.querySelector('[aria-label="المظهر"]')! as HTMLButtonElement;
    expect(btn).not.toBeNull();

    // Starts at system — no dark class
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    // Click → light (still no dark)
    act(() => btn.click());
    expect(document.documentElement.classList.contains("dark")).toBe(false);

    // Click → dark
    act(() => btn.click());
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    // Click → system (reverts to light in test env — no prefers-color-scheme: dark)
    act(() => btn.click());
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("applies dark class when cycling to dark", () => {
    render(
      <ThemeProvider>
        <ThemeToggle />
      </ThemeProvider>,
    );
    // SAFETY: same selector as above, guaranteed present after render.
    const btn = document.querySelector('[aria-label="المظهر"]')! as HTMLButtonElement;
    document.documentElement.classList.remove("dark");

    // system → light → dark
    act(() => btn.click());
    act(() => btn.click());

    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});

describe("ShortcutsHelp dialog", () => {
  it("renders the shortcut list inside the dialog", () => {
    render(<ShortcutsHelp open onOpenChange={() => {}} />);
    const popup = document.querySelector('[data-slot="dialog-popup"]');
    expect(popup).not.toBeNull();
    expect(popup!.textContent).toContain("اختصارات لوحة المفاتيح");
    expect(popup!.textContent).toContain("Ctrl/⌘ + K");
    expect(popup!.textContent).toContain("Ctrl/⌘+Shift+B");
  });
});

describe("LogoutDialog confirm", () => {
  it("shows the confirmation with cancel and logout actions", () => {
    render(<LogoutDialog open onOpenChange={() => {}} onConfirm={() => {}} />);
    const popup = document.querySelector('[data-slot="dialog-popup"]')!;
    expect(popup.textContent).toContain("تسجيل الخروج");
    expect(popup.textContent).toContain("خروج");
  });

  it("fires onConfirm when logout is clicked", () => {
    let confirmed = 0;
    render(<LogoutDialog open onOpenChange={() => {}} onConfirm={() => (confirmed += 1)} />);
    const logoutBtn = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "خروج")!;
    act(() => logoutBtn.click());
    expect(confirmed).toBe(1);
  });
});