import type { DiscountType, PriceOverride } from "@dokan/contracts";

export interface SalePriceInput {
  defaultUnitPrice: number;
  unitPrice?: number;
  priceOverride?: PriceOverride;
  priceOverrideType?: "AMOUNT" | "PERCENTAGE";
  priceOverrideValue?: number;
}

export interface SaleLineTotalInput {
  quantity: number;
  price: SalePriceInput;
}

export interface SaleLineTotal {
  unitPrice: number;
  grossTotal: number;
  discountAllocated: number;
  netTotal: number;
}

export interface SaleTotals {
  subtotalAmount: number;
  discountType: DiscountType | null;
  discountValue: number | null;
  discountAmount: number;
  totalAmount: number;
  lines: SaleLineTotal[];
}

/** Resolve one line's historical actual price without mutating the default. */
export function resolveActualUnitPrice(input: SalePriceInput): number {
  if (input.unitPrice !== undefined) return input.unitPrice;
  const override = input.priceOverride ??
    (input.priceOverrideType !== undefined && input.priceOverrideValue !== undefined
      ? { type: input.priceOverrideType, value: input.priceOverrideValue }
      : undefined);
  if (override === undefined) return input.defaultUnitPrice;
  if (override.type === "AMOUNT") return override.value;
  return Math.round((input.defaultUnitPrice * override.value) / 100);
}

/**
 * Allocate an invoice discount proportionally across gross lines. Integer
 * remainders go to the lines with the largest fractional share, then earlier
 * lines win ties. This keeps line reporting additive to the invoice total.
 */
export function allocateInvoiceDiscount(grossTotals: readonly number[], requestedDiscount: number): number[] {
  const subtotal = grossTotals.reduce((sum, value) => sum + value, 0);
  const discount = Math.min(Math.max(0, requestedDiscount), subtotal);
  if (discount === 0 || subtotal === 0) return grossTotals.map(() => 0);

  const exact = grossTotals.map((gross) => (discount * gross) / subtotal);
  const allocations = exact.map((value) => Math.floor(value));
  let remainder = discount - allocations.reduce((sum, value) => sum + value, 0);
  const order = exact
    .map((value, index) => ({ index, fraction: value - Math.floor(value) }))
    .sort((a, b) => b.fraction - a.fraction || a.index - b.index);
  for (const entry of order) {
    if (remainder === 0) break;
    allocations[entry.index] = (allocations[entry.index] ?? 0) + 1;
    remainder -= 1;
  }
  return allocations;
}

/** Calculate line prices, subtotal, capped invoice discount, and final total. */
export function calculateSaleTotals(
  lines: readonly SaleLineTotalInput[],
  discount?: { type: DiscountType; value: number },
): SaleTotals {
  const priced = lines.map((line) => {
    const unitPrice = resolveActualUnitPrice(line.price);
    return { unitPrice, grossTotal: line.quantity * unitPrice };
  });
  const subtotalAmount = priced.reduce((sum, line) => sum + line.grossTotal, 0);
  const discountType = discount?.type ?? null;
  const discountValue = discount?.value ?? null;
  const requestedDiscount = discount === undefined
    ? 0
    : discount.type === "AMOUNT"
      ? discount.value
      : Math.round((subtotalAmount * discount.value) / 100);
  const discountAmount = Math.min(requestedDiscount, subtotalAmount);
  const allocations = allocateInvoiceDiscount(priced.map((line) => line.grossTotal), discountAmount);
  const resultLines = priced.map((line, index) => {
    const discountAllocated = allocations[index] ?? 0;
    return {
      unitPrice: line.unitPrice,
      grossTotal: line.grossTotal,
      discountAllocated,
      netTotal: line.grossTotal - discountAllocated,
    };
  });
  return {
    subtotalAmount,
    discountType,
    discountValue,
    discountAmount,
    totalAmount: subtotalAmount - discountAmount,
    lines: resultLines,
  };
}
