import { afterAll, describe, expect } from "bun:test";
import { itHeavy } from "../test-support/heavy";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ONBOARDING_COMPLETED_PREFERENCE_KEY } from "@dokan/contracts";

import { createAppConfig } from "../config";
import { openConnection, type Connection } from "../db/connection";
import { createDrizzleStore } from "./drizzle-store";
import type { StorePort } from "./port";

/**
 * onboardingProgress store seam (issue 97). The getting-started checklist's
 * completion must come from real records in one read: an item, a purchase, a
 * sale, and a party-attributed unpaid SALE debt — never a client-set flag.
 */

const tempDirs: string[] = [];
const conns: Connection[] = [];

function removeTempDirRetry(dir: string): void {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      Bun.sleepSync(50);
    }
  }
}

async function freshStore(): Promise<StorePort> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dokan-onboard-"));
  tempDirs.push(dir);
  const conn = openConnection(
    createAppConfig({ DOKAN_DATA_DIR: dir, DOKAN_DB_PATH: path.join(dir, "test.db") }),
  );
  conns.push(conn);
  const store = createDrizzleStore(conn);
  await store.setup();
  return store;
}

async function createItem(store: StorePort, name: string): Promise<void> {
  const categoryId = (await store.listCategories())[0]!.id;
  await store.createItem({ name, categoryId, costPrice: 100, sellingPrice: 150, lowStockThreshold: 5 });
}

async function seedInvoice(
  store: StorePort,
  over: {
    invoiceNumber: string;
    kind: "SALE" | "PURCHASE";
    totalAmount: number;
    paidAmount: number;
    remainingAmount: number;
    unnamed?: boolean;
    withId?: boolean;
  },
): Promise<void> {
  await store.insertInvoice({
    invoiceNumber: over.invoiceNumber,
    kind: over.kind,
    counterpartyId: over.withId === true ? crypto.randomUUID() : null,
    counterpartyName: over.unnamed === true ? null : "طرف",
    invoiceDate: "2026-08-31",
    subtotalAmount: over.totalAmount,
    discountType: null,
    discountValue: null,
    discountAmount: 0,
    totalAmount: over.totalAmount,
    paidAmount: over.paidAmount,
    remainingAmount: over.remainingAmount,
    notes: null,
  });
}

afterAll(() => {
  for (const conn of conns) conn.close();
  for (const dir of tempDirs) removeTempDirRetry(dir);
});

describe("onboardingProgress (issue 97)", () => {
  itHeavy("reports every step open on an empty store", async () => {
    const store = await freshStore();
    expect(await store.onboardingProgress()).toEqual({
      hasItems: false,
      hasPurchase: false,
      hasSale: false,
      hasDebt: false,
    });
  });

  itHeavy("marks items done from a real item and nothing else", async () => {
    const store = await freshStore();
    await createItem(store, "بطارية");
    expect(await store.onboardingProgress()).toEqual({
      hasItems: true,
      hasPurchase: false,
      hasSale: false,
      hasDebt: false,
    });
  });

  itHeavy("marks a purchase done independently of a sale", async () => {
    const store = await freshStore();
    await seedInvoice(store, { invoiceNumber: "ONB-P1", kind: "PURCHASE", totalAmount: 1000, paidAmount: 1000, remainingAmount: 0 });
    expect(await store.onboardingProgress()).toEqual({
      hasItems: false,
      hasPurchase: true,
      hasSale: false,
      hasDebt: false,
    });
  });

  itHeavy("marks a sale done independently of a purchase", async () => {
    const store = await freshStore();
    await seedInvoice(store, { invoiceNumber: "ONB-S1", kind: "SALE", totalAmount: 1000, paidAmount: 1000, remainingAmount: 0 });
    expect(await store.onboardingProgress()).toEqual({
      hasItems: false,
      hasPurchase: false,
      hasSale: true,
      hasDebt: false,
    });
  });

  itHeavy("marks the debt step done for a party-attributed unpaid sale", async () => {
    const store = await freshStore();
    await seedInvoice(store, { invoiceNumber: "ONB-S2", kind: "SALE", totalAmount: 2000, paidAmount: 500, remainingAmount: 1500 });
    expect(await store.onboardingProgress()).toEqual({
      hasItems: false,
      hasPurchase: false,
      hasSale: true,
      hasDebt: true,
    });
  });

  itHeavy("does not count a fully paid sale as debt", async () => {
    const store = await freshStore();
    await seedInvoice(store, { invoiceNumber: "ONB-S3", kind: "SALE", totalAmount: 1000, paidAmount: 1000, remainingAmount: 0 });
    expect((await store.onboardingProgress()).hasDebt).toBe(false);
  });

  itHeavy("does not count a party-less walk-in remainder as debt", async () => {
    const store = await freshStore();
    await seedInvoice(store, { invoiceNumber: "ONB-S4", kind: "SALE", totalAmount: 400, paidAmount: 0, remainingAmount: 400, unnamed: true });
    const progress = await store.onboardingProgress();
    expect(progress.hasSale).toBe(true);
    expect(progress.hasDebt).toBe(false);
  });

  itHeavy("does not count a purchase we owe as the debts step", async () => {
    const store = await freshStore();
    await seedInvoice(store, { invoiceNumber: "ONB-P3", kind: "PURCHASE", totalAmount: 900, paidAmount: 100, remainingAmount: 800 });
    const progress = await store.onboardingProgress();
    expect(progress.hasPurchase).toBe(true);
    // "who owes you" is a SALE debt; a supplier balance is not this step
    expect(progress.hasDebt).toBe(false);
  });

  itHeavy("counts a debt attributed by counterparty id, not only by typed name", async () => {
    const store = await freshStore();
    // id present, name absent: the identity branch the name-only tests miss
    await seedInvoice(store, {
      invoiceNumber: "ONB-S6",
      kind: "SALE",
      totalAmount: 800,
      paidAmount: 0,
      remainingAmount: 800,
      withId: true,
      unnamed: true,
    });
    expect((await store.onboardingProgress()).hasDebt).toBe(true);
  });

  itHeavy("reaches every step at once after the whole first-day flow", async () => {
    const store = await freshStore();
    await createItem(store, "بطارية");
    await seedInvoice(store, { invoiceNumber: "ONB-P2", kind: "PURCHASE", totalAmount: 500, paidAmount: 300, remainingAmount: 200 });
    await seedInvoice(store, { invoiceNumber: "ONB-S5", kind: "SALE", totalAmount: 900, paidAmount: 400, remainingAmount: 500 });
    expect(await store.onboardingProgress()).toEqual({
      hasItems: true,
      hasPurchase: true,
      hasSale: true,
      hasDebt: true,
    });
  });
});

