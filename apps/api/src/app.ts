import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import { Hono } from "hono";

import type { AppConfig } from "./config";
import { localDateTime, type AppLogger } from "./lib/logger";
import type { BetterAuthInstance } from "./auth/auth";
import type { RpcRouter } from "./rpc/router";

export type AppDeps = {
  config: AppConfig;
  logger: AppLogger;
  auth: BetterAuthInstance;
  rpcRouter: RpcRouter;
};

export function createApp(deps: AppDeps) {
  const { config, logger, auth, rpcRouter } = deps;

  const rpcHandler = new RPCHandler(rpcRouter, {
    interceptors: [
      onError((error) => {
        // every technical error gets a DKN row with a stack; a non-Error
        // rejection (e.g. `throw "x"`) is wrapped so the invariant holds
        const wrapped = error instanceof Error ? error : new Error(String(error));
        logger.error("RPC_ERROR", "rpc call failed", wrapped);
      }),
    ],
  });

  const app = new Hono();

  app.use("*", async (c, next) => {
    await next();
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
  });

  app.get("/health", (c) => c.json({ ok: true, version: config.version, time: localDateTime() }));

  // better-auth handles /api/auth/* itself (sign-in, session, sign-out);
  // account creation is NOT allowed: the single admin is provisioned by
  // first-run setup only, so the sign-up route is blocked before it can run
  app.all("/api/auth/*", (c) => {
    if (c.req.method === "POST" && c.req.path.includes("/sign-up")) {
      return c.json({ error: { message: "SIGNUP_FORBIDDEN" } }, 403);
    }
    return auth.handler(c.req.raw);
  });

  // oRPC procedures; the context carries the raw Request for the session guard
  app.all("/api/rpc/*", async (c) => {
    const result = await rpcHandler.handle(c.req.raw, { prefix: "/api/rpc", context: { request: c.req.raw } });
    return result.matched ? result.response : c.text("Not found", 404);
  });

  return app;
}