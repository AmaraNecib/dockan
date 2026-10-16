import { afterEach, describe, expect, it } from "bun:test";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";

// React 19 act() requires the environment flag to be set explicitly
// SAFETY: only this flag is written; globalThis keeps every other property
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "@/lib/i18n";
import {
  AmountPercentageInput,
  amountEdited,
  amountFromPercentage,
  hasReference,
  parseWholeAmount,
  parseWholePercentage,
  percentageDraftInvalid,
  percentageEdited,
  percentageFromAmount,
  type AmountPercentageValue,
} from "./amount-percentage-input";

let mountedRoots: Array<ReturnType<typeof createRoot>> = [];

afterEach(() => {
  const roots = mountedRoots;
  mountedRoots = [];
  for (const root of roots) act(() => root.unmount());
  document.body.innerHTML = "";
});

function typeInto(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  act(() => {
    setter?.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

describe("amount/percentage linked math (#162)", () => {
  it("converts a percentage of a reference to whole DZD", () => {
    expect(amountFromPercentage(30_000, 50)).toBe(15_000);
    expect(amountFromPercentage(30_000, 100)).toBe(30_000);
    expect(amountFromPercentage(30_000, 0)).toBe(0);
    // rounded to whole DZD
    expect(amountFromPercentage(100, 33)).toBe(33);
    expect(amountFromPercentage(101, 50)).toBe(51);
  });

  it("clamps a percentage outside 0..100 before converting", () => {
    expect(amountFromPercentage(1_000, 150)).toBe(1_000);
    expect(amountFromPercentage(1_000, -20)).toBe(0);
  });

  it("converts an amount back to a whole percentage of the reference", () => {
    expect(percentageFromAmount(30_000, 15_000)).toBe(50);
    expect(percentageFromAmount(30_000, 30_000)).toBe(100);
    expect(percentageFromAmount(30_000, 0)).toBe(0);
    // rounded to a whole percent
    expect(percentageFromAmount(30_000, 25_000)).toBe(83);
    expect(percentageFromAmount(30_000, 25_500)).toBe(85);
  });

  it("treats a zero/absent reference as no reference (never a divide-by-zero)", () => {
    expect(percentageFromAmount(0, 500)).toBe(0);
    expect(hasReference(0)).toBe(false);
    expect(hasReference(null)).toBe(false);
    expect(hasReference(undefined)).toBe(false);
    expect(hasReference(Number.NaN)).toBe(false);
    expect(hasReference(1)).toBe(true);
  });

  it("parses digits-only whole drafts and rejects numeric-string spellings", () => {
    expect(parseWholeAmount("1500")).toBe(1500);
    expect(parseWholeAmount(" 42 ")).toBe(42);
    expect(parseWholeAmount("0")).toBe(0);
    expect(parseWholeAmount("")).toBeNull();
    expect(parseWholeAmount("12.5")).toBeNull();
    expect(parseWholeAmount("1e3")).toBeNull();
    expect(parseWholeAmount("-5")).toBeNull();
    expect(parseWholeAmount("abc")).toBeNull();

    expect(parseWholePercentage("100")).toBe(100);
    expect(parseWholePercentage("0")).toBe(0);
    expect(parseWholePercentage("101")).toBeNull();
    expect(parseWholePercentage("-1")).toBeNull();
    expect(parseWholePercentage("")).toBeNull();
  });

  it("recomputes the percentage when the amount is edited", () => {
    expect(amountEdited(30_000, "15000")).toEqual({ amount: "15000", percentage: "50" });
    expect(amountEdited(30_000, "25000")).toEqual({ amount: "25000", percentage: "83" });
    expect(amountEdited(30_000, "30000")).toEqual({ amount: "30000", percentage: "100" });
    // an unusable draft clears the derived side
    expect(amountEdited(30_000, "abc")).toEqual({ amount: "abc", percentage: "" });
    expect(amountEdited(30_000, "")).toEqual({ amount: "", percentage: "" });
    // no reference: the amount draft stands alone
    expect(amountEdited(null, "500")).toEqual({ amount: "500", percentage: "" });
  });

  it("recomputes the amount when the percentage is edited", () => {
    expect(percentageEdited(30_000, "50")).toEqual({ amount: "15000", percentage: "50" });
    expect(percentageEdited(30_000, "100")).toEqual({ amount: "30000", percentage: "100" });
    expect(percentageEdited(30_000, "0")).toEqual({ amount: "0", percentage: "0" });
    expect(percentageEdited(30_000, "abc")).toEqual({ amount: "", percentage: "abc" });
    expect(percentageEdited(null, "50")).toEqual({ amount: "", percentage: "" });
  });

  it("caps a percentage above 100 at 100 with the full amount", () => {
    expect(percentageEdited(30_000, "150")).toEqual({ amount: "30000", percentage: "100" });
    expect(percentageEdited(9_999, "1000")).toEqual({ amount: "9999", percentage: "100" });
  });

  it("treats a mark-only percentage as blank, never as an over-100 draft (#244)", () => {
    // outcome-neutral at this site: `parseLooseNumber("\u200f")` is 0, not > 100,
    // so the raw-trim form returned the identical value. The #244 ratchet, not a
    // black-box assertion, is what discriminates this conversion (see #238's
    // `nextUnitCost` ablation for the same honesty).
    expect(percentageEdited(30_000, "\u200f")).toEqual({ amount: "", percentage: "\u200f" });
    expect(percentageEdited(30_000, " \u200f ")).toEqual({ amount: "", percentage: " \u200f " });
  });

  it("links Arabic-Indic percentage digits like their ASCII value, including the over-100 clamp (#210)", () => {
    expect(percentageEdited(30_000, "٥٠")).toEqual({ amount: "15000", percentage: "٥٠" });
    expect(percentageEdited(30_000, "۱۰۰")).toEqual({ amount: "30000", percentage: "۱۰۰" });
    // the clamp fallback must normalise too: raw Number("١٥٠") is NaN, which
    // would otherwise leave the draft unclamped and the amount empty
    expect(percentageEdited(30_000, "١٥٠")).toEqual({ amount: "30000", percentage: "100" });
    expect(percentageEdited(30_000, "150")).toEqual(percentageEdited(30_000, "١٥٠"));
  });

  it("flags a non-empty invalid percentage draft so callers cannot treat it as blank", () => {
    expect(percentageDraftInvalid("12.5")).toBe(true);
    expect(percentageDraftInvalid("abc")).toBe(true);
    expect(percentageDraftInvalid("-1")).toBe(true);
    expect(percentageDraftInvalid("150")).toBe(true);
    expect(percentageDraftInvalid("50")).toBe(false);
    expect(percentageDraftInvalid("100")).toBe(false);
    // blank is the legitimate "unpaid / zero cash" choice, not an error
    expect(percentageDraftInvalid("")).toBe(false);
    expect(percentageDraftInvalid("   ")).toBe(false);
  });
});

function Harness({ referenceTotal, initial, percentageInvalid }: { referenceTotal?: number | null; initial: AmountPercentageValue; percentageInvalid?: boolean }) {
  const [value, setValue] = useState(initial);
  return (
    <AmountPercentageInput
      referenceTotal={referenceTotal}
      value={value}
      onChange={(next) => setValue(next)}
      amountLabel="المبلغ (دج)"
      amountTestId="amount"
      percentageTestId="percentage"
      referenceTestId="reference"
      percentageInvalid={percentageInvalid}
    />
  );
}

function renderHarness(ui: React.ReactElement) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mountedRoots.push(root);
  act(() => root.render(ui));
  return host;
}

describe("AmountPercentageInput rendered (#162)", () => {
  it("shows both fields with the full reference and 100% by default", () => {
    const host = renderHarness(<Harness referenceTotal={30_000} initial={{ amount: "30000", percentage: "100" }} />);
    expect(host.querySelector<HTMLInputElement>('[data-testid="amount"]')?.value).toBe("30000");
    expect(host.querySelector<HTMLInputElement>('[data-testid="percentage"]')?.value).toBe("100");
    // the reference total is visible so «50%» is unambiguous
    expect(host.querySelector('[data-testid="reference"]')?.textContent).toContain("30");
  });

  it("editing the amount updates the percentage", () => {
    const host = renderHarness(<Harness referenceTotal={30_000} initial={{ amount: "30000", percentage: "100" }} />);
    typeInto(host.querySelector<HTMLInputElement>('[data-testid="amount"]')!, "15000");
    expect(host.querySelector<HTMLInputElement>('[data-testid="percentage"]')?.value).toBe("50");
  });

  it("editing the percentage updates the amount", () => {
    const host = renderHarness(<Harness referenceTotal={30_000} initial={{ amount: "30000", percentage: "100" }} />);
    typeInto(host.querySelector<HTMLInputElement>('[data-testid="percentage"]')!, "50");
    expect(host.querySelector<HTMLInputElement>('[data-testid="amount"]')?.value).toBe("15000");
  });

  it("caps a typed percentage above 100 at 100", () => {
    const host = renderHarness(<Harness referenceTotal={30_000} initial={{ amount: "30000", percentage: "100" }} />);
    typeInto(host.querySelector<HTMLInputElement>('[data-testid="percentage"]')!, "150");
    expect(host.querySelector<HTMLInputElement>('[data-testid="percentage"]')?.value).toBe("100");
    expect(host.querySelector<HTMLInputElement>('[data-testid="amount"]')?.value).toBe("30000");
  });

  it("renders a single amount field when there is no reference", () => {
    const host = renderHarness(<Harness referenceTotal={null} initial={{ amount: "500", percentage: "" }} />);
    expect(host.querySelector<HTMLInputElement>('[data-testid="amount"]')).not.toBeNull();
    expect(host.querySelector<HTMLInputElement>('[data-testid="percentage"]')).toBeNull();
    expect(host.querySelector('[data-testid="reference"]')).toBeNull();
  });

  it("marks the percentage field invalid when the caller reports it (#171)", () => {
    const host = renderHarness(<Harness referenceTotal={30_000} initial={{ amount: "", percentage: "12.5" }} percentageInvalid />);
    expect(host.querySelector<HTMLInputElement>('[data-testid="percentage"]')?.getAttribute("aria-invalid")).toBe("true");
    // the amount field keeps its own flag
    expect(host.querySelector<HTMLInputElement>('[data-testid="amount"]')?.getAttribute("aria-invalid")).toBeNull();
  });
});
