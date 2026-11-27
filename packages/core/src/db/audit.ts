import type { Queryable } from "./pool.ts";

export interface AuditEntry {
  id: number;
  at: Date;
  actor: string;
  action: string;
  requestId: string | null;
  details: Record<string, unknown>;
}

/** Append-only audit trail: who (human, agent, system) did what to which request. */
export async function audit(
  db: Queryable,
  e: { actor: string; action: string; requestId?: string | null; details?: Record<string, unknown> },
): Promise<void> {
  await db.query("INSERT INTO audit_log (actor, action, request_id, details) VALUES ($1, $2, $3, $4)", [
    e.actor,
    e.action,
    e.requestId ?? null,
    JSON.stringify(e.details ?? {}),
  ]);
}

export async function auditForRequest(db: Queryable, requestId: string): Promise<AuditEntry[]> {
  const res = await db.query<{
    id: string;
    at: Date;
    actor: string;
    action: string;
    request_id: string | null;
    details: Record<string, unknown>;
  }>("SELECT * FROM audit_log WHERE request_id = $1 ORDER BY at, id", [requestId]);
  return res.rows.map((r) => ({
    id: Number(r.id),
    at: r.at,
    actor: r.actor,
    action: r.action,
    requestId: r.request_id,
    details: r.details,
  }));
}
