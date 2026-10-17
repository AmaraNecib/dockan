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
 * screens can never disagree about who owes whom (#252 owns the label text).
 *
 * A token adapter, not a second map: the pairing itself lives only in
 * `supplierDirectionKey` below, so the log's rows and the supplier-account rows
 * cannot drift apart. #265 wrote this ternary out by hand; #252 is the bug that a
 * second reading of the same map causes, so the merge of the two keeps this name
 * and its `string | null` signature while the mapping stays in ONE place. */
export function adjustmentDirectionKey(
  token: string | null,
): "supplierAdjustDirectionWeOwe" | "supplierAdjustDirectionTheyOwe" {
  return supplierDirectionKey(token === "THEY_OWE" ? "THEY_OWE" : "WE_OWE");
}

/** The direction word for an ADJUSTMENT, or null for every other kind (whose
 * direction is implied by the kind label). */
export function supplierEntryDirectionKey(
  entry: { kind: SupplierEntryKind; direction: SupplierAdjustmentDirection | null },
): "supplierAdjustDirectionWeOwe" | "supplierAdjustDirectionTheyOwe" | null {
  if (entry.kind !== "ADJUSTMENT") return null;
  return supplierDirectionKey(entry.direction ?? "WE_OWE");
}

/**
 * The i18n key that names a direction (issue 252). WE_OWE is the value whose
 * sign raises what the shop owes the supplier; THEY_OWE lowers it.
 *
 * One definition on purpose: the picker's `items` map, its trigger and the
 * movement rows on the debts and party-detail screens all resolve a direction
 * through this function. #176 had two hand-written readings of the same map, and
 * the picker's copy carried each Darija on the other value — a label sits on the
 * value its own hint describes, or it is the bug this test exists for.
 */
export function supplierDirectionKey(
  direction: SupplierAdjustmentDirection,
): "supplierAdjustDirectionWeOwe" | "supplierAdjustDirectionTheyOwe" {
  return direction === "THEY_OWE" ? "supplierAdjustDirectionTheyOwe" : "supplierAdjustDirectionWeOwe";
}
