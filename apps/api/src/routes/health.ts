import type { FastifyInstance } from "fastify";
import type { Db } from "@inbox/core";

export async function healthRoutes(app: FastifyInstance, opts: { db: Db }) {
  // Liveness: the process is up.
  app.get("/healthz", async () => ({ ok: true }));
  // Readiness: dependencies are reachable; load balancers should only route here when this passes.
  app.get("/readyz", async (_req, reply) => {
    try {
      await opts.db.query("SELECT 1");
      return { ok: true };
    } catch {
      return reply.code(503).send({ ok: false });
    }
  });
}
