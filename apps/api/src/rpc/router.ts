import { implement, ORPCError } from "@orpc/server";
import { dokanContract } from "@dokan/contracts";

import type { AppConfig } from "../config";
import type { DrizzleDb } from "../db/connection";
import type { AppLogger } from "../lib/logger";
import type { StorePort } from "../store/port";
import type { BetterAuthInstance } from "../auth/auth";
import { resetAdminPassword } from "../auth/admin";
import { AppError } from "../lib/errors";

export type RpcContext = { request: Request };

type RpcDeps = {
  db: DrizzleDb;
  config: AppConfig;
  logger: AppLogger;
  store: StorePort;
  auth: BetterAuthInstance;
};

/**
 * Business procedures land in the items/categories lane (ticket 03). They are
 * listed here with the session guard so the auth rule holds even before their
 * implementations exist; the coordinator merges the real handlers over these
 * NOT_IMPLEMENTED seams.
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

  const notImplemented = (): never => {
    throw new ORPCError("NOT_IMPLEMENTED", { message: "lands in ticket 03" });
  };

  const guarded = <T,>(handler: (context: RpcContext) => Promise<T>) => async ({ context }: { context: RpcContext }): Promise<T> => {
    await requireSession(context);
    return handler(context);
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

    // --- business procedures: guarded seams for ticket 03 --------------------
    categoriesList: os.categoriesList.handler(guarded(() => notImplemented())),
    categoriesCreate: os.categoriesCreate.handler(guarded(() => notImplemented())),
    itemsList: os.itemsList.handler(guarded(() => notImplemented())),
    itemsCreate: os.itemsCreate.handler(guarded(() => notImplemented())),
    itemsUpdate: os.itemsUpdate.handler(guarded(() => notImplemented())),
    itemsLowStock: os.itemsLowStock.handler(guarded(() => notImplemented())),
    customersList: os.customersList.handler(guarded(() => notImplemented())),
    customersCreate: os.customersCreate.handler(guarded(() => notImplemented())),
    suppliersList: os.suppliersList.handler(guarded(() => notImplemented())),
    suppliersCreate: os.suppliersCreate.handler(guarded(() => notImplemented())),
    invoicesCreate: os.invoicesCreate.handler(guarded(() => notImplemented())),
    invoicesGet: os.invoicesGet.handler(guarded(() => notImplemented())),
    invoicesList: os.invoicesList.handler(guarded(() => notImplemented())),
    invoicesPay: os.invoicesPay.handler(guarded(() => notImplemented())),
    reportsDebts: os.reportsDebts.handler(guarded(() => notImplemented())),
    settingsGet: os.settingsGet.handler(guarded(() => notImplemented())),
    settingsUpdate: os.settingsUpdate.handler(guarded(() => notImplemented())),
    activitiesList: os.activitiesList.handler(guarded(() => notImplemented())),
    diagnosticsLogsTail: os.diagnosticsLogsTail.handler(guarded(() => notImplemented())),
    backupManual: os.backupManual.handler(guarded(() => notImplemented())),
  };
}

export type RpcRouter = ReturnType<typeof createRpcRouter>;