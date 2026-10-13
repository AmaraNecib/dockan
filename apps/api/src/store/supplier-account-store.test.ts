import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createAppConfig } from "../config";
import { openConnection, type Connection } from "../db/connection";
import { localDate, localDateTime } from "../lib/logger";
import { deriveInvoicePaid, supplierBalance } from "../lib/supplier-ledger";
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
    expect(entries.find((entry) => entry.kind === "ADJUSTMENT")?.direction).toBe("THEY_OWE");

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
    await store.insertSupplierEntry({ supplierId: supplier.id, kind: "ADJUSTMENT", direction: "THEY_OWE", amount: 500, invoiceId: invoice.id, note: "خصم", occurredAt: now() });
    expect(await store.applyDebtOffsetToInvoice(invoice.id, 500)).toBe(true);

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
});
