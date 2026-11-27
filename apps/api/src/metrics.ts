import type { FastifyInstance } from "fastify";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export function createApiMetrics(queueDepth?: () => Promise<Record<string, Record<string, number>>>) {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  const http = new Histogram({
    name: "inbox_http_request_duration_seconds",
    help: "HTTP request duration",
    labelNames: ["method", "route", "status"],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
    registers: [registry],
  });
  const intake = new Counter({ name: "inbox_intake_total", help: "Intake webhook results", labelNames: ["result"], registers: [registry] });
  new Gauge({
    name: "inbox_queue_jobs",
    help: "Jobs per queue and state",
    labelNames: ["queue", "state"],
    registers: [registry],
    async collect() {
      if (!queueDepth) return;
      try {
        for (const [queue, states] of Object.entries(await queueDepth())) {
          for (const [state, n] of Object.entries(states)) this.set({ queue, state }, n);
        }
      } catch {
        /* Redis unavailable: skip this scrape */
      }
    },
  });
  return { registry, http, intake };
}
export type ApiMetrics = ReturnType<typeof createApiMetrics>;

export function instrument(app: FastifyInstance, m: ApiMetrics) {
  app.addHook("onResponse", async (req, reply) => {
    // Use the route pattern (/v1/requests/:id), not the raw URL, to keep label cardinality bounded.
    m.http.observe(
      { method: req.method, route: req.routeOptions.url ?? "unmatched", status: String(reply.statusCode) },
      reply.elapsedTime / 1000,
    );
  });
}