describe("recordOnboardingCompletion (issue 97 follow-up)", () => {
  itHeavy("does not record the milestone while any record is missing", async () => {
    const store = await freshStore();
    await createItem(store, "بطارية");
    expect(await store.recordOnboardingCompletion()).toBe(false);
    expect(await store.getPreferences()).toEqual({});
  });

  itHeavy("records the milestone idempotently once every record exists", async () => {
    const store = await freshStore();
    await createItem(store, "بطارية");
    await seedInvoice(store, { invoiceNumber: "ONB-C1", kind: "PURCHASE", totalAmount: 500, paidAmount: 500, remainingAmount: 0 });
    await seedInvoice(store, { invoiceNumber: "ONB-C2", kind: "SALE", totalAmount: 900, paidAmount: 400, remainingAmount: 500 });

    expect(await store.recordOnboardingCompletion()).toBe(true);
    // a retry is safe and returns the same answer
    expect(await store.recordOnboardingCompletion()).toBe(true);
    expect((await store.getPreferences())[ONBOARDING_COMPLETED_PREFERENCE_KEY]).toBe("true");
  });

  itHeavy("composes the read and write without re-entering the store queue (issue #115)", async () => {
    const store = await freshStore();
    await createItem(store, "بطارية");
    await seedInvoice(store, { invoiceNumber: "ONB-C3", kind: "PURCHASE", totalAmount: 500, paidAmount: 500, remainingAmount: 0 });
    await seedInvoice(store, { invoiceNumber: "ONB-C4", kind: "SALE", totalAmount: 900, paidAmount: 400, remainingAmount: 500 });

    // `recordOnboardingCompletion` runs inside one serialized queue slot. If it
    // called the *wrapped* port methods again, the nested runSerialized would
    // wait on the job it is already inside: a self-deadlock on the single
    // connection. A bounded race turns that hang into a named failure instead
    // of a whole-file timeout. Mutation proof: revert to `this.onboardingProgress()`
    // / `this.setPreference()` and drop `.bind(raw)` from `serializeStore` →
    // this resolves as the timeout sentinel; the fixed code resolves boolean.
    const result = await Promise.race([
      store.recordOnboardingCompletion(),
      new Promise<"deadlock">((resolve) => setTimeout(() => resolve("deadlock"), 5_000)),
    ]);
    expect(result).toBe(true);
    expect((await store.getPreferences())[ONBOARDING_COMPLETED_PREFERENCE_KEY]).toBe("true");
  });
});
