import type { SupplierAdjustmentDirection, SupplierEntryKind } from "@dokan/contracts";

/**
 * #176 — the signed-display rule for a supplier account entry, shared by the
 * supplier detail page and the debts drill-down so an opposite-direction
 * adjustment can never look identical on the two screens. Mirrors
 * `supplierEntrySign` in the api's supplier-ledger module.
 */

/** The label keys for the two manual-adjustment directions. */
type DirectionLabelKey = "supplierAdjustDirectionWeOwe" | "supplierAdjustDirectionTheyOwe";

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
): DirectionLabelKey | null {
  if (entry.kind !== "ADJUSTMENT") return null;
  return supplierDirectionKey(entry.direction ?? "WE_OWE");
}

/**
 * The i18n key that names a direction (issue 252). WE_OWE is the value whose
 * sign raises what the shop owes the supplier; THEY_OWE lowers it.
 *
 * One definition on purpose. #176 wrote the map out by hand at each site and the
 * picker's copy carried each Darija on the other value, so the label contradicted
 * the hint beside it and a user picking by the label stored the opposite
 * direction. Every site that resolves a DIRECTION to its label goes through this
 * function (the picker's options and trigger, the adjust panel's two buttons, the
 * movement rows on the debts and party-detail screens); a signed balance goes
 * through `supplierBalanceDirectionKey`.
 */
export function supplierDirectionKey(direction: SupplierAdjustmentDirection): DirectionLabelKey {
  return direction === "THEY_OWE" ? "supplierAdjustDirectionTheyOwe" : "supplierAdjustDirectionWeOwe";
}

/** The hint shown beside a direction's label — the sentence that says what
 * picking it does to the balance. Resolved here, next to the label's key: #252
 * was a label that had drifted onto the other value while its own hint stayed
 * right, so the two strings for one direction are paired in one module and
 * pinned together by `supplier-entry-display.test.ts`. */
export function supplierDirectionHintKey(
  direction: SupplierAdjustmentDirection,
): "supplierAdjustDirectionWeOweHint" | "supplierAdjustDirectionTheyOweHint" {
  return direction === "THEY_OWE" ? "supplierAdjustDirectionTheyOweHint" : "supplierAdjustDirectionWeOweHint";
}

/** The direction a SIGNED supplier balance represents: positive is money the shop
 * owes the supplier (WE_OWE), negative is credit held with him (THEY_OWE). Zero
 * reads as WE_OWE — the convention the saved-balance column already used — and
 * the credit columns never call this at zero (they guard `!== 0` first). */
export function supplierBalanceDirectionKey(balance: number): DirectionLabelKey {
  return supplierDirectionKey(balance >= 0 ? "WE_OWE" : "THEY_OWE");
}
