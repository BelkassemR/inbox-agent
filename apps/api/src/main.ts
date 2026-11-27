import { createLogger, createPool, loadConfig, migrate, transitionStatus } from "@inbox/core";
import { createRedis, Queues } from "@inbox/queue";
import { createApiMetrics } from "./metrics.ts";
import { buildApp } from "./app.ts";

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL, "api");
const db = createPool(config.DATABASE_URL);
await migrate(db);

const redis = createRedis(config.REDIS_URL);
const queues = new Queues(redis);
const metrics = createApiMetrics(() => queues.depth());

const app = await buildApp({
  config,
  db,
  logger,
  metrics,
  queueDepth: () => queues.depth(),
  onNewRequest: async (request) => {
    // Retries (failed -> queued) need a fresh job id; first-time intake dedupes on the request id.
    await queues.enqueueTriage(request.id, request.status === "queued" ? String(Date.now()) : undefined);
    await transitionStatus(db, request.id, ["received"], "queued");
  },
  onApproved: async (request) => {
    await queues.enqueueDelivery(request.id).catch((err) => logger.error({ err, requestId: request.id }, "failed to enqueue delivery; sweeper will retry"));
  },
});
await app.listen({ host: "0.0.0.0", port: config.PORT });

// Graceful shutdown: stop accepting connections, finish in-flight requests, close the pool.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    logger.info({ signal }, "shutting down");
    await app.close();
    await queues.close();
    redis.disconnect();
    await db.end();
    process.exit(0);
  });
}
