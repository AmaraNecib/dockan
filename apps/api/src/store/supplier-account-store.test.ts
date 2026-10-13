import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAppConfig } from "../config";
import { openConnection, type Connection } from "../db/connection";
import { localDate, localDateTime } from "../lib/logger";
import { adjustmentDedupKey, deriveInvoicePaid, supplierBalance } from "../lib/supplier-ledger";
import { backfillSupplierAccounts, createDrizzleStore } from "./drizzle-store";
import type { StorePort } from "./port";

/**
 * Store-seam tests for the signed supplier account (issue 161): the backfill of
 * existing purchase invoices, the entry ledger, the outstanding-invoice read
 * the allocation uses, and the supplier-return cap read.
 */
let dir: string;
let conn: Connection;
let store: StorePort;

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-supplier-"));
  conn = openConnection(createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: path.join(dir, "test.db") }));
  store = createDrizzleStore(conn);
  await store.setup();
});

afterAll(() => {
  conn.close();
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Bun.sleepSync(50);
    }
  }
});

const now = () => localDateTime();
let invoiceSequence = 0;

async function makeSupplier(name: string) {
  return store.createParty("supplier", { name });
}

async function makeItem(name: string, cost: number) {
  const category = (await store.listCategories())[0];
  if (category === undefined) throw new Error("expected a seeded category");
  return store.createItem({ name, categoryId: category.id, costPrice: cost, sellingPrice: cost * 2 });
}

async function makePurchase(supplierId: string, total: number) {
  const invoice = await store.insertInvoice({
    invoiceNumber: `INV-${String(++invoiceSequence).padStart(6, "0")}`,
    kind: "PURCHASE",
    counterpartyId: supplierId,
    counterpartyName: null,
    invoiceDate: localDate(),
    totalAmount: total,
    paidAmount: 0,
    remainingAmount: total,
    notes: null,
  });
  return invoice;
}

