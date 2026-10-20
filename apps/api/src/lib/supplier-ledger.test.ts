import { describe, expect, it } from "bun:test";

import { supplierEntryKinds } from "@dokan/contracts";

import {
  adjustmentDedupKey,
  allocateOldestFirst,
  availableSupplierCredit,
  deriveInvoicePaid,
  hasExplicitIdempotencyKey,
  splitAgainstRemaining,
  SUPPLIER_ENTRY_KINDS,
  SUPPLIER_ENTRY_RULES,
  supplierBalance,
  supplierChargeEntryAmount,
  supplierEntrySign,
  supplierReturnSplit,
  UnsignableSupplierEntryError,
  type AdjustmentDedupInput,
  type AllocatableInvoice,
} from "./supplier-ledger";


describe("supplierEntrySign", () => {
  it("#260 — a purchase/refund is a debt (negative), a payment/return a credit (positive)", () => {
    expect(supplierEntrySign("PURCHASE")).toBe(-1);
    expect(supplierEntrySign("REFUND")).toBe(-1);
    expect(supplierEntrySign("PAYMENT")).toBe(1);
    expect(supplierEntrySign("RETURN")).toBe(1);
  });

  it("signs a manual adjustment by its direction (issue 176, #260)", () => {
    // يسالنا = we owe him = the balance goes negative
    expect(supplierEntrySign("ADJUSTMENT", "WE_OWE")).toBe(-1);
    // نسالوه = he owes us = the balance goes positive (a credit)
    expect(supplierEntrySign("ADJUSTMENT", "THEY_OWE")).toBe(1);
  });

  it("refuses to sign an adjustment with no direction rather than guess", () => {
    expect(() => supplierEntrySign("ADJUSTMENT")).toThrow(/direction/);
    expect(() => supplierEntrySign("ADJUSTMENT", null)).toThrow(/direction/);
  });

  it("refuses a kind the rule table does not define instead of crashing", () => {
    // `kind` is TEXT NOT NULL with no CHECK (db/schema.ts), so a row the write
    // seams cannot produce but the database allows reaches this fold. The SQL
    // reader answers NULL for it; the TypeScript fold must refuse the same way,
    // not die on an undefined rule.
    let caught: UnsignableSupplierEntryError | undefined;
    try {
      supplierEntrySign("BOGUS", null, "entry-9", "supplier-3");
    } catch (error) {
      if (!(error instanceof UnsignableSupplierEntryError)) throw error;
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnsignableSupplierEntryError);
    expect(caught).toMatchObject({ kind: "BOGUS", entryId: "entry-9", supplierId: "supplier-3" });
    expect(caught?.message).toContain("BOGUS");
  });

  it("refuses a direction Object.prototype happens to own", () => {
    // `directions` is an object literal, so `direction in directions` is true for
    // every inherited name and would hand back a FUNCTION where a sign belongs.
    for (const direction of ["toString", "constructor", "valueOf", "hasOwnProperty"]) {
      let caught: UnsignableSupplierEntryError | undefined;
      try {
        supplierEntrySign("ADJUSTMENT", direction);
      } catch (error) {
        if (!(error instanceof UnsignableSupplierEntryError)) throw error;
        caught = error;
      }
      expect(caught, `${direction} signed instead of refusing`).toBeInstanceOf(UnsignableSupplierEntryError);
      expect(caught).toMatchObject({ kind: "ADJUSTMENT", direction });
    }
  });
});

/**
 * #317 — the kind-to-sign rule is DATA (SUPPLIER_ENTRY_RULES) and both readers
 * consume it. These tests pin the table itself: one case per kind, so a new kind
 * cannot arrive without a sign, and the direction-required kind fails loudly.
 */
