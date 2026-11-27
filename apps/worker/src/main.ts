import { createServer } from "node:http";
import { createLogger, createPool, loadConfig, migrate } from "@inbox/core";
import { createLLM, DEFAULT_BUSINESS } from "@inbox/agent";
import { createRedis, createWorker, DELIVERY_QUEUE, Queues, TRIAGE_QUEUE } from "@inbox/queue";
import { createMetrics } from "./metrics.ts";
import { LogMailer, makeDeliveryProcessor, makeTriageProcessor } from "./processors.ts";
import { startSweeper } from "./sweeper.ts";

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL, "worker");
const db = createPool(config.DATABASE_URL, Number(process.env.WORKER_DB_POOL ?? 20));
await migrate(db);
const redis = createRedis(config.REDIS_URL);
const queues = new Queues(redis);
const metrics = createMetrics();
const llm = createLLM(config);
const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 8);

// Agent runs are I/O-bound (waiting on the model), so one process can run many at once.
// Scale out by running more worker replicas: BullMQ distributes jobs across them.
const triageWorker = createWorker(
  TRIAGE_QUEUE,
  makeTriageProcessor({ db, llm, business: DEFAULT_BUSINESS, logger, metrics, allowedLinkHosts: (process.env.ALLOWED_LINK_HOSTS ?? "").split(",").filter(Boolean) }),
  redis,
  { concurrency },
);
const deliveryWorker = createWorker(DELIVERY_QUEUE, makeDeliveryProcessor({ db, mailer: new LogMailer(logger), metrics, logger }), redis, { concurrency: 4 });
for (const w of [triageWorker, deliveryWorker]) {
  w.on("failed", (job, err) => logger.warn({ queue: w.name, jobId: job?.id, attempts: job?.attemptsMade, err: err.message }, "job failed"));
}
const stopSweeper = startSweeper({ db, queues, metrics, logger });

// Prometheus scrape endpoint (internal network only).
const metricsPort = Number(process.env.METRICS_PORT ?? 9100);
const metricsServer = createServer(async (req, res) => {
  if (req.url !== "/metrics") return void res.writeHead(404).end();
  res.writeHead(200, { "content-type": metrics.registry.contentType }).end(await metrics.registry.metrics());
}).listen(metricsPort);

logger.info({ concurrency, llm: llm.name, metricsPort }, "worker started");

// Graceful shutdown: stop taking jobs, let active agent runs finish, then close connections.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    logger.info({ signal }, "draining");
    stopSweeper();
    await Promise.all([triageWorker.close(), deliveryWorker.close()]);
    await queues.close();
    metricsServer.close();
    redis.disconnect();
    await db.end();
    process.exit(0);
  });
}
