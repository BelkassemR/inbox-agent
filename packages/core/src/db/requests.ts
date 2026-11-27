import type {
  Category,
  Extracted,
  InboundRequest,
  IntakePayload,
  Priority,
  RequestStatus,
} from "../domain.ts";
import type { Queryable } from "./pool.ts";

interface RequestRow {
  id: string;
  external_id: string;
  channel: InboundRequest["channel"];
  sender_name: string;
  sender_email: string | null;
  subject: string | null;
  body: string;
  received_at: Date;
  status: RequestStatus;
  category: Category | null;
  priority: Priority | null;
  extracted: Extracted | null;
  summary: string | null;
  draft_reply: string | null;
  risk_flags: string[];
  agent_trace: unknown | null;
  error: string | null;
  reviewed_by: string | null;
  reviewed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function toRequest(r: RequestRow): InboundRequest {
  return {
    id: r.id,
    externalId: r.external_id,
    channel: r.channel,
    senderName: r.sender_name,
    senderEmail: r.sender_email,
    subject: r.subject,
    body: r.body,
    receivedAt: r.received_at,
    status: r.status,
    category: r.category,
    priority: r.priority,
    extracted: r.extracted,
    summary: r.summary,
    draftReply: r.draft_reply,
    riskFlags: r.risk_flags,
    agentTrace: r.agent_trace,
    error: r.error,
    reviewedBy: r.reviewed_by,
    reviewedAt: r.reviewed_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * Store an inbound request. Idempotent on (channel, externalId): a redelivered
 * webhook returns the existing row with `created: false` instead of a duplicate.
 */
export async function insertRequest(
  db: Queryable,
  p: IntakePayload,
): Promise<{ request: InboundRequest; created: boolean }> {
  const inserted = await db.query<RequestRow>(
    `INSERT INTO requests (external_id, channel, sender_name, sender_email, subject, body, received_at)
     VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7::timestamptz, now()))
     ON CONFLICT (channel, external_id) DO NOTHING
     RETURNING *`,
    [p.externalId, p.channel, p.senderName, p.senderEmail ?? null, p.subject ?? null, p.body, p.receivedAt ?? null],
  );
  if (inserted.rows[0]) return { request: toRequest(inserted.rows[0]), created: true };
  const existing = await db.query<RequestRow>(
    "SELECT * FROM requests WHERE channel = $1 AND external_id = $2",
    [p.channel, p.externalId],
  );
  return { request: toRequest(existing.rows[0]!), created: false };
}

export async function getRequest(db: Queryable, id: string): Promise<InboundRequest | null> {
  const res = await db.query<RequestRow>("SELECT * FROM requests WHERE id = $1", [id]);
  return res.rows[0] ? toRequest(res.rows[0]) : null;
}

export interface ListRequestsOptions {
  status?: RequestStatus;
  limit?: number;
  /** Keyset cursor: `received_at` ISO string + id of the last row of the previous page. */
  before?: { receivedAt: string; id: string };
}

/** Keyset pagination (not OFFSET) so listing stays fast as the table grows. */
export async function listRequests(db: Queryable, opts: ListRequestsOptions = {}): Promise<InboundRequest[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const params: unknown[] = [];
  const where: string[] = [];
  if (opts.status) {
    params.push(opts.status);
    where.push(`status = $${params.length}`);
  }
  if (opts.before) {
    params.push(opts.before.receivedAt, opts.before.id);
    where.push(`(received_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(limit);
  const res = await db.query<RequestRow>(
    `SELECT * FROM requests
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
     ORDER BY received_at DESC, id DESC
     LIMIT $${params.length}`,
    params,
  );
  return res.rows.map(toRequest);
}

export async function countByStatus(db: Queryable): Promise<Record<string, number>> {
  const res = await db.query<{ status: string; n: string }>(
    "SELECT status, count(*)::text AS n FROM requests GROUP BY status",
  );
  return Object.fromEntries(res.rows.map((r) => [r.status, Number(r.n)]));
}

/**
 * Compare-and-set status transition. Returns null if the request was not in
 * one of the `from` states, which protects against two workers (or a worker
 * and a human) acting on the same request at once.
 */
export async function transitionStatus(
  db: Queryable,
  id: string,
  from: RequestStatus[],
  to: RequestStatus,
  /** `error: undefined` keeps the current error, `null` clears it. */
  extra: { error?: string | null } = {},
): Promise<InboundRequest | null> {
  const res = await db.query<RequestRow>(
    `UPDATE requests
        SET status = $3, error = CASE WHEN $5 THEN $4 ELSE error END, updated_at = now()
      WHERE id = $1 AND status = ANY($2::text[])
      RETURNING *`,
    [id, from, to, extra.error ?? null, extra.error !== undefined],
  );
  return res.rows[0] ? toRequest(res.rows[0]) : null;
}

export interface AgentResult {
  category: Category;
  priority: Priority;
  extracted: Extracted;
  summary: string;
  draftReply: string;
  riskFlags: string[];
  trace: unknown;
}

export async function saveAgentResult(db: Queryable, id: string, r: AgentResult): Promise<InboundRequest | null> {
  const res = await db.query<RequestRow>(
    `UPDATE requests
        SET status = 'needs_review', category = $2, priority = $3, extracted = $4, summary = $5,
            draft_reply = $6, risk_flags = $7, agent_trace = $8, error = NULL, updated_at = now()
      WHERE id = $1 AND status = 'processing'
      RETURNING *`,
    [id, r.category, r.priority, JSON.stringify(r.extracted), r.summary, r.draftReply, r.riskFlags, JSON.stringify(r.trace)],
  );
  return res.rows[0] ? toRequest(res.rows[0]) : null;
}

export async function reviewRequest(
  db: Queryable,
  id: string,
  decision: "approved" | "rejected",
  reviewer: string,
  editedReply?: string,
): Promise<InboundRequest | null> {
  const res = await db.query<RequestRow>(
    `UPDATE requests
        SET status = $2, reviewed_by = $3, reviewed_at = now(),
            draft_reply = COALESCE($4, draft_reply), updated_at = now()
      WHERE id = $1 AND status = 'needs_review'
      RETURNING *`,
    [id, decision, reviewer, editedReply ?? null],
  );
  return res.rows[0] ? toRequest(res.rows[0]) : null;
}

export async function requestsBySender(db: Queryable, email: string, limit = 10): Promise<InboundRequest[]> {
  const res = await db.query<RequestRow>(
    `SELECT * FROM requests WHERE lower(sender_email) = lower($1) ORDER BY received_at DESC LIMIT $2`,
    [email, limit],
  );
  return res.rows.map(toRequest);
}

/** Requests stuck in `status` for longer than `olderThanSeconds` (crash recovery, missed enqueues). */
export async function findStale(db: Queryable, status: RequestStatus, olderThanSeconds: number, limit = 100): Promise<string[]> {
  const res = await db.query<{ id: string }>(
    `SELECT id FROM requests WHERE status = $1 AND updated_at < now() - make_interval(secs => $2) ORDER BY updated_at LIMIT $3`,
    [status, olderThanSeconds, limit],
  );
  return res.rows.map((r) => r.id);
}
