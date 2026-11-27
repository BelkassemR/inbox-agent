import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { auditForRequest, countByStatus, getRequest, listRequests, RequestStatus, type Db, type InboundRequest } from "@inbox/core";

const ListQuery = z.object({
  status: RequestStatus.optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().optional(),
});
const IdParams = z.object({ id: z.uuid() });

/** Opaque cursor so clients can't depend on its internals. */
const encodeCursor = (r: InboundRequest) =>
  Buffer.from(JSON.stringify({ receivedAt: r.receivedAt.toISOString(), id: r.id })).toString("base64url");
function decodeCursor(c: string): { receivedAt: string; id: string } | null {
  try {
    const v = z.object({ receivedAt: z.iso.datetime(), id: z.uuid() }).parse(JSON.parse(Buffer.from(c, "base64url").toString()));
    return v;
  } catch {
    return null;
  }
}

/** The list view omits the (large) agent trace. */
export function summarize(r: InboundRequest) {
  const { agentTrace: _trace, body, ...rest } = r;
  return { ...rest, preview: body.slice(0, 280) };
}

export async function requestRoutes(app: FastifyInstance, opts: { db: Db }) {
  app.get("/v1/requests", async (req, reply) => {
    const q = ListQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: "invalid query", issues: q.error.issues });
    const before = q.data.cursor ? decodeCursor(q.data.cursor) : undefined;
    if (before === null) return reply.code(400).send({ error: "invalid cursor" });
    const limit = q.data.limit ?? 50;
    const items = await listRequests(opts.db, { status: q.data.status, limit, before });
    return {
      items: items.map(summarize),
      nextCursor: items.length === limit ? encodeCursor(items.at(-1)!) : null,
    };
  });

  app.get("/v1/requests/:id", async (req, reply) => {
    const p = IdParams.safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: "invalid id" });
    const request = await getRequest(opts.db, p.data.id);
    if (!request) return reply.code(404).send({ error: "not found" });
    return { ...request, audit: await auditForRequest(opts.db, request.id) };
  });

  app.get("/v1/stats", async () => ({ byStatus: await countByStatus(opts.db) }));
}