describe("supplier account store", () => {
  it("backfills a charge and a payment entry for an existing purchase invoice", async () => {
    const supplier = await makeSupplier("مورد ترحيل");
    const invoice = await makePurchase(supplier.id, 1000);
    await store.insertPayment({ invoiceId: invoice.id, amount: 300, method: "CASH", note: null, paidAt: now() });
    // the backfill reads the invoice's paid cache (the authority the app
    // already displayed), not the payment rows
    await store.setInvoicePaidAmounts(invoice.id, 300, 700);

    // setup() already ran the backfill on the empty database; clear the marker
    // to exercise the migration against these rows, exactly as an upgrade would.
    conn.raw.query("DELETE FROM settings WHERE key = ?").run("migration.supplierAccountV1");
    backfillSupplierAccounts(conn);

    const entries = await store.listSupplierEntries(supplier.id);
    expect(entries.filter((entry) => entry.kind === "PURCHASE").map((entry) => entry.amount)).toEqual([1000]);
    expect(entries.filter((entry) => entry.kind === "PAYMENT").map((entry) => entry.amount)).toEqual([300]);
    expect(supplierBalance(entries)).toBe(700);
    // marker-gated: a second call is a no-op, never a double charge
    backfillSupplierAccounts(conn);
    expect((await store.listSupplierEntries(supplier.id)).length).toBe(2);
  });

  it("records a payment entry and keeps the outstanding invoice read in sync", async () => {
    const supplier = await makeSupplier("مورد دفع");
    const invoice = await makePurchase(supplier.id, 500);
    await store.insertSupplierEntry({ supplierId: supplier.id, kind: "PURCHASE", amount: 500, invoiceId: invoice.id, occurredAt: now() });

    const outstanding = await store.listOutstandingPurchaseInvoices(supplier.id);
    expect(outstanding.map((row) => row.id)).toEqual([invoice.id]);

    await store.insertSupplierEntry({ supplierId: supplier.id, kind: "PAYMENT", amount: 200, invoiceId: invoice.id, method: "CASH", occurredAt: now() });
    await store.applyPaymentToInvoice(invoice.id, 200);

    const entries = await store.listSupplierEntries(supplier.id);
    expect(supplierBalance(entries)).toBe(300);
    const stillOwed = await store.listOutstandingPurchaseInvoices(supplier.id);
    expect(stillOwed[0]?.remainingAmount).toBe(300);
  });

  it("stores a supplier return and reads back the per-line returned quantity", async () => {
    const supplier = await makeSupplier("مورد مرتجع");
    const item = await makeItem("قطعة مرتجع", 40);
    const invoice = await makePurchase(supplier.id, 400);
    const line = await store.insertInvoiceLine({
      invoiceId: invoice.id,
      itemId: item.id,
      description: item.name,
      quantity: 10,
      unitPrice: 40,
      costAtSale: 40,
      total: 400,
    });
    const { id: returnId } = await store.insertSupplierReturn({
      returnNumber: "PRT-0001",
      supplierId: supplier.id,
      invoiceId: invoice.id,
      kind: "INVOICE_LINKED",
      amount: 120,
      debtReduction: 120,
      credit: 0,
      cashBack: 0,
      reason: null,
      occurredAt: now(),
    });
    await store.insertSupplierReturnLine({
      returnId,
      invoiceLineId: line.id,
      itemId: item.id,
      description: item.name,
      quantity: 3,
      unitCost: 40,
      amount: 120,
    });
    const returned = await store.returnedByPurchaseLine(invoice.id);
    expect(returned.get(line.id)).toBe(3);
    const history = (await store.listSupplierReturns({ supplierId: supplier.id })).items;
    expect(history).toHaveLength(1);
    expect(history[0]?.returnNumber).toBe("PRT-0001");
    // the supplier's current name is joined so the voucher/history identify it
    expect(history[0]?.supplierName).toBe("مورد مرتجع");
    expect(history[0]?.lines[0]?.quantity).toBe(3);
    const detail = await store.getSupplierReturn(returnId);
    expect(detail?.amount).toBe(120);
  });

  it("keeps the invoice cache reconcilable from the entries and returns that name it", async () => {
    const supplier = await makeSupplier("مورد اشتقاق");
    const invoice = await makePurchase(supplier.id, 900);
    await store.insertSupplierEntry({ supplierId: supplier.id, kind: "PURCHASE", amount: 900, invoiceId: invoice.id, occurredAt: now() });
    await store.insertSupplierEntry({ supplierId: supplier.id, kind: "PAYMENT", amount: 300, invoiceId: invoice.id, method: "CASH", occurredAt: now() });
    await store.applyPaymentToInvoice(invoice.id, 300);
    // an invoice-linked purchase return reduces the debt but is NOT paid money
    await store.insertSupplierEntry({ supplierId: supplier.id, kind: "RETURN", amount: 200, invoiceId: invoice.id, occurredAt: now() });
    const { id: returnId } = await store.insertSupplierReturn({
      returnNumber: "PRT-0002",
      supplierId: supplier.id,
      invoiceId: invoice.id,
      kind: "INVOICE_LINKED",
      amount: 200,
      debtReduction: 200,
      credit: 0,
      cashBack: 0,
      reason: null,
      occurredAt: now(),
    });
    expect(returnId).toBeTruthy();
    expect(await store.applyDebtOffsetToInvoice(invoice.id, 200)).toBe(true);

    const detail = await store.getInvoiceDetail(invoice.id);
    const entries = await store.listSupplierEntries(supplier.id);
    // SAFETY: the invoice was just read in this test and cannot vanish
    const derived = deriveInvoicePaid(entries, invoice.id, detail!.totalAmount);
    expect(detail?.paidAmount).toBe(derived);
    expect(detail?.returnCreditAmount).toBe(200);
    // the printed header reconciles: total − paid − returnCredit = remaining
    expect(detail?.remainingAmount).toBe(detail!.totalAmount - derived - detail!.returnCreditAmount);
  });

  it("includes the signed account on a supplier party detail", async () => {
    const supplier = await makeSupplier("مورد تفاصيل");
    await store.insertSupplierEntry({ supplierId: supplier.id, kind: "PURCHASE", amount: 250, invoiceId: null, occurredAt: now() });
    await store.insertSupplierEntry({ supplierId: supplier.id, kind: "PAYMENT", amount: 300, invoiceId: null, occurredAt: now() });
    const detail = await store.partyDetail("supplier", supplier.id);
    expect(detail?.account?.balance).toBe(-50);
    expect(detail?.account?.entries).toHaveLength(2);
    // customers keep invoice-based debt: no account
    const customer = await store.createParty("customer", { name: "زبون" });
    expect((await store.partyDetail("customer", customer.id))?.account).toBeNull();
  });

  it("moves the balance with an account-only adjustment and leaves invoices alone (issue 176)", async () => {
    const supplier = await makeSupplier("مورد تسوية رصيد");
    const invoice = await makePurchase(supplier.id, 900);
    await store.insertSupplierEntry({ supplierId: supplier.id, kind: "PURCHASE", amount: 900, invoiceId: invoice.id, occurredAt: now() });
    const before = await store.getInvoiceDetail(invoice.id);

    await store.insertSupplierEntry({ supplierId: supplier.id, kind: "ADJUSTMENT", direction: "WE_OWE", amount: 800, invoiceId: null, note: "رصيد افتتاحي", occurredAt: now() });
    await store.insertSupplierEntry({ supplierId: supplier.id, kind: "ADJUSTMENT", direction: "THEY_OWE", amount: 300, invoiceId: null, note: "تصحيح", occurredAt: now() });

    const entries = await store.listSupplierEntries(supplier.id);
    expect(supplierBalance(entries)).toBe(900 + 800 - 300);
    // both directions persisted, independent of the list's ordering
    expect(entries.filter((entry) => entry.kind === "ADJUSTMENT").map((entry) => entry.direction).sort()).toEqual(["THEY_OWE", "WE_OWE"]);

    // account-only: paid/remaining/credit are exactly as before
    const after = await store.getInvoiceDetail(invoice.id);
    expect(after?.paidAmount).toBe(before?.paidAmount);
    expect(after?.remainingAmount).toBe(before?.remainingAmount);
    expect(after?.returnCreditAmount).toBe(0);
  });

  it("reduces a linked invoice's remaining with an adjustment and surfaces it in the header (issue 176)", async () => {
    const supplier = await makeSupplier("مورد تسوية خصم");
    const invoice = await makePurchase(supplier.id, 5000);
    await store.insertSupplierEntry({ supplierId: supplier.id, kind: "PURCHASE", amount: 5000, invoiceId: invoice.id, occurredAt: now() });
    // #177 — the guarded path applies the reduction with the entry in one unit;
    // the raw insertSupplierEntry now refuses a linked ADJUSTMENT.
    await store.withTransactionImmediate(async (tx) => {
      await tx.insertSupplierAdjustment({ supplierId: supplier.id, direction: "THEY_OWE", amount: 500, invoiceId: invoice.id, reason: "خصم", occurredAt: now() });
    });

    const detail = await store.getInvoiceDetail(invoice.id);
    expect(detail?.remainingAmount).toBe(4500);
    expect(detail?.paidAmount).toBe(0);
    expect(detail?.returnCreditAmount).toBe(500);
    expect(detail?.remainingAmount).toBe(detail!.totalAmount - detail!.paidAmount - detail!.returnCreditAmount);

    const entries = await store.listSupplierEntries(supplier.id);
    expect(supplierBalance(entries)).toBe(4500);
  });

  it("refuses a linked reduction above the remaining at the conditional UPDATE (issue 176)", async () => {
    const supplier = await makeSupplier("مورد تسوية زائدة");
    const invoice = await makePurchase(supplier.id, 1000);
    expect(await store.applyDebtOffsetToInvoice(invoice.id, 1001)).toBe(false);
    expect((await store.getInvoiceDetail(invoice.id))?.remainingAmount).toBe(1000);
  });

  it("lists a supplier's signed balance and entry count, and a customer's nulls (issue 176)", async () => {
    const supplier = await makeSupplier("مورد قائمة رصيد");
    await store.insertSupplierEntry({ supplierId: supplier.id, kind: "ADJUSTMENT", direction: "WE_OWE", amount: 700, invoiceId: null, occurredAt: now() });
    const supplierRow = (await store.listParties("supplier")).find((row) => row.id === supplier.id);
    expect(supplierRow?.accountBalance).toBe(700);
    expect(supplierRow?.accountEntryCount).toBe(1);

    const customer = await store.createParty("customer", { name: "زبون قائمة" });
    const customerRow = (await store.listParties("customer")).find((row) => row.id === customer.id);
    expect(customerRow?.accountBalance).toBeNull();
    expect(customerRow?.accountEntryCount).toBeNull();
  });

  it("agrees with the debts summary balance after a WE_OWE adjustment (issue 176)", async () => {
    const supplier = await makeSupplier("مورد ديون تسوية");
    const invoice = await makePurchase(supplier.id, 1000);
    await store.insertSupplierEntry({ supplierId: supplier.id, kind: "PURCHASE", amount: 1000, invoiceId: invoice.id, occurredAt: now() });
    await store.insertSupplierEntry({ supplierId: supplier.id, kind: "ADJUSTMENT", direction: "WE_OWE", amount: 250, invoiceId: null, occurredAt: now() });

    const entries = await store.listSupplierEntries(supplier.id);
    const row = (await store.debtSummaries()).find((summary) => summary.counterpartyId === supplier.id && summary.kind === "PURCHASE");
    expect(row?.accountBalance).toBe(supplierBalance(entries));
    expect(row?.accountBalance).toBe(1250);
  });

  it("reports a credit balance as a negative signed value in the party list (issue 176)", async () => {
    const supplier = await makeSupplier("مورد رصيد سالب");
    await store.insertSupplierEntry({ supplierId: supplier.id, kind: "ADJUSTMENT", direction: "THEY_OWE", amount: 300, invoiceId: null, occurredAt: now() });

    const row = (await store.listParties("supplier")).find((party) => party.id === supplier.id);
    expect(row?.accountBalance).toBe(-300);
    expect(row?.accountEntryCount).toBe(1);
    // the SQL sign expression agrees with the pure signer on the THEY_OWE branch
    expect(row?.accountBalance).toBe(supplierBalance(await store.listSupplierEntries(supplier.id)));

    // the debts summary agrees with the same sign on the THEY_OWE branch
    const summary = (await store.debtSummaries()).find((entry) => entry.counterpartyId === supplier.id && entry.kind === "PURCHASE");
    expect(summary?.accountBalance).toBe(-300);
  });

  it("refuses to persist an ADJUSTMENT with no direction (issue 176)", async () => {
    const supplier = await makeSupplier("مورد بلا اتجاه");
    await expect(
      store.insertSupplierEntry({ supplierId: supplier.id, kind: "ADJUSTMENT", amount: 100, invoiceId: null, occurredAt: now() }),
    ).rejects.toThrow(/direction/);
    expect(await store.listSupplierEntries(supplier.id)).toHaveLength(0);
  });

  it("refuses a linked ADJUSTMENT through the raw entry seam (issue 177)", async () => {
    // the raw seam must not let a caller write the entry without the invoice
    // reduction; the guarded adjustment path is the only way in
    const supplier = await makeSupplier("مورد مسار رابط");
    const invoice = await makePurchase(supplier.id, 1000);
    await expect(
      store.insertSupplierEntry({ supplierId: supplier.id, kind: "ADJUSTMENT", direction: "THEY_OWE", amount: 100, invoiceId: invoice.id, occurredAt: now() }),
    ).rejects.toThrow(/LINKED_NEEDS_ATOMIC_PATH/);
    expect((await store.listSupplierEntries(supplier.id)).filter((entry) => entry.kind === "ADJUSTMENT")).toHaveLength(0);
    expect((await store.getInvoiceDetail(invoice.id))?.remainingAmount).toBe(1000);
  });

  it("writes an account-only adjustment with a null invoice and touches no invoice (issue 177)", async () => {
    const supplier = await makeSupplier("مورد حساب فقط");
    const invoice = await makePurchase(supplier.id, 1000);
    await store.withTransactionImmediate(async (tx) => {
      await tx.insertSupplierAdjustment({ supplierId: supplier.id, direction: "THEY_OWE", amount: 300, reason: "تصحيح", occurredAt: now(), invoiceId: null });
    });
    const detail = await store.getInvoiceDetail(invoice.id);
    expect(detail?.remainingAmount).toBe(1000);
    expect(detail?.returnCreditAmount).toBe(0);
    const entry = (await store.listSupplierEntries(supplier.id)).find((row) => row.kind === "ADJUSTMENT");
    expect(entry?.invoiceId).toBeNull();
  });

  it("refuses a duplicate adjustment signature at the store seam (issue 177)", async () => {
    const supplier = await makeSupplier("مورد تكرار مخزن");
    const signature = { supplierId: supplier.id, direction: "WE_OWE" as const, amount: 100, reason: "رصيد", occurredAt: "2026-10-13T12:00:00", invoiceId: null };
    await store.withTransactionImmediate(async (tx) => {
      await tx.insertSupplierAdjustment(signature);
    });
    await expect(
      store.withTransactionImmediate(async (tx) => {
        await tx.insertSupplierAdjustment(signature);
      }),
    ).rejects.toThrow(/DUPLICATE/);
    expect((await store.listSupplierEntries(supplier.id)).filter((entry) => entry.kind === "ADJUSTMENT")).toHaveLength(1);
  });

  it("reports whether an adjustment signature already exists (issue 177)", async () => {
    const supplier = await makeSupplier("مورد توقيع مخزن");
    const signature = { supplierId: supplier.id, direction: "WE_OWE" as const, amount: 250, reason: "رصيد", occurredAt: "2026-10-13T12:00:00", invoiceId: null };
    expect(await store.hasSupplierAdjustment(signature)).toBe(false);
    await store.withTransactionImmediate(async (tx) => {
      await tx.insertSupplierAdjustment(signature);
    });
    expect(await store.hasSupplierAdjustment(signature)).toBe(true);
    // a different amount, direction, or reason is a different signature
    expect(await store.hasSupplierAdjustment({ ...signature, amount: 251 })).toBe(false);
    expect(await store.hasSupplierAdjustment({ ...signature, direction: "THEY_OWE" })).toBe(false);
    expect(await store.hasSupplierAdjustment({ ...signature, reason: "تصحيح" })).toBe(false);
  });

  it("keeps the linked and server-stamped dimensions of the adjustment signature distinct (issue 177)", async () => {
    const supplier = await makeSupplier("مورد توقيع أبعاد");
    const invoice = await makePurchase(supplier.id, 1000);
    const occurredAt = "2026-10-13T12:00:00";
    await store.withTransactionImmediate(async (tx) => {
      await tx.insertSupplierAdjustment({ supplierId: supplier.id, direction: "THEY_OWE", amount: 200, reason: "تصحيح", occurredAt, invoiceId: null });
      await tx.insertSupplierAdjustment({ supplierId: supplier.id, direction: "THEY_OWE", amount: 200, reason: "تصحيح", occurredAt, invoiceId: invoice.id });
      await tx.insertSupplierAdjustment({ supplierId: supplier.id, direction: "WE_OWE", amount: 300, reason: "ختم", occurredAt, invoiceId: null, serverStamped: true });
    });
    // account-only and linked with the same shape are distinct signatures
    expect(await store.hasSupplierAdjustment({ supplierId: supplier.id, direction: "THEY_OWE", amount: 200, reason: "تصحيح", occurredAt, invoiceId: null })).toBe(true);
    expect(await store.hasSupplierAdjustment({ supplierId: supplier.id, direction: "THEY_OWE", amount: 200, reason: "تصحيح", occurredAt, invoiceId: invoice.id })).toBe(true);
    // a server-stamped signature matches at any time
    expect(await store.hasSupplierAdjustment({ supplierId: supplier.id, direction: "WE_OWE", amount: 300, reason: "ختم", occurredAt: "2099-01-01T00:00:00", invoiceId: null, serverStamped: true })).toBe(true);
    // the same query without serverStamped is a different signature
    expect(await store.hasSupplierAdjustment({ supplierId: supplier.id, direction: "WE_OWE", amount: 300, reason: "ختم", occurredAt: "2099-01-01T00:00:00", invoiceId: null })).toBe(false);
  });

  it("re-validates the amount so a non-contract caller cannot invert the reduction (issue 177)", async () => {
    const supplier = await makeSupplier("مورد مبلغ سالب");
    const base = { supplierId: supplier.id, direction: "THEY_OWE" as const, reason: null, occurredAt: "2026-10-13T12:00:00", invoiceId: null };
    for (const amount of [-5, 0, 1.5]) {
      await expect(
        store.withTransactionImmediate(async (tx) => {
          await tx.insertSupplierAdjustment({ ...base, amount });
        }),
      ).rejects.toThrow(/INVALID_AMOUNT/);
    }
    expect((await store.listSupplierEntries(supplier.id)).filter((entry) => entry.kind === "ADJUSTMENT")).toHaveLength(0);
  });

  it("refuses the guarded adjustment outside a write unit (issue 177)", async () => {
    const supplier = await makeSupplier("مورد خارج الوحدة");
    // a direct serialized call has no BEGIN IMMEDIATE: the duplicate check would
    // race and the entry could commit without its reduction, so it is refused
    await expect(
      store.insertSupplierAdjustment({ supplierId: supplier.id, direction: "WE_OWE", amount: 100, reason: null, occurredAt: now(), invoiceId: null }),
    ).rejects.toThrow(/OUTSIDE_TRANSACTION/);
    expect((await store.listSupplierEntries(supplier.id)).filter((entry) => entry.kind === "ADJUSTMENT")).toHaveLength(0);
  });

  it("treats an account-only and a linked adjustment with the same attributes as distinct (issue 177)", async () => {
    const supplier = await makeSupplier("مورد تمييز رابط");
    const invoice = await makePurchase(supplier.id, 1000);
    const occurredAt = "2026-10-13T12:00:00";
    await store.withTransactionImmediate(async (tx) => {
      await tx.insertSupplierAdjustment({ supplierId: supplier.id, direction: "THEY_OWE", amount: 200, reason: "تصحيح", occurredAt, invoiceId: null });
    });
    // the linked one is a different operation, not a duplicate of the account-only
    await store.withTransactionImmediate(async (tx) => {
      await tx.insertSupplierAdjustment({ supplierId: supplier.id, direction: "THEY_OWE", amount: 200, reason: "تصحيح", occurredAt, invoiceId: invoice.id });
    });
    expect((await store.getInvoiceDetail(invoice.id))?.remainingAmount).toBe(800);
  });

  it("refuses a linked نسالوه adjustment and an over-remaining linked one at the store backstop (issue 177)", async () => {
    const supplier = await makeSupplier("مورد خلفي");
    const invoice = await makePurchase(supplier.id, 1000);
    await expect(
      store.withTransactionImmediate(async (tx) => {
        await tx.insertSupplierAdjustment({ supplierId: supplier.id, direction: "WE_OWE", amount: 100, reason: null, occurredAt: now(), invoiceId: invoice.id });
      }),
    ).rejects.toThrow(/LINKED_DIRECTION/);
    await expect(
      store.withTransactionImmediate(async (tx) => {
        await tx.insertSupplierAdjustment({ supplierId: supplier.id, direction: "THEY_OWE", amount: 1001, reason: null, occurredAt: now(), invoiceId: invoice.id });
      }),
    ).rejects.toThrow(/EXCEEDS_REMAINING/);
    // neither attempt moved the invoice or wrote an entry
    expect((await store.getInvoiceDetail(invoice.id))?.remainingAmount).toBe(1000);
    expect((await store.listSupplierEntries(supplier.id)).filter((entry) => entry.kind === "ADJUSTMENT")).toHaveLength(0);
  });

  it("refuses a linked adjustment aimed at another supplier's invoice at the store backstop (issue 177)", async () => {
    const a = await makeSupplier("مورد خلفي أ");
    const b = await makeSupplier("مورد خلفي ب");
    const invoiceB = await makePurchase(b.id, 1000);
    await expect(
      store.withTransactionImmediate(async (tx) => {
        await tx.insertSupplierAdjustment({ supplierId: a.id, direction: "THEY_OWE", amount: 100, reason: null, occurredAt: now(), invoiceId: invoiceB.id });
      }),
    ).rejects.toThrow(/INVOICE_MISMATCH/);
    // neither the other supplier's invoice nor this supplier's account moved
    expect((await store.getInvoiceDetail(invoiceB.id))?.remainingAmount).toBe(1000);
    expect((await store.listSupplierEntries(a.id)).filter((entry) => entry.kind === "ADJUSTMENT")).toHaveLength(0);
  });

  it("accepts the same amount with a different reason as a distinct adjustment (issue 177)", async () => {
    const supplier = await makeSupplier("مورد أسباب");
    const occurredAt = "2026-10-13T12:00:00";
    const base = { supplierId: supplier.id, direction: "WE_OWE" as const, amount: 200, occurredAt, invoiceId: null };
    await store.withTransactionImmediate(async (tx) => {
      await tx.insertSupplierAdjustment({ ...base, reason: "دين قديم" });
      await tx.insertSupplierAdjustment({ ...base, reason: "تصحيح" });
    });
    expect((await store.listSupplierEntries(supplier.id)).filter((entry) => entry.kind === "ADJUSTMENT")).toHaveLength(2);
  });

  it("dedupes on an explicit idempotency key when the retry changes the timestamp (issue 181)", async () => {
    const supplier = await makeSupplier("مورد مفتاح");
    const base = { supplierId: supplier.id, direction: "WE_OWE" as const, amount: 400, reason: "دين قديم", invoiceId: null, idempotencyKey: "retry-1" };
    await store.withTransactionImmediate(async (tx) => {
      await tx.insertSupplierAdjustment({ ...base, occurredAt: "2026-10-13T12:00:00" });
    });
    // the whole point of the key: a fresh timestamp is still the same request
    await expect(
      store.withTransactionImmediate(async (tx) => {
        await tx.insertSupplierAdjustment({ ...base, occurredAt: "2026-10-14T09:30:00" });
      }),
    ).rejects.toThrow(/DUPLICATE/);
    expect((await store.listSupplierEntries(supplier.id)).filter((entry) => entry.kind === "ADJUSTMENT")).toHaveLength(1);
  });

  it("keeps the signature backstop in force for a keyed request (issue 181)", async () => {
    const supplier = await makeSupplier("مورد مفتاح وتوقيع");
    const occurredAt = "2026-10-13T12:00:00";
    const base = { supplierId: supplier.id, direction: "WE_OWE" as const, amount: 400, reason: "دين قديم", occurredAt, invoiceId: null };
    await store.withTransactionImmediate(async (tx) => {
      await tx.insertSupplierAdjustment(base);
    });
    // a fresh key with the same signature is still an identical repeat: the key
    // must not weaken the #177 signature rule
    await expect(
      store.withTransactionImmediate(async (tx) => {
        await tx.insertSupplierAdjustment({ ...base, idempotencyKey: "another-key" });
      }),
    ).rejects.toThrow(/DUPLICATE/);
    expect((await store.listSupplierEntries(supplier.id)).filter((entry) => entry.kind === "ADJUSTMENT")).toHaveLength(1);
  });

  it("lets a different key carry a genuinely different request (issue 181)", async () => {
    const supplier = await makeSupplier("مورد مفاتيح مختلفة");
    const occurredAt = "2026-10-13T12:00:00";
    const base = { supplierId: supplier.id, direction: "WE_OWE" as const, reason: null, occurredAt, invoiceId: null };
    await store.withTransactionImmediate(async (tx) => {
      await tx.insertSupplierAdjustment({ ...base, amount: 100, idempotencyKey: "key-a" });
      await tx.insertSupplierAdjustment({ ...base, amount: 200, idempotencyKey: "key-b" });
    });
    expect((await store.listSupplierEntries(supplier.id)).filter((entry) => entry.kind === "ADJUSTMENT")).toHaveLength(2);
  });

  it("stores the canonical dedup key on the row and the partial unique index on it (issue 181)", async () => {
    const supplier = await makeSupplier("مورد مفتاح مخزّن");
    const occurredAt = "2026-10-13T12:00:00";
    const signatureEntry = await store.withTransactionImmediate(async (tx) =>
      tx.insertSupplierAdjustment({ supplierId: supplier.id, direction: "WE_OWE", amount: 100, reason: null, occurredAt, invoiceId: null }),
    );
    const keyedEntry = await store.withTransactionImmediate(async (tx) =>
      tx.insertSupplierAdjustment({ supplierId: supplier.id, direction: "THEY_OWE", amount: 50, reason: null, occurredAt, invoiceId: null, idempotencyKey: "stored-key" }),
    );
    // SAFETY: the SELECT names dedup_key, so each row has that nullable column
    const stored = conn.raw
      .query("SELECT id, dedup_key AS dedupKey FROM supplier_account_entries WHERE id IN (?, ?)")
      .all(signatureEntry.id, keyedEntry.id) as Array<{ id: string; dedupKey: string | null }>;
    const byId = new Map(stored.map((row) => [row.id, row.dedupKey]));
    expect(byId.get(signatureEntry.id)).toBe(adjustmentDedupKey({ supplierId: supplier.id, direction: "WE_OWE", amount: 100, reason: null, occurredAt, invoiceId: null }));
    expect(byId.get(keyedEntry.id)).toBe(adjustmentDedupKey({ supplierId: supplier.id, direction: "THEY_OWE", amount: 50, reason: null, occurredAt, invoiceId: null, idempotencyKey: "stored-key" }));
    // SAFETY: PRAGMA index_list returns one object per index with these fields
    const indexes = conn.raw.query("PRAGMA index_list(supplier_account_entries)").all() as Array<{ name: string; unique: number; partial: number }>;
    expect(indexes.find((index) => index.name === "idx_supplier_entries_dedup")).toMatchObject({ unique: 1, partial: 1 });
  });

  it("keys an account-only adjustment written through the raw entry seam (issue 181)", async () => {
    const supplier = await makeSupplier("مورد خام مفتاح");
    const entry = { supplierId: supplier.id, kind: "ADJUSTMENT" as const, direction: "WE_OWE" as const, amount: 100, invoiceId: null, occurredAt: "2026-10-13T12:00:00" };
    const first = await store.insertSupplierEntry(entry);
    // the raw seam now carries the canonical key, so the DB index dedupes it too
    await expect(store.insertSupplierEntry(entry)).rejects.toThrow(/DUPLICATE/);
    // SAFETY: the SELECT names dedup_key, so the row has that nullable column
    const row = conn.raw.query("SELECT dedup_key AS dedupKey FROM supplier_account_entries WHERE id = ?").get(first.id) as { dedupKey: string | null };
    expect(row.dedupKey).not.toBeNull();
    expect((await store.listSupplierEntries(supplier.id)).filter((entry) => entry.kind === "ADJUSTMENT")).toHaveLength(1);
  });
});
