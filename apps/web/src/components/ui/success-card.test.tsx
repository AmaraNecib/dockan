import { afterEach, describe, expect, it } from "bun:test";
import { act } from "react";
import { createRoot } from "react-dom/client";

// React 19 act() requires the environment flag to be set explicitly.
// SAFETY: only this flag is written; globalThis keeps every other property.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { SuccessCard, SuccessCardSpacer } from "./success-card";

let mounted: Array<{ root: ReturnType<typeof createRoot>; host: HTMLElement }> = [];

function render(ui: React.ReactElement): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(ui));
  mounted.push({ root, host });
  return host;
}

afterEach(() => {
  const entries = mounted;
  mounted = [];
  for (const entry of entries) act(() => entry.root.unmount());
  document.body.innerHTML = "";
});

describe("SuccessCard (shared completion card, issue #159)", () => {
  it("renders the check mark, result line and secondary detail", () => {
    const host = render(
      <SuccessCard testId="saved" title="تم الحفظ" detail="دين 7,000 دج">
        <button type="button">عرض</button>
      </SuccessCard>,
    );
    const card = host.querySelector('[data-testid="saved"]')!;
    expect(card.getAttribute("role")).toBe("status");
    expect(card.textContent).toContain("تم الحفظ");
    expect(card.textContent).toContain("دين 7,000 دج");
    expect(card.querySelector("svg")).not.toBeNull();
    expect(card.querySelector("button")?.textContent).toBe("عرض");
  });

  it("omits the detail line entirely when there is no secondary text", () => {
    const host = render(
      <SuccessCard title="تم الحفظ">
        <button type="button">عرض</button>
      </SuccessCard>,
    );
    // title + action row only: no empty secondary paragraph
    expect(host.querySelectorAll("p")).toHaveLength(1);
  });

  it("uses only success theme tokens, no raw colours", () => {
    const host = render(
      <SuccessCard testId="saved" title="تم الحفظ">
        <button type="button">عرض</button>
      </SuccessCard>,
    );
    const className = host.querySelector('[data-testid="saved"]')!.className;
    expect(className).toContain("border-success/40");
    expect(className).toContain("bg-success/10");
    expect(className).not.toMatch(/#[0-9a-f]{3,8}|rgb\(|oklch\(/i);
  });

  it("keeps the action row in order and pushes the trailing action with the spacer", () => {
    const host = render(
      <SuccessCard title="تم الحفظ">
        <button type="button" data-testid="primary">أول</button>
        <button type="button" data-testid="secondary">ثانٍ</button>
        <SuccessCardSpacer />
        <button type="button" data-testid="trailing">جديد</button>
      </SuccessCard>,
    );
    const row = host.querySelector("button")!.parentElement!;
    const ids = Array.from(row.children).map((child) => child.getAttribute("data-testid") ?? "spacer");
    expect(ids).toEqual(["primary", "secondary", "spacer", "trailing"]);
    expect(row.className).toContain("flex-wrap");
    expect(row.lastElementChild?.previousElementSibling?.className).toContain("flex-1");
  });
});
