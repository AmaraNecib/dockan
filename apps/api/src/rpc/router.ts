import { implement, ORPCError } from "@orpc/server";
import { dokanContract, type InvoiceDetail, type InvoiceLine } from "@dokan/contracts";

import type { AppConfig } from "../config";
import { normalizeBarcode } from "@dokan/contracts";
import { rankCatalog } from "../lib/catalog-search";
import type { DrizzleDb } from "../db/connection";
import type { AppLogger } from "../lib/logger";
import type { StorePort } from "../store/port";
import type { BetterAuthInstance } from "../auth/auth";
import { resetAdminPassword } from "../auth/admin";
import { AppError } from "../lib/errors";
import { fifoCostForOutflow, historyWithRemaining, projectLedger, StockLedgerError, weightedAverageCost } from "../lib/stock-ledger";
import { calculateSaleTotals } from "../lib/sale-calculations";
import { createBackup } from "../lib/backups";
import { localDate, localDateTime } from "../lib/logger";

export type RpcContext = { request: Request };

type RpcDeps = {
  db: DrizzleDb;
  config: AppConfig;
  logger: AppLogger;
  store: StorePort;
  auth: BetterAuthInstance;
};

/** reason prefix burned into purchase-line corrections; the line id rides as
 * a #suffix so N corrections of one line reverse the PREVIOUS effective
 * quantity instead of re-reversing the untouched original */
const CORRECTION_REASON_PREFIX = "تصحيح فاتورة";

/** total invoiced quantity per item across a detail's lines (description-only
 * lines carry no item and are skipped) */
function aggregateLineQuantities(lines: readonly InvoiceLine[]): Map<string, number> {
  const totals = new Map<string, number>();
  for (const line of lines) {
    if (line.itemId === null) continue;
    totals.set(line.itemId, (totals.get(line.itemId) ?? 0) + line.quantity);
  }
  return totals;
}

/** uninvoiced availability for one item: Σ PURCHASE movements with ref=null,
 * minus quantities already attributed by stock_links — walked oldest-first in
 * the ledger's canonical ordering so consumption matches FIFO. One spelling
 * of "oldest first", shared with projectLedger via listStockMovements order. */
async function uninvoicedAvailability(store: StorePort, itemId: string): Promise<number> {
  const movements = await store.listStockMovements(itemId);
  const consumed = new Map<string, number>();
  for (const link of await store.listStockLinksByItem(itemId)) {
    consumed.set(link.movementId, (consumed.get(link.movementId) ?? 0) + link.quantity);
  }
  let available = 0;
  for (const movement of movements) {
    if (movement.kind !== "PURCHASE" || movement.ref !== null) continue;
    available += Math.max(0, movement.delta - (consumed.get(movement.id) ?? 0));
  }
  return available;
}

/** how much of one item's line this invoice has ALREADY attributed via
 * stock_links (pure attribution rows — no movement creation happens in
 * linking). Capping re-links at (line − already) keeps repeated calls from
 * attributing more than the line claims. */
async function alreadyAttributed(store: StorePort, invoiceId: string, itemId: string): Promise<number> {
  let total = 0;
  for (const link of await store.listStockLinksByItem(itemId)) {
    if (link.invoiceId === invoiceId) total += link.quantity;
  }
  return total;
}

/**
 * The merged Dokan router: ticket 02 owns auth (build-secret reset, session
 * guard), ticket 03 owns categories/items procedures. Every business procedure
 * passes requireSession; error texts are stable keys the ui translates.
 */