describe("SUPPLIER_ENTRY_RULES — one table decides every kind's sign (#317)", () => {
  it("holds every kind exactly once", () => {
    expect([...SUPPLIER_ENTRY_KINDS].sort()).toEqual(["ADJUSTMENT", "PAYMENT", "PURCHASE", "REFUND", "RETURN"]);
  });

  it("is pinned to the contracts kind list, so a new kind names its own omission", () => {
    // The canonical list feeds the DB enum, the zod schema and the port. Adding a
    // kind there and forgetting this table used to surface as a cryptic widening
    // error where the wider type met the narrower one; the diff below names the
    // kind instead.
    const missingFromRules = supplierEntryKinds.filter((kind) => !SUPPLIER_ENTRY_KINDS.includes(kind));
    const missingFromContract = SUPPLIER_ENTRY_KINDS.filter((kind) => !supplierEntryKinds.includes(kind));
    expect({ missingFromRules, missingFromContract }).toEqual({ missingFromRules: [], missingFromContract: [] });
  });

  // The expected sign is the SPEC (#260), written out here rather than read back
  // from the table: a test that recomputes the table proves nothing.
  const fixed: ReadonlyArray<["PURCHASE" | "REFUND" | "PAYMENT" | "RETURN", 1 | -1, string]> = [
    ["PURCHASE", -1, "a purchase is a charge: the shop owes the supplier"],
    ["REFUND", -1, "a refund is money leaving the register: it restores the debt"],
    ["PAYMENT", 1, "a payment reduces what the shop owes"],
    ["RETURN", 1, "a return reduces what the shop owes"],
  ];

  for (const [kind, sign, why] of fixed) {
    it(`${kind} carries ${sign > 0 ? "+1" : "−1"} — ${why}`, () => {
      expect(SUPPLIER_ENTRY_RULES[kind]).toEqual({ directionRequired: false, sign });
      expect(supplierEntrySign(kind)).toBe(sign);
      // a fixed kind ignores a direction: it cannot be flipped by one
      expect(supplierEntrySign(kind, "WE_OWE")).toBe(sign);
      expect(supplierEntrySign(kind, "THEY_OWE")).toBe(sign);
    });
  }

  it("ADJUSTMENT requires a direction and takes its sign from it", () => {
    expect(SUPPLIER_ENTRY_RULES.ADJUSTMENT).toEqual({
      directionRequired: true,
      directions: { WE_OWE: -1, THEY_OWE: 1 },
    });
    expect(supplierEntrySign("ADJUSTMENT", "WE_OWE")).toBe(-1);
    expect(supplierEntrySign("ADJUSTMENT", "THEY_OWE")).toBe(1);
  });

  it("fails loudly instead of defaulting when the required direction is missing", () => {
    for (const missing of [undefined, null]) {
      let caught: UnsignableSupplierEntryError | undefined;
      try {
        supplierEntrySign("ADJUSTMENT", missing);
      } catch (error) {
        if (!(error instanceof UnsignableSupplierEntryError)) throw error;
        caught = error;
      }
      // a typed refusal, not a plain Error and never a silent −1
      expect(caught).toBeInstanceOf(UnsignableSupplierEntryError);
      expect(caught).toMatchObject({ kind: "ADJUSTMENT", direction: null, entryId: null });
      expect(caught?.message).toMatch(/direction/);
    }
  });

  it("names the entry and its kind in the refusal (issue 317, story 9)", () => {
    let caught: UnsignableSupplierEntryError | undefined;
    try {
      // the fold is where an owner-visible read meets a corrupt row
      supplierBalance([{ id: "entry-7", kind: "ADJUSTMENT", amount: 500 }]);
    } catch (error) {
      if (!(error instanceof UnsignableSupplierEntryError)) throw error;
      caught = error;
    }
    expect(caught).toBeInstanceOf(UnsignableSupplierEntryError);
    expect(caught).toMatchObject({ kind: "ADJUSTMENT", entryId: "entry-7" });
    expect(caught?.message).toContain("entry-7");
  });
});

describe("supplierBalance", () => {
  it("sums the signed account: positive = the supplier owes us (a credit)", () => {
    const entries = [
      { kind: "PURCHASE" as const, amount: 1000 },
      { kind: "PAYMENT" as const, amount: 400 },
      { kind: "RETURN" as const, amount: 100 },
      { kind: "REFUND" as const, amount: 50 },
    ];
    expect(supplierBalance(entries)).toBe(-1000 + 400 + 100 - 50);
  });

  it("goes positive when the shop is ahead (a credit)", () => {
    expect(supplierBalance([
      { kind: "PURCHASE" as const, amount: 100 },
      { kind: "PAYMENT" as const, amount: 250 },
    ])).toBe(150);
  });

  it("is zero for an empty account", () => {
    expect(supplierBalance([])).toBe(0);
  });

  it("mixes a signed adjustment into the balance by its direction (issue 176)", () => {
    const entries = [
      { kind: "PURCHASE" as const, amount: 1000, direction: null },
      { kind: "ADJUSTMENT" as const, amount: 800, direction: "WE_OWE" as const },
      { kind: "ADJUSTMENT" as const, amount: 500, direction: "THEY_OWE" as const },
    ];
    expect(supplierBalance(entries)).toBe(-1000 - 800 + 500);
  });

  it("moves an opening balance the right way from an empty account", () => {
    expect(supplierBalance([{ kind: "ADJUSTMENT" as const, amount: 25000, direction: "WE_OWE" as const }])).toBe(-25000);
    expect(supplierBalance([{ kind: "ADJUSTMENT" as const, amount: 3000, direction: "THEY_OWE" as const }])).toBe(3000);
  });
});

