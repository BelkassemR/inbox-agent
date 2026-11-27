import type { FastifyInstance } from "fastify";
import type { RequestEvent, RequestEventBus } from "../events.ts";

/** Server-Sent Events stream of request changes for the dashboard. */
export async function eventRoutes(app: FastifyInstance, opts: { bus: RequestEventBus }) {
  app.get("/v1/events", (req, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no", // disable proxy buffering (nginx)
    });
    res.write("retry: 3000\n\n");

    const send = (e: RequestEvent) => res.write(`event: request\ndata: ${JSON.stringify(e)}\n\n`);
    // Heartbeat keeps idle connections open through proxies and load balancers.
    const heartbeat = setInterval(() => res.write(": ping\n\n"), 15_000);
    opts.bus.on("event", send);
    req.raw.on("close", () => {
      clearInterval(heartbeat);
      opts.bus.off("event", send);
    });
  });
}
