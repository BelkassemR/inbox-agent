import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import type { Config, Db, InboundRequest, Logger } from "@inbox/core";
import { apiKeyAuth } from "./auth.ts";
import { healthRoutes } from "./routes/health.ts";
import { intakeRoutes } from "./routes/intake.ts";
import { mcpRoutes } from "./routes/mcp.ts";
import { requestRoutes } from "./routes/requests.ts";

export interface AppDeps {
  config: Pick<Config, "API_KEYS" | "WEBHOOK_SECRET">;
  db: Db;
  logger?: Logger;
  onNewRequest?: (request: InboundRequest) => Promise<void>;
}

export async function buildApp(deps: AppDeps): Promise<FastifyInstance> {
  const app = Fastify({
    loggerInstance: deps.logger as FastifyBaseLogger | undefined,
    bodyLimit: 64 * 1024,
    // Trust X-Forwarded-For only from a reverse proxy you control; configure per deployment.
    trustProxy: false,
    genReqId: () => crypto.randomUUID(),
  });

  // Keep the raw body: webhook signatures are computed over the exact bytes received.
  app.addContentTypeParser("application/json", { parseAs: "buffer" }, (req, body, done) => {
    req.rawBody = body as Buffer;
    if ((body as Buffer).length === 0) return done(null, undefined);
    try {
      done(null, JSON.parse((body as Buffer).toString("utf8")));
    } catch {
      const err = new Error("invalid JSON") as Error & { statusCode: number };
      err.statusCode = 400;
      done(err, undefined);
    }
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, req, reply) => {
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (status >= 500) req.log.error({ err }, "unhandled error");
    // Never leak internals (stack traces, SQL) to clients.
    reply.code(status).send({ error: status >= 500 ? "internal error" : err.message });
  });

  await app.register(healthRoutes, { db: deps.db });
  await app.register(intakeRoutes, {
    db: deps.db,
    webhookSecret: deps.config.WEBHOOK_SECRET,
    onNewRequest: deps.onNewRequest,
  });

  // Everything registered in this scope requires an operator API key.
  await app.register(async (scope) => {
    scope.addHook("onRequest", apiKeyAuth(deps.config.API_KEYS));
    await scope.register(requestRoutes, { db: deps.db });
    await scope.register(mcpRoutes, { db: deps.db });
  });

  return app;
}