describe("splitAgainstRemaining", () => {
  it("attaches what fits and turns the excess into credit", () => {
    expect(splitAgainstRemaining(300, 500)).toEqual({ attached: 300, credit: 0 });
    expect(splitAgainstRemaining(500, 300)).toEqual({ attached: 300, credit: 200 });
  });

  it("keeps the whole amount as credit when nothing is owed", () => {
    expect(splitAgainstRemaining(120, 0)).toEqual({ attached: 0, credit: 120 });
  });
});

describe("deriveInvoicePaid", () => {
  it("sums only the PAYMENT entries that name the invoice, capped at the total", () => {
    const entries = [
      { kind: "PURCHASE" as const, amount: 1000, invoiceId: "inv-1" },
      { kind: "PAYMENT" as const, amount: 300, invoiceId: "inv-1" },
      // a return reduces the debt but is not money paid: it is surfaced as
      // returnCreditAmount, not counted here
      { kind: "RETURN" as const, amount: 200, invoiceId: "inv-1" },
      // a credit payment names no invoice and must not touch this one
      { kind: "PAYMENT" as const, amount: 999, invoiceId: null },
      // another invoice's payment is not this invoice's
      { kind: "PAYMENT" as const, amount: 500, invoiceId: "inv-2" },
    ];
    expect(deriveInvoicePaid(entries, "inv-1", 1000)).toBe(300);
  });

  it("never exceeds the invoice total even if corrupt entries would", () => {
    const entries = [
      { kind: "PAYMENT" as const, amount: 800, invoiceId: "inv-1" },
      { kind: "PAYMENT" as const, amount: 800, invoiceId: "inv-1" },
    ];
    expect(deriveInvoicePaid(entries, "inv-1", 1000)).toBe(1000);
  });

  it("is zero for an invoice with no entries", () => {
    expect(deriveInvoicePaid([], "inv-1", 1000)).toBe(0);
  });
});

const invoice = (over: Partial<AllocatableInvoice> & Pick<AllocatableInvoice, "id">): AllocatableInvoice => ({
  invoiceDate: "2026-01-01",
  createdAt: "2026-01-01T10:00:00",
  invoiceNumber: "INV-0001",
  remainingAmount: 100,
  ...over,
});

describe("allocateOldestFirst", () => {
  it("fills the oldest invoice first and stops when the amount runs out", () => {
    const invoices = [
      invoice({ id: "b", invoiceDate: "2026-02-01", invoiceNumber: "INV-0002", remainingAmount: 400 }),
      invoice({ id: "a", invoiceDate: "2026-01-01", invoiceNumber: "INV-0001", remainingAmount: 300 }),
    ];
    const plan = allocateOldestFirst(invoices, 500);
    expect(plan.map((line) => [line.invoice.id, line.applied])).toEqual([
      ["a", 300],
      ["b", 200],
    ]);
  });

  it("caps each invoice at its remaining and leaves the tail undistributed", () => {
    const invoices = [
      invoice({ id: "a", invoiceDate: "2026-01-01", invoiceNumber: "INV-0001", remainingAmount: 100 }),
      invoice({ id: "b", invoiceDate: "2026-02-01", invoiceNumber: "INV-0002", remainingAmount: 100 }),
    ];
    const plan = allocateOldestFirst(invoices, 250);
    expect(plan.reduce((sum, line) => sum + line.applied, 0)).toBe(200);
  });

  it("ignores settled invoices", () => {
    const invoices = [
      invoice({ id: "a", invoiceDate: "2026-01-01", invoiceNumber: "INV-0001", remainingAmount: 0 }),
      invoice({ id: "b", invoiceDate: "2026-02-01", invoiceNumber: "INV-0002", remainingAmount: 100 }),
    ];
    const plan = allocateOldestFirst(invoices, 50);
    expect(plan.map((line) => line.invoice.id)).toEqual(["b"]);
    expect(plan[0]?.applied).toBe(50);
  });

  it("breaks same-date ties by creation then invoice number", () => {
    const invoices = [
      invoice({ id: "c", invoiceDate: "2026-01-01", createdAt: "2026-01-01T12:00:00", invoiceNumber: "INV-0003", remainingAmount: 10 }),
      invoice({ id: "a", invoiceDate: "2026-01-01", createdAt: "2026-01-01T09:00:00", invoiceNumber: "INV-0001", remainingAmount: 10 }),
      invoice({ id: "b", invoiceDate: "2026-01-01", createdAt: "2026-01-01T09:00:00", invoiceNumber: "INV-0002", remainingAmount: 10 }),
    ];
    expect(allocateOldestFirst(invoices, 30).map((line) => line.invoice.id)).toEqual(["a", "b", "c"]);
  });

  it("allocates nothing for a non-positive or non-finite amount", () => {
    const invoices = [invoice({ id: "a", remainingAmount: 100 })];
    expect(allocateOldestFirst(invoices, 0).every((line) => line.applied === 0)).toBe(true);
    expect(allocateOldestFirst(invoices, Number.NaN).every((line) => line.applied === 0)).toBe(true);
  });
});

