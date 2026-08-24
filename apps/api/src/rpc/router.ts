import { implement, ORPCError } from "@orpc/server";
import { dokanContract } from "@dokan/contracts";

import type { AppConfig } from "../config";
import { normalizeBarcode } from "@dokan/contracts";
import { rankCatalog } from "../lib/catalog-search";
import type { DrizzleDb } from "../db/connection";
import type { AppLogger } from "../lib/logger";
import type { StorePort } from "../store/port";
import type { BetterAuthInstance } from "../auth/auth";
import { resetAdminPassword } from "../auth/admin";
import { AppError } from "../lib/errors";
import { historyWithRemaining, projectLedger, StockLedgerError, weightedAverageCost } from "../lib/stock-ledger";
import { localDateTime } from "../lib/logger";

export type RpcContext = { request: Request };

type RpcDeps = {
  db: DrizzleDb;
  config: AppConfig;
  logger: AppLogger;
  store: StorePort;
  auth: BetterAuthInstance;
};

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
            kind: "MANUAL_ADJUSTMENT" as const,
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

    // --- remaining procedures: guarded seams for later tickets ---------------
    customersList: os.customersList.handler(guarded(notImplemented("customersList"))),
    customersCreate: os.customersCreate.handler(guarded(notImplemented("customersCreate"))),
    suppliersList: os.suppliersList.handler(guarded(notImplemented("suppliersList"))),
    suppliersCreate: os.suppliersCreate.handler(guarded(notImplemented("suppliersCreate"))),
    invoicesCreate: os.invoicesCreate.handler(guarded(notImplemented("invoicesCreate"))),
    invoicesGet: os.invoicesGet.handler(guarded(notImplemented("invoicesGet"))),
    invoicesList: os.invoicesList.handler(guarded(notImplemented("invoicesList"))),
    invoicesPay: os.invoicesPay.handler(guarded(notImplemented("invoicesPay"))),
    reportsDebts: os.reportsDebts.handler(guarded(notImplemented("reportsDebts"))),
    settingsGet: os.settingsGet.handler(guarded(notImplemented("settingsGet"))),
    settingsUpdate: os.settingsUpdate.handler(guarded(notImplemented("settingsUpdate"))),
    activitiesList: os.activitiesList.handler(guarded(notImplemented("activitiesList"))),
    diagnosticsLogsTail: os.diagnosticsLogsTail.handler(guarded(notImplemented("diagnosticsLogsTail"))),
    backupManual: os.backupManual.handler(guarded(notImplemented("backupManual"))),
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