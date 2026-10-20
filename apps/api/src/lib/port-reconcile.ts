/**
 * #277: what a shutting-down instance owes the shared port record.
 *
 * Three duties, decided here and pinned by a unit test so main.ts cannot drift
 * back into always reconciling:
 *
 * - `canonical` — this instance published the full record (registry entry plus
 *   `.dokan-port`), so it withdraws its entry and points the canonical at the
 *   newest surviving instance.
 * - `registry` — this instance was refused the folder: it published only its
 *   own per-pid registry entry, so the desktop shell's identity check could
 *   verify the child it spawned (`desktop.rs` `registry_owned_by`), and it
 *   never wrote the canonical. It removes its own entry and touches nothing
 *   else: recomputing canonical from the registry's survivors could delete or
 *   repoint the owner's record while it is still serving.
 * - `none` — it published nothing at all (a refusal that never bound, a
 *   plaintext boot that failed before publishing), so it owes nothing.
 *
 * Pure so the decision is testable without a filesystem.
 */
export type PortRecordDuty = "canonical" | "registry" | "none";

export function portRecordReconcileMode(portPublished: boolean, registryPublished: boolean): PortRecordDuty {
  if (portPublished) return "canonical";
  return registryPublished ? "registry" : "none";
}
