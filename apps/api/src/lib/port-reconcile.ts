/**
 * #277: whether a shutting-down instance may reconcile the shared port record.
 *
 * A start that was refused because another copy owns the data folder never
 * published a registry entry of its own, and the canonical `.dokan-port`
 * belongs to the owner. Reconciling would recompute canonical from the
 * registry's surviving entries (which includes the owner's) and could delete
 * or repoint the owner's record while it is still serving. So the decision is
 * a plain predicate: only a process that published has something to withdraw.
 *
 * Pure so a unit test pins it and main.ts cannot drift back into always
 * reconciling.
 */
export function shouldReconcilePortRecord(portPublished: boolean): boolean {
  return portPublished;
}
