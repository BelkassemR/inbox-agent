import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { audit, releaseHolds, reviewRequest, transitionStatus, withTransaction, type Db, type InboundRequest } from "@inbox/core";

const IdParams = z.object({ id: z.uuid() });
const ApproveBody = z.object({ reply: z.string().min(1).max(5000).optional() }).default({});
const RejectBody = z.object({ reason: z.string().max(1000).optional() }).default({});

export interface ReviewOptions {
  db: Db;
  /** Called after approval, e.g. to enqueue delivery of the reply. */
  onApproved?: (request: InboundRequest) => Promise<void>;
  /** Called when a failed request is retried. */
  onRetry?: (request: InboundRequest) => Promise<void>;
}

/**
 * Human-in-the-loop: nothing the agent drafts reaches the sender until an operator
 * approves it here. Transitions are compare-and-set, so two operators clicking at
 * the same time can't both act; the loser gets 409.
 */
export async function reviewRoutes(app: FastifyInstance, opts: ReviewOptions) {
  app.post("/v1/requests/:id/approve", async (req, reply) => {
    const p = IdParams.safeParse(req.params);
    const b = ApproveBody.safeParse(req.body ?? {});
    if (!p.success || !b.success) return reply.code(400).send({ error: "invalid request" });
    const operator = req.operator!;

    const updated = await withTransaction(opts.db, async (tx) => {
      const before = await tx.query<{ draft_reply: string | null }>("SELECT draft_reply FROM requests WHERE id = $1", [p.data.id]);
      const r = await reviewRequest(tx, p.data.id, "approved", operator, b.data.reply);
      if (r) {
        await audit(tx, {
          actor: operator,
          action: "review.approved",
          requestId: r.id,
          details: { edited: b.data.reply !== undefined && b.data.reply !== before.rows[0]?.draft_reply },
        });
      }
      return r;
    });
    if (!updated) return reply.code(409).send({ error: "request is not awaiting review" });
    await opts.onApproved?.(updated);
    return updated;
  });

  app.post("/v1/requests/:id/reject", async (req, reply) => {
    const p = IdParams.safeParse(req.params);
    const b = RejectBody.safeParse(req.body ?? {});
    if (!p.success || !b.success) return reply.code(400).send({ error: "invalid request" });
    const operator = req.operator!;

    const updated = await withTransaction(opts.db, async (tx) => {
      const r = await reviewRequest(tx, p.data.id, "rejected", operator);
      if (r) {
        // A rejected request shouldn't keep blocking dates.
        const released = await releaseHolds(tx, r.id);
        await audit(tx, { actor: operator, action: "review.rejected", requestId: r.id, details: { reason: b.data.reason ?? null, holdsReleased: released } });
      }
      return r;
    });
    if (!updated) return reply.code(409).send({ error: "request is not awaiting review" });
    return updated;
  });

  app.post("/v1/requests/:id/retry", async (req, reply) => {
    const p = IdParams.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: "invalid id" });
    const updated = await transitionStatus(opts.db, p.data.id, ["failed"], "queued", { error: null });
    if (!updated) return reply.code(409).send({ error: "only failed requests can be retried" });
    await audit(opts.db, { actor: req.operator!, action: "review.retry", requestId: updated.id });
    await opts.onRetry?.(updated);
    return updated;
  });
}
