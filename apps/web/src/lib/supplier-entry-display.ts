import type { SupplierAdjustmentDirection, SupplierEntryKind } from "@dokan/contracts";

/**
 * #176 — the signed-display rule for a supplier account entry, shared by the
 * supplier detail page and the debts drill-down so an opposite-direction
 * adjustment can never look identical on the two screens. Mirrors
 * `supplierEntrySign` in the api's supplier-ledger module.
 */

/** +1 when the entry raises what the shop owes, −1 when it lowers it. An
 * ADJUSTMENT's sign comes from its direction. */
export function supplierEntrySign(kind: SupplierEntryKind, direction: SupplierAdjustmentDirection | null): 1 | -1 {
  if (kind === "ADJUSTMENT") return direction === "THEY_OWE" ? -1 : 1;
  return kind === "PURCHASE" || kind === "REFUND" ? 1 : -1;
}

/** The leading sign shown before the amount. */
export function supplierEntrySignLabel(entry: { kind: SupplierEntryKind; direction: SupplierAdjustmentDirection | null }): "+" | "−" {
  return supplierEntrySign(entry.kind, entry.direction) === 1 ? "+" : "−";
}

/** The direction word for a raw stored `WE_OWE`/`THEY_OWE` token. ONE mapping:
 * the activity log (#253) and the supplier-account rows share it, so the two
 * screens can never disagree about who owes whom (#252 owns the label text). */
export function adjustmentDirectionKey(
  token: string | null,
): "supplierAdjustDirectionWeOwe" | "supplierAdjustDirectionTheyOwe" {
  return token === "THEY_OWE" ? "supplierAdjustDirectionTheyOwe" : "supplierAdjustDirectionWeOwe";
}

/** The direction word for an ADJUSTMENT, or null for every other kind (whose
 * direction is implied by the kind label). */
export function supplierEntryDirectionKey(
  entry: { kind: SupplierEntryKind; direction: SupplierAdjustmentDirection | null },
): "supplierAdjustDirectionWeOwe" | "supplierAdjustDirectionTheyOwe" | null {
  if (entry.kind !== "ADJUSTMENT") return null;
  return adjustmentDirectionKey(entry.direction);
}