describe("availableSupplierCredit", () => {
  it("is the size of a positive credit and zero when the shop owes (#260)", () => {
    expect(availableSupplierCredit(800)).toBe(800);
    expect(availableSupplierCredit(-1200)).toBe(0);
    expect(availableSupplierCredit(0)).toBe(0);
  });
});

describe("supplierChargeEntryAmount", () => {
  it("opens a charge for a positive total and none for a free purchase", () => {
    expect(supplierChargeEntryAmount(2000)).toBe(2000);
    expect(supplierChargeEntryAmount(0)).toBeNull();
    // a corrupt negative total must never become a ledger entry
    expect(supplierChargeEntryAmount(-5)).toBeNull();
  });
});

describe("supplierReturnSplit", () => {
  it("reduces the invoice debt up to its remaining, the rest is credit", () => {
    expect(supplierReturnSplit(400, 250)).toEqual({ debtReduction: 250, credit: 150 });
  });

  it("is all credit when no invoice is named", () => {
    expect(supplierReturnSplit(400, null)).toEqual({ debtReduction: 0, credit: 400 });
  });

  it("is all credit when the named invoice is already settled", () => {
    expect(supplierReturnSplit(400, 0)).toEqual({ debtReduction: 0, credit: 400 });
  });
});

describe("adjustmentDedupKey (issue 181)", () => {
  const signature: AdjustmentDedupInput = {
    supplierId: "sup-1",
    direction: "WE_OWE",
    amount: 500,
    reason: "رصيد افتتاحي",
    occurredAt: "2026-10-13T12:00:00",
    invoiceId: null,
  };

  it("is stable for an identical signature", () => {
    expect(adjustmentDedupKey(signature)).toBe(adjustmentDedupKey({ ...signature }));
  });

  it("is time-sensitive for a caller-supplied date and time-insensitive when server-stamped", () => {
    expect(adjustmentDedupKey(signature)).not.toBe(adjustmentDedupKey({ ...signature, occurredAt: "2026-10-14T12:00:00" }));
    // a retry of an omitted-date call is the same key at any fresh server clock
    expect(adjustmentDedupKey({ ...signature, serverStamped: true })).toBe(
      adjustmentDedupKey({ ...signature, serverStamped: true, occurredAt: "2099-01-01T00:00:00" }),
    );
  });

  it("treats each signature column as its own dimension", () => {
    const base = adjustmentDedupKey(signature);
    expect(adjustmentDedupKey({ ...signature, amount: 501 })).not.toBe(base);
    expect(adjustmentDedupKey({ ...signature, direction: "THEY_OWE" })).not.toBe(base);
    expect(adjustmentDedupKey({ ...signature, reason: "تصحيح" })).not.toBe(base);
    expect(adjustmentDedupKey({ ...signature, invoiceId: "inv-1" })).not.toBe(base);
    expect(adjustmentDedupKey({ ...signature, supplierId: "sup-2" })).not.toBe(base);
  });

  it("distinguishes a null reason from an empty one (NULL-safe encoding)", () => {
    expect(adjustmentDedupKey({ ...signature, reason: null })).not.toBe(adjustmentDedupKey({ ...signature, reason: "" }));
  });

  it("lets an explicit key win over the signature and over serverStamped", () => {
    // the same key with a changed timestamp is still the SAME logical request
    const first = adjustmentDedupKey({ ...signature, idempotencyKey: "key-1" });
    expect(adjustmentDedupKey({ ...signature, idempotencyKey: "key-1", occurredAt: "2026-10-14T12:00:00" })).toBe(first);
    // ... even when the shape changes; the key is the whole contract
    expect(adjustmentDedupKey({ ...signature, idempotencyKey: "key-1", amount: 999, reason: "غير ذلك" })).toBe(first);
    expect(adjustmentDedupKey({ ...signature, idempotencyKey: "key-1", serverStamped: true })).toBe(first);
    // a different key is a different request, and a key never collides with a signature
    expect(adjustmentDedupKey({ ...signature, idempotencyKey: "key-2" })).not.toBe(first);
    expect(first).not.toBe(adjustmentDedupKey(signature));
  });

  it("trims the key and treats a blank one as absent", () => {
    expect(adjustmentDedupKey({ ...signature, idempotencyKey: "  key-1  " })).toBe(
      adjustmentDedupKey({ ...signature, idempotencyKey: "key-1" }),
    );
    expect(adjustmentDedupKey({ ...signature, idempotencyKey: "   " })).toBe(adjustmentDedupKey(signature));
    expect(adjustmentDedupKey({ ...signature, idempotencyKey: null })).toBe(adjustmentDedupKey(signature));
  });

  it("only treats a trimmed non-empty key as explicit", () => {
    expect(hasExplicitIdempotencyKey({ idempotencyKey: "k" })).toBe(true);
    expect(hasExplicitIdempotencyKey({ idempotencyKey: " k " })).toBe(true);
    expect(hasExplicitIdempotencyKey({ idempotencyKey: "  " })).toBe(false);
    expect(hasExplicitIdempotencyKey({ idempotencyKey: null })).toBe(false);
    expect(hasExplicitIdempotencyKey({})).toBe(false);
  });

  it("scopes the key to the account", () => {
    expect(adjustmentDedupKey({ ...signature, idempotencyKey: "same" })).not.toBe(
      adjustmentDedupKey({ ...signature, supplierId: "sup-2", idempotencyKey: "same" }),
    );
  });

  it("pins the on-disk key format", () => {
    // a golden string: already-migrated rows and fresh writes must agree, so a
    // silent format change is a breaking change to the stored contract
    expect(adjustmentDedupKey(signature)).toBe('sig:["sup-1","WE_OWE",500,"رصيد افتتاحي",null,"2026-10-13T12:00:00"]');
    expect(adjustmentDedupKey({ ...signature, serverStamped: true })).toBe('sig:["sup-1","WE_OWE",500,"رصيد افتتاحي",null,null]');
    expect(adjustmentDedupKey({ ...signature, idempotencyKey: "key-1" })).toBe('key:["sup-1","key-1"]');
  });

  it("ignores ref, which is in neither form (issue 181 review)", () => {
    const withRef: AdjustmentDedupInput & { ref: string } = { ...signature, ref: "REF-B" };
    // pinned against the golden format, not just self-equality
    expect(adjustmentDedupKey(withRef)).toBe('sig:["sup-1","WE_OWE",500,"رصيد افتتاحي",null,"2026-10-13T12:00:00"]');
    const keyedWithRef: AdjustmentDedupInput & { ref: string } = { ...signature, idempotencyKey: "key-1", ref: "REF-B" };
    expect(adjustmentDedupKey(keyedWithRef)).toBe('key:["sup-1","key-1"]');
  });

  it("cannot be forged by crafted text (JSON encoding)", () => {
    // a reason that embeds a whole other tuple cannot collide with it
    expect(adjustmentDedupKey({ ...signature, reason: '"],["sup-1","WE_OWE",500,null,null]' })).not.toBe(adjustmentDedupKey(signature));
    // a key that happens to be another row's signature stays in its own namespace
    expect(adjustmentDedupKey({ ...signature, idempotencyKey: adjustmentDedupKey(signature) })).not.toBe(adjustmentDedupKey(signature));
  });
});
