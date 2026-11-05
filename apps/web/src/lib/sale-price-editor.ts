import { saleOverrideInvalid, saleUnitPrice, type SaleDraftLine } from "./invoice-draft";

export type SalePriceMode = "AMOUNT" | "PERCENTAGE";
export type SalePriceOverride = Pick<SaleDraftLine, "overrideType" | "overrideValue">;

export function parseSalePriceMode(raw: string | undefined): SalePriceMode {
  return raw === "PERCENTAGE" ? "PERCENTAGE" : "AMOUNT";
}

/** Presentation switches preserve the exact billed DZD, never an approximate ratio. */
export function switchSalePriceMode(line: SaleDraftLine, next: SalePriceMode, previousPercentage?: string): SalePriceOverride | null {
  if (saleOverrideInvalid(line)) return null;
  if (line.overrideType === "" || line.overrideType === next) return { overrideType: line.overrideType, overrideValue: line.overrideValue };
  const price = saleUnitPrice(line);
  if (next === "AMOUNT") return { overrideType: next, overrideValue: String(price) };
  if (previousPercentage !== undefined) {
    const previous = { ...line, overrideType: next, overrideValue: previousPercentage };
    if (!saleOverrideInvalid(previous) && saleUnitPrice(previous) === price) return { overrideType: next, overrideValue: previousPercentage };
  }
  for (let percentage = 0; percentage <= 100; percentage++) {
    if (Math.round(line.item.sellingPrice * percentage / 100) === price) return { overrideType: next, overrideValue: String(percentage) };
  }
  return null;
}

export function salePriceInput(line: SaleDraftLine, mode: SalePriceMode): string {
  return line.overrideType === "" ? String(mode === "AMOUNT" ? line.item.sellingPrice : 100) : line.overrideValue;
}
