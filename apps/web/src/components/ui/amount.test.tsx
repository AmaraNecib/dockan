import { afterEach, describe, expect, it } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { act } from "react";
import { createRoot } from "react-dom/client";

// React 19 act() requires the environment flag to be set explicitly.
// SAFETY: only this flag is written; globalThis keeps every other property.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import "../../lib/i18n"; // side-effect: initializes i18next (ar) for useTranslation

import { PrintAmount } from "../print-sheet";
import { Amount } from "./amount";

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

/** The two display runs of one rendered amount, in DOM order. */
function runs(host: HTMLElement) {
  const figures = host.querySelector<HTMLElement>('[data-testid="money-figures"]')!;
  const currency = host.querySelector<HTMLElement>('[data-testid="money-currency"]')!;
  return { figures, currency };
}

describe("Money / Amount — one money display (issue #254)", () => {
  it("groups thousands with Western digits, like the printed sheet", () => {
    const host = render(<Amount value={92500} />);
    expect(runs(host).figures.textContent).toBe("92,500");
    const host2 = render(<Amount value={1234567} />);
    expect(runs(host2).figures.textContent).toBe("1,234,567");
    const host3 = render(<Amount value={900} />);
    expect(runs(host3).figures.textContent).toBe("900");
  });

  it("keeps a negative amount's sign inside the isolated figures run", () => {
    const host = render(<Amount value={-92500} />);
    expect(runs(host).figures.textContent).toBe("-92,500");
    // the sign must not be a sibling neutral: that is what bidi displaces to
    // the far end of an RTL row (#254's screenshot)
    expect(host.textContent).toBe("-92,500 دج");
  });

  it("renders a ledger sign inside the isolate, glued to its digits", () => {
    const host = render(<Amount value={7500} sign="−" />);
    expect(runs(host).figures.textContent).toBe("− 7,500");
    const plus = render(<Amount value={15000} sign="+" />);
    expect(runs(plus).figures.textContent).toBe("+ 15,000");
  });

  it("reads the magnitude when a ledger sign is given, so a sign cannot double", () => {
    const host = render(<Amount value={-100} sign="−" />);
    expect(runs(host).figures.textContent).toBe("− 100");
    // without a sign the value's own sign is the display
    const plain = render(<Amount value={-100} />);
    expect(runs(plain).figures.textContent).toBe("-100");
  });

  it("isolates only the figures, and separates the currency with a real space", () => {
    const host = render(<Amount value={1000} />);
    const { figures, currency } = runs(host);
    expect(figures.getAttribute("dir")).toBe("ltr");
    // the currency is Arabic text in the page's own direction, never forced LTR
    expect(currency.getAttribute("dir")).toBeNull();
    // DOM order: figures, a real separating space, then the currency
    expect(figures.nextSibling?.nodeType).toBe(Node.TEXT_NODE);
    expect(figures.nextSibling?.textContent).toBe(" ");
    expect(figures.nextElementSibling).toBe(currency);
    expect(currency.textContent).toBe("دج");
  });

  it("applies the caller's className to the currency, not only the figures (#254 round 2)", () => {
    // stock.tsx passes `text-foreground` inside a `text-muted-foreground`
    // paragraph. #254 moved the class to the figures run only, so the currency
    // silently inherited the muted paragraph colour — a real appearance change
    // beyond grouping and placement.
    const host = render(<Amount value={92500} className="text-foreground" />);
    const { figures, currency } = runs(host);
    expect(figures.classList.contains("text-foreground")).toBe(true);
    expect(currency.classList.contains("text-foreground")).toBe(true);
  });

  it("renders the same figures and currency placement through the real PrintAmount", () => {
    const host = render(<PrintAmount value={-100} />);
    const { figures, currency } = runs(host);
    // the sheet's own paper classes still land on the two runs (#254 moved the
    // formatter, not the sheet's type)
    expect(figures.classList.contains("print-sheet-ltr")).toBe(true);
    expect(currency.classList.contains("print-sheet-cur")).toBe(true);
    expect(host.textContent).toBe("-100 دج");
  });
});

/**
 * The guard behind "one currency placement": the currency is rendered by the
 * money primitive and nowhere else. A new raw `{value} {t("dzd")}` site is red
 * here, which is how returns.tsx and invoice.tsx drifted to the other side of
 * the number than `<Amount>` in the first place.
 */
describe("one currency placement (issue #254)", () => {
  const WEB_SRC = path.join(import.meta.dir, "..", "..");
  const AMOUNT_MODULE = path.join(WEB_SRC, "components", "ui", "amount.tsx");
  const I18N_MODULE = path.join(WEB_SRC, "lib", "i18n.ts");

  /**
   * Catalog keys whose VALUE embeds the currency literal beside a
   * `{{placeholder}}`. That is money built by a string template: the digits are
   * interpolated raw and the currency comes from the sentence, so neither ever
   * reaches `<Money>`. The call-site scan above cannot see a translated
   * sentence because the call site holds only a key (#254 round 2).
   */
  function catalogMoneyTemplateOffenders(): string[] {
    const offenders: string[] = [];
    for (const line of readFileSync(I18N_MODULE, "utf8").split("\n")) {
      const entry = /^\s*([A-Za-z0-9_]+):\s*"(.*)",\s*$/.exec(line);
      if (entry === null) continue;
      const key = entry[1] ?? "";
      const value = entry[2] ?? "";
      if (value.includes("دج") && value.includes("{{")) offenders.push(key);
    }
    return offenders;
  }

  function tsxFiles(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return tsxFiles(full);
      if (!entry.name.endsWith(".tsx")) return [];
      if (entry.name.endsWith(".test.tsx")) return [];
      return [full];
    });
  }

  it("lets only the money primitive name the currency", () => {
    const offenders = tsxFiles(WEB_SRC)
      .filter((file) => file !== AMOUNT_MODULE)
      .filter((file) => {
        const source = readFileSync(file, "utf8");
        return source.includes("currencyDinar") || source.includes("دج") || source.includes('"dzd"');
      })
      .map((file) => path.relative(WEB_SRC, file).replaceAll("\\", "/"))
      // i18n.ts holds the catalog value but is a .ts, so any .tsx above is a
      // second placement, not a catalog entry.
      .sort();
    expect(offenders).toEqual([]);
  });

  it("actually scans the tree it claims to (the guard is not vacuous)", () => {
    const files = tsxFiles(WEB_SRC);
    expect(files.length).toBeGreaterThan(30);
    expect(files).toContain(AMOUNT_MODULE);
  });

  it("catches money assembled by a translated sentence, and pins the one deferral", () => {
    const offenders = catalogMoneyTemplateOffenders();
    // non-vacuous: the detector does fire on a real entry
    expect(offenders).toContain("itemsProfitPerUnit");
    // itemsProfitPerUnit is the documented deferral: the same key is the
    // items-table header with `profit: ""`, so routing it through the primitive
    // needs a separate header key (see .scratch/implementation/254-design.md).
    // Every other money sentence now carries a <money/> component tag instead.
    expect(offenders).toEqual(["itemsProfitPerUnit"]);
  });
});
