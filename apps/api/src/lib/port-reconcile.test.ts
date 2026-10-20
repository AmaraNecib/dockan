import { describe, expect, it } from "bun:test";

import { portRecordReconcileMode } from "./port-reconcile";

/**
 * #277: what a refused start owes the port record on the way out.
 *
 * A start refused the folder publishes ONLY its own per-pid registry entry, so
 * the desktop shell's identity check can verify the child it spawned. It never
 * writes the canonical `.dokan-port`, which belongs to the copy that owns the
 * folder. So its shutdown removes its own entry and must not reconcile the
 * owner's record.
 */
describe("port record shutdown duty", () => {
  it("reconciles the canonical record only when this instance published it", () => {
    expect(portRecordReconcileMode(true, true)).toBe("canonical");
    // a registry entry plus a canonical write left portPublished true in every
    // real path; the canonical duty still wins when both flags are set
    expect(portRecordReconcileMode(true, false)).toBe("canonical");
  });

  it("removes only its own registry entry when it was refused the folder", () => {
    // the refused start's whole publication: no canonical, so nothing to
    // recompute and no reason to probe the owner's surviving entries
    expect(portRecordReconcileMode(false, true)).toBe("registry");
  });

  it("owes nothing when it published nothing", () => {
    expect(portRecordReconcileMode(false, false)).toBe("none");
  });
});
