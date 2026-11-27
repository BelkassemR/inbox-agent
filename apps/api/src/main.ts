import { createLogger, createPool, loadConfig, migrate } from "@inbox/core";
import { buildApp } from "./app.ts";

const config = loadConfig();
const logger = createLogger(config.LOG_LEVEL, "api");
const db = createPool(config.DATABASE_URL);
await migrate(db);

const app = await buildApp({ config, db, logger });
await app.listen({ host: "0.0.0.0", port: config.PORT });

// Graceful shutdown: stop accepting connections, finish in-flight requests, close the pool.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, async () => {
    logger.info({ signal }, "shutting down");
    await app.close();
    await db.end();
    process.exit(0);
  });
}
