import { describe, expect, it } from "bun:test";

import { displayAlgerianPhone } from "@dokan/contracts";

/**
 * Phone display — the owner reads the LOCAL 0-prefixed form while storage
 * stays canonical +213. Non-Algerian values pass through untouched so a
 * landline or foreign number is never blanked or mangled.
 */
describe("displayAlgerianPhone — local form for the owner", () => {
  it("converts the canonical +213 form to the local 0-prefixed form", () => {
    expect(displayAlgerianPhone("+213667295778")).toBe("0667295778");
  });

  it("returns an already-local number unchanged", () => {
    expect(displayAlgerianPhone("0667295778")).toBe("0667295778");
  });

  it("folds Arabic-Indic digits before converting", () => {
    expect(displayAlgerianPhone("+٢١٣٦٦٧٢٩٥٧٧٨")).toBe("0667295778");
    expect(displayAlgerianPhone("٠٦٦٧٢٩٥٧٧٨")).toBe("0667295778");
    expect(displayAlgerianPhone("+۲۱۳۶۶۷۲۹۵۷۷۸")).toBe("0667295778");
  });

  it("drops spaces and dashes from a formatted local number", () => {
    expect(displayAlgerianPhone("0667 29 57 78")).toBe("0667295778");
    expect(displayAlgerianPhone("+213-667-295-778")).toBe("0667295778");
  });

  it("returns a foreign or odd value as-is (never blank, never mangled)", () => {
    expect(displayAlgerianPhone("+33123456789")).toBe("+33123456789");
    expect(displayAlgerianPhone("021234567")).toBe("021234567");
    expect(displayAlgerianPhone("abc")).toBe("abc");
    expect(displayAlgerianPhone("")).toBe("");
  });
});
