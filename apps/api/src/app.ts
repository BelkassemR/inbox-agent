import Fastify, { type FastifyBaseLogger, type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import rateLimit from "@fastify/rate-limit";
import type { Config, Db, InboundRequest, Logger } from "@inbox/core";
import { apiKeyAuth } from "./auth.ts";
import { instrument, type ApiMetrics } from "./metrics.ts";
import { healthRoutes } from "./routes/health.ts";
import { intakeRoutes } from "./routes/intake.ts";
import { mcpRoutes } from "./routes/mcp.ts";
import { requestRoutes } from "./routes/requests.ts";
import { reviewRoutes } from "./routes/review.ts";

export interface AppDeps {
  config: Pick<Config, "API_KEYS" | "WEBHOOK_SECRET"> & Partial<Pick<Config, "CORS_ORIGINS" | "RATE_LIMIT_PER_MINUTE">>;
  db: Db;
  logger?: Logger;
  onNewRequest?: (request: InboundRequest) => Promise<void>;
  onApproved?: (request: InboundRequest) => Promise<void>;
  metrics?: ApiMetrics;
  queueDepth?: () => Promise<unknown>;
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

  // Security headers. The API serves JSON only, so the strictest CSP is fine.
  await app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } } });
  // Browsers may only call the API from configured dashboard origins.
  await app.register(cors, { origin: deps.config.CORS_ORIGINS ?? [], methods: ["GET", "POST"], allowedHeaders: ["authorization", "content-type"] });
  // Per-client rate limit, as a root onRequest hook so it runs before auth: failed
  // API-key attempts count too, which slows down key guessing.
  await app.register(rateLimit, { global: false });
  app.addHook(
    "onRequest",
    app.rateLimit({
      max: deps.config.RATE_LIMIT_PER_MINUTE ?? 120,
      timeWindow: "1 minute",
      allowList: (req) => req.url === "/healthz" || req.url === "/readyz",
    }),
  );

  if (deps.metrics) instrument(app, deps.metrics);

  await app.register(healthRoutes, { db: deps.db });
  await app.register(intakeRoutes, {
    db: deps.db,
    webhookSecret: deps.config.WEBHOOK_SECRET,
    onNewRequest: deps.onNewRequest,
    onResult: (result) => deps.metrics?.intake.inc({ result }),
  });

  // Everything registered in this scope requires an operator API key.
  await app.register(async (scope) => {
    scope.addHook("onRequest", apiKeyAuth(deps.config.API_KEYS));
    await scope.register(requestRoutes, { db: deps.db, queueDepth: deps.queueDepth });
    if (deps.metrics) {
      const registry = deps.metrics.registry;
      scope.get("/metrics", async (_req, reply) => reply.type(registry.contentType).send(await registry.metrics()));
    }
    await scope.register(reviewRoutes, { db: deps.db, onApproved: deps.onApproved, onRetry: deps.onNewRequest });
    await scope.register(mcpRoutes, { db: deps.db });
  });

  return app;
}
