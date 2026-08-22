import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";

import type { AppConfig } from "./config";
import { localDateTime } from "./lib/logger";
import type { AppLogger } from "./lib/logger";
import { createRpcRouter } from "./rpc/router";
import type { StorePort } from "./store/port";

/**
 * The Hono app: security headers, a health probe, and the oRPC handler under
 * /api/rpc. main.ts stays thin; every business procedure lives in the router.
 */
export function createApp(store: StorePort, logger: AppLogger, config: AppConfig): Hono {
  const router = createRpcRouter(store, logger, config.version);
  // SAFETY: the fetch adapter's Router binding is narrower than our router
  // map; tuari bridges the same boundary the same way, and handlers are
  // type-checked by implement(...) above.
  const rpcHandler = new RPCHandler(router as never, {
    interceptors: [
      onError((error) => {
        logger.error("RPC_ERROR", "procedure failed", error instanceof Error ? error : undefined);
      }),
    ],
  });

  const app = new Hono();

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
  });

  app.get("/health", (c) =>
    c.json({
      ok: true,
      version: config.version,
      time: localDateTime(),
    }),
  );

  app.all("/api/rpc/*", async (c) => {
    const result = await rpcHandler.handle(c.req.raw, { prefix: "/api/rpc", context: {} });
    return result.matched ? result.response : c.text("Not found", 404);
  });

  return app;
}