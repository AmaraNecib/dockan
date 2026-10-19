import { describe, expect, it } from "bun:test";

import { shouldReconcilePortRecord } from "./port-reconcile";

/**
 * #277: a refused start owns no port record, so its shutdown must not
 * reconcile the owner's. Without this decision the refused instance removes
 * the canonical record (or repoints it at a survivor) on the way out.
 */
describe("port record shutdown decision", () => {
  it("reconciles only when this instance published", () => {
    expect(shouldReconcilePortRecord(true)).toBe(true);
    expect(shouldReconcilePortRecord(false)).toBe(false);
  });
});