export function createRpcRouter(deps: RpcDeps) {
  const os = implement(dokanContract).$context<RpcContext>();

  const requireSession = async (context: RpcContext) => {
    // SAFETY: getSession validates the cookie against the session store and
    // returns null for anything missing or expired
    const session = await deps.auth.api.getSession({ headers: context.request.headers });
    if (session === null) throw new ORPCError("UNAUTHORIZED", { message: "AUTH_REQUIRED" });
    // single-admin boundary: only the provisioned identity may call the store.
    // Sign-up is blocked at the http layer; this check makes the guard immune
    // to any other path that could mint a session.
    const adminUserId = await deps.store.getSetting("adminUserId");
    if (adminUserId !== session.user.id) {
      throw new ORPCError("FORBIDDEN", { message: "FORBIDDEN" });
    }
    return session;
  };

  const guarded = <T>(handler: (context: RpcContext) => Promise<T>) => async ({ context }: { context: RpcContext }): Promise<T> => {
    await requireSession(context);
    return handler(context);
  };

  /** Like guarded, but passes the procedure input through as well. */
  const guardedInput = <T, I>(handler: (input: I, context: RpcContext) => Promise<T>) => async ({
    input,
    context,
  }: { input: I; context: RpcContext }): Promise<T> => {
    await requireSession(context);
    return handler(input, context);
  };

  const notImplemented = (name: string) => async (): Promise<never> => {
    deps.logger.warn("NOT_IMPLEMENTED", `procedure ${name} not implemented yet`);
    throw new ORPCError("INTERNAL_SERVER_ERROR", { message: `${name} is not implemented yet` });
  };

  return {
    health: os.health.handler(() => ({ ok: true as const, version: deps.config.version })),

    // --- auth ----------------------------------------------------------------
    authResetPassword: os.authResetPassword.handler(async ({ input }) => {
      try {
        return await resetAdminPassword(
          { db: deps.db, auth: deps.auth, store: deps.store, config: deps.config, logger: deps.logger },
          input,
        );
      } catch (err) {
        // AppError carries a stable key; surface it so the ui can translate it
        if (err instanceof AppError) {
          throw new ORPCError(err.code === "WRONG_BUILD_SECRET" ? "FORBIDDEN" : "BAD_REQUEST", { message: err.code });
        }
        throw err;
      }
    }),

    // --- categories (ticket 03) ----------------------------------------------
    categoriesList: os.categoriesList.handler(guarded(async () => ({ items: await deps.store.listCategories() }))),
    categoriesCreate: os.categoriesCreate.handler(
      guardedInput(async (input) => {
        // duplicate check lives INSIDE the serialized unit; concurrent creates
        // for the same name serialize, and the UNIQUE constraint catch below
        // translates the race into the same CONFLICT response
        try {
          return await deps.store.withTransaction(async (tx) => {
            const existing = await tx.listCategories();
            if (existing.some((c) => c.name === input.name)) {
              throw new ORPCError("CONFLICT", { message: "CATEGORY_EXISTS" });
            }
            const category = await tx.createCategory({ name: input.name });
            await tx.insertActivity({ type: "CATEGORY_CREATED", summary: `إنشاء تصنيف ${input.name}` });
            return category;
          });
        } catch (err) {
          if (err instanceof Error && isUniqueViolation(err)) {
            throw new ORPCError("CONFLICT", { message: "CATEGORY_EXISTS" });
          }
          throw err;
        }
      }),
    ),

    // --- items (ticket 03) ---------------------------------------------------
    itemsList: os.itemsList.handler(guarded(async () => ({ items: await deps.store.listItems() }))),
    itemsCreate: os.itemsCreate.handler(
      guardedInput(async (input) => {
        const categories = await deps.store.listCategories();
        if (!categories.some((c) => c.id === input.categoryId)) {
          throw new ORPCError("BAD_REQUEST", { message: "CATEGORY_NOT_FOUND" });
        }
        const barcode = requireBarcode(input.barcode);
        // item + audit entry commit in the same transaction; a barcode race
        // serializes through the UNIQUE index and maps to the same CONFLICT
        return withBarcodeConflict(async () => {
          return deps.store.withTransaction(async (tx) => {
            const item = await tx.createItem({ ...input, barcode });
            await tx.insertActivity({ type: "ITEM_CREATED", summary: `إنشاء منتج ${input.name}`, ref: item.id });
            return item;
          });
        });
      }),
    ),
    // unknown-scan "create with stock": item + initial stock in one unit,
    // through the same setItemStockAndCost seam the invoice flows will use
    itemsCreateWithStock: os.itemsCreateWithStock.handler(
      guardedInput(async (input) => {
        const categories = await deps.store.listCategories();
        if (!categories.some((c) => c.id === input.categoryId)) {
          throw new ORPCError("BAD_REQUEST", { message: "CATEGORY_NOT_FOUND" });
        }
        const barcode = requireBarcode(input.barcode);
        return withBarcodeConflict(() =>
          deps.store.withTransaction(async (tx) => {
            const item = await tx.createItem({ ...input, barcode });
            // Initial stock is a real ledger fact, not only a cache update;
            // otherwise a subsequent sale would see an empty FIFO history.
            await tx.insertStockMovement({
              itemId: item.id,
              kind: "MANUAL_ADJUSTMENT",
              delta: input.stockOnHand,
              unitCost: input.costPrice,
              reason: "opening",
              ref: null,
              occurredAt: item.createdAt,
            });
            await tx.setItemStockAndCost(item.id, input.stockOnHand, input.costPrice);
            await tx.insertActivity({
              type: "ITEM_CREATED",
              summary: `إنشاء منتج ${input.name} بمخزون أولي ${input.stockOnHand}`,
              ref: item.id,
            });
            return { ...item, stockOnHand: input.stockOnHand };
          }),
        );
      }),
    ),
    itemsUpdate: os.itemsUpdate.handler(
      guardedInput(async (input) => {
        // item + audit entry commit in the same transaction; a moved item must
        // point at a real category, like create does (FK errors are not 500s)
        return withBarcodeConflict(() =>
          deps.store.withTransaction(async (tx) => {
            if (input.categoryId !== undefined) {
              const categories = await tx.listCategories();
              if (!categories.some((category) => category.id === input.categoryId)) {
                throw new ORPCError("BAD_REQUEST", { message: "CATEGORY_NOT_FOUND" });
              }
            }
            const item = await tx.updateItem(input.id, {
              ...input,
              barcode: input.barcode === null ? null : requireBarcode(input.barcode),
            });
            if (item === undefined) {
              throw new ORPCError("NOT_FOUND", { message: "ITEM_NOT_FOUND" });
            }
            await tx.insertActivity({ type: "ITEM_UPDATED", summary: `تعديل منتج ${item.name}`, ref: item.id });
            return item;
          }),
        );
      }),
    ),
    itemsLowStock: os.itemsLowStock.handler(guarded(async () => ({ items: await deps.store.listLowStockItems() }))),

    // --- catalog search + scanning (ticket 28) --------------------------------
    catalogSearch: os.catalogSearch.handler(
      guardedInput(async ({ query, limit }) => {
        const [items, categories] = await Promise.all([deps.store.listItems(), deps.store.listCategories()]);
        return rankCatalog(items, categories, query, limit);
      }),
    ),

    // --- stock ledger (ticket 27) ----------------------------------------------
    stockAddManual: os.stockAddManual.handler(
      guardedInput(async (input) => {
        if (input.kind === "PURCHASE" && input.delta <= 0) {
          throw new ORPCError("BAD_REQUEST", { message: "PURCHASE_REQUIRES_INFLOW" });
        }
        return deps.store.withTransaction(async (tx) => {
          const item = (await tx.getItemsByIds([input.itemId])).get(input.itemId);
          if (item === undefined) {
            throw new ORPCError("BAD_REQUEST", { message: "ITEM_NOT_FOUND" });
          }
          // inflows default to the item's current cost; outflows carry no
          // unit cost — storing one would be a misleading "fact"
          const unitCost = input.delta > 0 ? (input.unitCost ?? item.costPrice) : null;

          // validate the WHOLE projected history incl. the candidate row —
          // negative stock is rejected before anything is written
          const existing = await tx.listStockMovements(item.id);
          const candidate = {
            kind: input.kind,
            delta: input.delta,
            unitCost,
            occurredAt: input.occurredAt ?? localDateTime(),
            seq: undefined,
          };
          let stockAfter: number;
          try {
            stockAfter = projectLedger([...existing, candidate]).stockOnHand;
          } catch (err) {
            if (err instanceof StockLedgerError) {
              throw new ORPCError("BAD_REQUEST", { message: err.code });
            }
            throw err;
          }

          const movement = await tx.insertStockMovement({
            itemId: item.id,
            kind: candidate.kind,
            delta: input.delta,
            unitCost,
            reason: input.reason ?? null,
            ref: null,
            occurredAt: candidate.occurredAt,
          });

          // keep the fast path in sync. cost_price is the ADR-0002 running
          // weighted average, so after ANY write — including a backdated one
          // — we recompute it by replaying the full ledger chronologically
          // (inflows blend, outflows only reduce quantity). No special-casing
          // per insertion position; the model stays uniform.
          const newCost =
            input.delta > 0 ? weightedAverageCost([...existing, candidate]) : item.costPrice;
          await tx.setItemStockAndCost(item.id, stockAfter, newCost);
          await tx.insertActivity({ type: "STOCK_ADJUSTED", summary: `تسوية مخزون ${item.name}`, ref: item.id });
          return movement;
        });
      }),
    ),

    itemsHistory: os.itemsHistory.handler(
      guardedInput(async (input) => {
        const item = (await deps.store.getItemsByIds([input.itemId])).get(input.itemId);
        if (item === undefined) {
          throw new ORPCError("NOT_FOUND", { message: "ITEM_NOT_FOUND" });
        }
        const movements = await deps.store.listStockMovements(item.id);
        const rows = historyWithRemaining(movements).map(({ seq: _seq, ...rest }) => rest);
        const { stockOnHand } = projectLedger(movements, { fallbackUnitCost: item.costPrice });
        return { movements: rows, stockOnHand };
      }),
    ),

    // --- invoices (ticket 29: PURCHASE; ticket #30: SALE) ---------------------
    invoicesCreate: os.invoicesCreate.handler(
      guardedInput(async (input) => {
        // Resolve items and persist inside ONE serialized unit so pricing,
        // FIFO consumption, and writes all observe the same committed state.
        // Reading item snapshots before the transaction let a queued request
        // (e.g. an updateItem price change) land between the read and the
        // unit, persisting stale unitPrice/costAtSale (greptile P1). Bad ids
        // still fail before any invoice, movement, or sequence write because
        // resolution is the first thing inside the unit.
        return deps.store.withTransaction(async (tx) => {
        const itemsById = await tx.getItemsByIds(input.lines.map((line) => line.itemId));
        for (const line of input.lines) {
          if (!itemsById.has(line.itemId)) throw new ORPCError("BAD_REQUEST", { message: "ITEM_NOT_FOUND" });
        }

        if (input.kind === "SALE") {
          const discount = input.discount ??
            (input.discountType !== undefined && input.discountValue !== undefined
              ? { type: input.discountType, value: input.discountValue }
              : undefined);
          const totals = calculateSaleTotals(
            input.lines.map((line) => {
              const item = itemsById.get(line.itemId)!;
              return {
                quantity: line.quantity,
                price: {
                  defaultUnitPrice: item.sellingPrice,
                  unitPrice: line.unitPrice,
                  priceOverride: line.priceOverride,
                  priceOverrideType: line.priceOverrideType,
                  priceOverrideValue: line.priceOverrideValue,
                },
              };
            }),
            discount,
          );
          const paidAmount = input.initialPaid ?? 0;
          if (paidAmount > totals.totalAmount) throw new ORPCError("BAD_REQUEST", { message: "PAID_EXCEEDS_TOTAL" });
          const invoiceDate = input.invoiceDate ?? localDate();
          // SAFETY: allocation is a database-atomic UPDATE inside the same
          // transaction as the invoice insert, so separate app processes
          // cannot select the same INV-#### between a read and the insert.
          const invoiceNumber = await tx.allocateInvoiceNumber();
            const invoice = await tx.insertInvoice({
              invoiceNumber,
              kind: "SALE",
              counterpartyId: input.counterpartyId ?? null,
              counterpartyName: input.counterpartyName ?? null,
              invoiceDate,
              subtotalAmount: totals.subtotalAmount,
              discountType: totals.discountType,
              discountValue: totals.discountValue,
              discountAmount: totals.discountAmount,
              totalAmount: totals.totalAmount,
              paidAmount,
              remainingAmount: totals.totalAmount - paidAmount,
              notes: input.notes ?? null,
            });
            const insertedLines: InvoiceDetail["lines"] = [];
            for (const [index, line] of input.lines.entries()) {
              // SAFETY: every itemId was resolved in itemsById at the start of
              // this unit, and the map is immutable while it runs.
              const item = itemsById.get(line.itemId)!;
              const calculated = totals.lines[index]!;
              const existing = await tx.listStockMovements(item.id);
              const occurredAt = localDateTime();
              const candidate = {
                kind: "SALE" as const,
                delta: -line.quantity,
                unitCost: null,
                occurredAt,
                seq: undefined,
              };
              let costAtSale: number;
              try {
                costAtSale = fifoCostForOutflow(existing, line.quantity, { fallbackUnitCost: item.costPrice });
                projectLedger([...existing, candidate]);
              } catch (err) {
                if (err instanceof StockLedgerError) throw new ORPCError("BAD_REQUEST", { message: err.code });
                throw err;
              }
              const inserted = await tx.insertInvoiceLine({
                invoiceId: invoice.id,
                itemId: item.id,
                description: item.name,
                quantity: line.quantity,
                defaultUnitPrice: item.sellingPrice,
                unitPrice: calculated.unitPrice,
                costAtSale,
                total: calculated.grossTotal,
                discountAllocated: calculated.discountAllocated,
                netTotal: calculated.netTotal,
              });
              insertedLines.push(inserted);
              await tx.insertStockMovement({
                itemId: item.id,
                kind: "SALE",
                delta: -line.quantity,
                unitCost: null,
                reason: null,
                ref: invoice.id,
                occurredAt,
              });
              const projected = projectLedger([...existing, candidate], { fallbackUnitCost: item.costPrice });
              const newCost = weightedAverageCost([...existing, candidate], { fallbackUnitCost: item.costPrice });
              await tx.setItemStockAndCost(item.id, projected.stockOnHand, newCost);
            }
            const insertedPayments: InvoiceDetail["payments"] = [];
            if (paidAmount > 0) {
              insertedPayments.push(
                await tx.insertPayment({
                  invoiceId: invoice.id,
                  amount: paidAmount,
                  method: input.paymentMethod ?? "CASH",
                  note: null,
                  paidAt: localDateTime(),
                }),
              );
            }
            await tx.insertActivity({ type: "SALE_CREATED", summary: `فاتورة بيع ${invoiceNumber}`, ref: invoice.id });
            return { ...invoice, lines: insertedLines, payments: insertedPayments } satisfies InvoiceDetail;
        }

        if (input.discount !== undefined || input.discountType !== undefined || input.discountValue !== undefined) {
          throw new ORPCError("BAD_REQUEST", { message: "DISCOUNT_ONLY_SALE" });
        }
        // Existing purchase intake behavior: omitted line prices default to the
        // item's cost because purchase prices are the stock cost basis.
        const totalAmount = input.lines.reduce((sum, line) => sum + line.quantity * (line.unitPrice ?? itemsById.get(line.itemId)!.costPrice), 0);
        const paidAmount = input.initialPaid ?? 0;
        if (paidAmount > totalAmount) throw new ORPCError("BAD_REQUEST", { message: "PAID_EXCEEDS_TOTAL" });
        const invoiceDate = input.invoiceDate ?? localDate();
          // SAFETY: allocation is a database-atomic UPDATE inside the same
          // transaction as the invoice insert, so separate app processes
          // cannot select the same INV-#### between a read and the insert.
          const invoiceNumber = await tx.allocateInvoiceNumber();
          const invoice = await tx.insertInvoice({
            invoiceNumber,
            kind: "PURCHASE",
            counterpartyId: input.counterpartyId ?? null,
            counterpartyName: input.counterpartyName ?? null,
            invoiceDate,
            subtotalAmount: totalAmount,
            discountType: null,
            discountValue: null,
            discountAmount: 0,
            totalAmount,
            paidAmount,
            remainingAmount: totalAmount - paidAmount,
            notes: input.notes ?? null,
          });
          const insertedLines: InvoiceDetail["lines"] = [];
          for (const line of input.lines) {
            // SAFETY: every itemId was resolved in itemsById at the start of
            // this unit, and the map is immutable while it runs.
            const item = itemsById.get(line.itemId)!;
            const unitCost = line.unitPrice ?? item.costPrice;
            // For PURCHASE, the line price is the cost basis feeding ADR-0002.
            const inserted = await tx.insertInvoiceLine({
              invoiceId: invoice.id,
              itemId: line.itemId,
              description: item.name,
              quantity: line.quantity,
              defaultUnitPrice: item.costPrice,
              unitPrice: unitCost,
              costAtSale: unitCost,
              total: line.quantity * unitCost,
              discountAllocated: 0,
              netTotal: line.quantity * unitCost,
            });
            insertedLines.push(inserted);
            const existing = await tx.listStockMovements(line.itemId);
            const candidate = { kind: "PURCHASE" as const, delta: line.quantity, unitCost, occurredAt: localDateTime(), seq: undefined };
            let stockAfter: number;
            try {
              stockAfter = projectLedger([...existing, candidate]).stockOnHand;
            } catch (err) {
              if (err instanceof StockLedgerError) throw new ORPCError("BAD_REQUEST", { message: err.code });
              throw err;
            }
            await tx.insertStockMovement({ itemId: line.itemId, kind: "PURCHASE", delta: line.quantity, unitCost, reason: null, ref: invoice.id, occurredAt: candidate.occurredAt });
            const newCost = weightedAverageCost([...existing, candidate], { fallbackUnitCost: item.costPrice });
            await tx.setItemStockAndCost(line.itemId, stockAfter, newCost);
          }
          await tx.insertActivity({ type: "PURCHASE_CREATED", summary: `فاتورة شراء ${invoiceNumber} من ${input.counterpartyName ?? "مورد"}`, ref: invoice.id });
          return { ...invoice, lines: insertedLines, payments: [] } satisfies InvoiceDetail;
        });
      }),
    ),
    invoicesGet: os.invoicesGet.handler(
      guardedInput(async ({ id }) => {
        const detail = await deps.store.getInvoiceDetail(id);
        if (detail === undefined) {
          throw new ORPCError("NOT_FOUND", { message: "INVOICE_NOT_FOUND" });
        }
        return detail;
      }),
    ),
    invoicesList: os.invoicesList.handler(guardedInput(async (filters) => deps.store.listInvoices(filters))),
    invoicesPay: os.invoicesPay.handler(guarded(notImplemented("invoicesPay"))),

    // --- purchase intake: deferred linking + corrections (ticket 29) ----------
    purchasesProposal: os.purchasesProposal.handler(
      guardedInput(async ({ invoiceId }) => {
        const detail = await deps.store.getInvoiceDetail(invoiceId);
        if (detail === undefined || detail.kind !== "PURCHASE") {
          throw new ORPCError("NOT_FOUND", { message: "INVOICE_NOT_FOUND" });
        }
        const itemsById = await deps.store.getItemsByIds(detail.lines.filter((l) => l.itemId !== null).map((l) => l.itemId!));
        const quantitiesByItem = aggregateLineQuantities(detail.lines);
        const proposalRows = [];
        for (const [itemId, lineQuantity] of quantitiesByItem) {
          const uninvoicedQty = await uninvoicedAvailability(deps.store, itemId);
          const alreadyLinked = await alreadyAttributed(deps.store, invoiceId, itemId);
          const remainingLineQty = Math.max(0, lineQuantity - alreadyLinked);
          const proposedLinkQty = Math.min(uninvoicedQty, remainingLineQty);
          proposalRows.push({
            itemId,
            itemName: itemsById.get(itemId)?.name ?? "",
            lineQuantity,
            uninvoicedQty,
            proposedLinkQty,
            // Once the line's attribution cap is consumed, there is no
            // remainder to offer even if uninvoiced stock remains available.
            remainderQty: Math.max(0, remainingLineQty - proposedLinkQty),
          });
        }
        return { invoiceId, items: proposalRows };
      }),
    ),
    purchasesLinkStock: os.purchasesLinkStock.handler(
      guardedInput(async (input) => {
        return deps.store.withTransaction(async (tx) => {
          const detail = await tx.getInvoiceDetail(input.invoiceId);
          if (detail === undefined || detail.kind !== "PURCHASE") {
            throw new ORPCError("NOT_FOUND", { message: "INVOICE_NOT_FOUND" });
          }
          const itemsById = await tx.getItemsByIds(input.allocations.map((a) => a.itemId));
          const quantitiesByItem = aggregateLineQuantities(detail.lines);
          let linked = 0;
          let remainderMoved = 0;
          for (const allocation of input.allocations) {
            const lineQuantity = quantitiesByItem.get(allocation.itemId);
            if (lineQuantity === undefined || !itemsById.has(allocation.itemId)) {
              throw new ORPCError("BAD_REQUEST", { message: "ITEM_NOT_ON_INVOICE" });
            }
            if (allocation.quantity > lineQuantity) {
              throw new ORPCError("BAD_REQUEST", { message: "LINK_EXCEEDS_LINE" });
            }
            // idempotency cap: a re-link can never attribute more than what is
            // still missing from this line (previous links count toward it)
            const attributed = await alreadyAttributed(tx, detail.id, allocation.itemId);
            let remainingToLink = Math.min(allocation.quantity, Math.max(0, lineQuantity - attributed));
            if (remainingToLink === 0) continue;
            // FIFO walk over that item's uninvoiced PURCHASE movements
            const movements = await tx.listStockMovements(allocation.itemId);
            const alreadyLinked = new Map<string, number>();
            for (const link of await tx.listStockLinksByItem(allocation.itemId)) {
              alreadyLinked.set(link.movementId, (alreadyLinked.get(link.movementId) ?? 0) + link.quantity);
            }
            for (const movement of movements) {
              if (remainingToLink === 0) break;
              if (movement.kind !== "PURCHASE" || movement.ref !== null) continue;
              const consumed = alreadyLinked.get(movement.id) ?? 0;
              const available = movement.delta - consumed;
              if (available <= 0) continue;
              const take = Math.min(available, remainingToLink);
              await tx.insertStockLink({ invoiceId: input.invoiceId, movementId: movement.id, quantity: take });
              remainingToLink -= take;
              linked += take;
            }
            // SAFETY: no new stock is minted here. invoicesCreate already
            // posted the FULL line quantity as the invoice's own PURCHASE
            // movement, so units beyond the uninvoiced pool are already in the
            // ledger — creating a "remainder" movement would double-count
            // them and overstate inventory (greptile finding). The unmatched
            // share is reported back as remainderMoved instead.
            remainderMoved += remainingToLink;
          }
          await tx.insertActivity({
            type: "STOCK_ADJUSTED",
            summary: `ربط مخزون سابق بفاتورة ${detail.invoiceNumber}`,
            ref: detail.id,
          });
          return { linked, remainderMoved };
        });
      }),
    ),
    purchasesCorrectLine: os.purchasesCorrectLine.handler(
      guardedInput(async (input) => {
        const line = await deps.store.getInvoiceLine(input.lineId);
        if (line === undefined || line.itemId === null) {
          throw new ORPCError("NOT_FOUND", { message: "LINE_NOT_FOUND" });
        }
        const detail = await deps.store.getInvoiceDetail(line.invoiceId);
        if (detail === undefined || detail.kind !== "PURCHASE") {
          throw new ORPCError("BAD_REQUEST", { message: "INVOICE_NOT_PURCHASE" });
        }
        return deps.store.withTransaction(async (tx) => {
          const item = (await tx.getItemsByIds([line.itemId!])).get(line.itemId!);
          if (item === undefined) {
            throw new ORPCError("NOT_FOUND", { message: "ITEM_NOT_FOUND" });
          }
          // append-only correction: reverse the PREVIOUS EFFECTIVE quantity of
          // this line (original + net of prior corrections, keyed by the
          // #lineId reason suffix), then record the corrected one. Re-reversing
          // the untouched original would double-reverse on every re-correction
          // and drift stock with each pass. Nothing is rewritten; settled
          // sales keep their original cost basis; only the live cache follows
          // the replay.
          const existing = await tx.listStockMovements(item.id);
          const suffix = `#${line.id}`;
          const priorNet = existing
            .filter(
              (movement) =>
                movement.ref === detail.id &&
                movement.reason?.startsWith(CORRECTION_REASON_PREFIX) === true &&
                movement.reason.endsWith(suffix),
            )
            .reduce((sum, movement) => sum + movement.delta, 0);
          const effectiveOriginal = line.quantity + priorNet;
          const reason = `${CORRECTION_REASON_PREFIX} ${detail.invoiceNumber} ${suffix}`;
          // One timestamp keeps the replacement and reversal in the same
          // ledger instant. The corrected inflow is inserted first, and the
          // store's rowid seq tie-breaker preserves that inflow-first order.
          const correctionOccurredAt = localDateTime();
          const reversal = {
            kind: "MANUAL_ADJUSTMENT" as const,
            delta: -effectiveOriginal,
            unitCost: null,
            occurredAt: correctionOccurredAt,
            seq: undefined,
          };
          const corrected = {
            kind: "PURCHASE" as const,
            delta: input.quantity,
            unitCost: input.unitCost,
            occurredAt: correctionOccurredAt,
            seq: undefined,
          };
          // SAFETY: the corrected INFLOW must precede the reversal OUTFLOW — in
          // the validation below AND in the stored rows. Reversal-first would
          // drive the projection below zero whenever any invoiced unit was
          // already sold (even for pure cost fixes) and would poison every
          // future replay of the stored ledger. Inflow-first fails exactly
          // when the corrected quantity drops below what was already sold.
          try {
            projectLedger([...existing, corrected, reversal]);
          } catch (err) {
            if (err instanceof StockLedgerError) {
              throw new ORPCError("BAD_REQUEST", { message: err.code });
            }
            throw err;
          }
          await tx.insertStockMovement({
            itemId: item.id,
            kind: corrected.kind,
            delta: corrected.delta,
            unitCost: corrected.unitCost,
            reason,
            ref: detail.id,
            occurredAt: corrected.occurredAt,
          });
          await tx.insertStockMovement({
            itemId: item.id,
            kind: reversal.kind,
            delta: reversal.delta,
            unitCost: null,
            reason,
            ref: detail.id,
            occurredAt: reversal.occurredAt,
          });
          const all = [...existing, corrected, reversal];
          const stockAfter = projectLedger(all).stockOnHand;
          const newCost = weightedAverageCost(all, { fallbackUnitCost: item.costPrice });
          await tx.setItemStockAndCost(item.id, stockAfter, newCost);
          await tx.insertActivity({ type: "STOCK_ADJUSTED", summary: `تصحيح شراء ${item.name}`, ref: item.id });
          const refreshed = await tx.getInvoiceDetail(detail.id);
          // SAFETY: the invoice was just read inside this handler; it cannot vanish mid-transaction
          return refreshed!;
        });
      }),
    ),
    reportsDebts: os.reportsDebts.handler(guarded(notImplemented("reportsDebts"))),
    settingsGet: os.settingsGet.handler(guarded(notImplemented("settingsGet"))),
    settingsUpdate: os.settingsUpdate.handler(guarded(notImplemented("settingsUpdate"))),
    activitiesList: os.activitiesList.handler(
      guardedInput(async ({ limit }) => ({ items: await deps.store.listActivities(limit ?? 50) })),
    ),
    diagnosticsLogsTail: os.diagnosticsLogsTail.handler(guarded(notImplemented("diagnosticsLogsTail"))),
    backupManual: os.backupManual.handler(
      guarded(async () => {
        // checkpoint+copy through the store seam; the audit entry lands only
        // after the file exists, so a failed copy never logs a phantom backup
        const result = await createBackup({ store: deps.store, dataDir: deps.config.dataDir });
        await deps.store.insertActivity({
          type: "BACKUP_CREATED",
          summary: `نسخة احتياطية ${result.path.split(/[\\/]/).pop()}`,
          ref: result.path,
        });
        return result;
      }),
    ),
  };
}

/** The router object type, for AppDeps. */
export type RpcRouter = ReturnType<typeof createRpcRouter>;

/** bun:sqlite surfaces the categories.name UNIQUE constraint as this text */
function isUniqueViolation(err: Error): boolean {
  return err.message.includes("UNIQUE constraint failed") || err.message.includes("unique constraint");
}

/** Maps the sqlite UNIQUE race on items.barcode to the stable BARCODE_EXISTS key. */
async function withBarcodeConflict<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof Error && isUniqueViolation(err)) {
      throw new ORPCError("CONFLICT", { message: "BARCODE_EXISTS" });
    }
    throw err;
  }
}

/**
 * Normalize an optional client-supplied barcode at the boundary. The zod
 * schema keeps invalid shapes out earlier; this catches case/space
 * normalization and any junk that slipped past validation defensively.
 */
function requireBarcode(raw: string | undefined): string | undefined {
  if (raw === undefined) return raw;
  const normalized = normalizeBarcode(raw);
  if (normalized === null) throw new ORPCError("BAD_REQUEST", { message: "INVALID_BARCODE" });
  return normalized;
}