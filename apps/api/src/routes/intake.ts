import type { FastifyInstance } from "fastify";
import { audit, insertRequest, IntakePayload, type Db, type InboundRequest } from "@inbox/core";
import { SIGNATURE_HEADER, TIMESTAMP_HEADER, verifyWebhook } from "../auth.ts";

export interface IntakeOptions {
  db: Db;
  webhookSecret: string;
  /** Called after a new request is stored (e.g. to enqueue it for the agent). */
  onNewRequest?: (request: InboundRequest) => Promise<void>;
}

export async function intakeRoutes(app: FastifyInstance, opts: IntakeOptions) {
  app.post("/v1/intake", async (req, reply) => {
    const check = verifyWebhook(
      opts.webhookSecret,
      {
        signature: req.headers[SIGNATURE_HEADER] as string | undefined,
        timestamp: req.headers[TIMESTAMP_HEADER] as string | undefined,
      },
      req.rawBody ?? Buffer.alloc(0),
    );
    if (!check.ok) {
      req.log.warn({ reason: check.reason }, "rejected webhook");
      return reply.code(401).send({ error: "invalid signature" });
    }

    const parsed = IntakePayload.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "invalid payload", issues: parsed.error.issues });
    }

    const { request, created } = await insertRequest(opts.db, parsed.data);
    if (created) {
      await audit(opts.db, { actor: "system", action: "request.received", requestId: request.id, details: { channel: request.channel } });
      await opts.onNewRequest?.(request);
    }
    // 202: accepted for asynchronous processing. Duplicates get 200 with the original id.
    return reply.code(created ? 202 : 200).send({ id: request.id, status: request.status, duplicate: !created });
  });
}
