import type { CalendarEvent, EventKind } from "../domain.ts";
import type { Queryable } from "./pool.ts";

interface EventRow {
  id: string;
  title: string;
  kind: EventKind;
  status: "confirmed" | "tentative";
  starts_at: Date;
  ends_at: Date;
  location: string | null;
  request_id: string | null;
}

const toEvent = (r: EventRow): CalendarEvent => ({
  id: r.id,
  title: r.title,
  kind: r.kind,
  status: r.status,
  startsAt: r.starts_at,
  endsAt: r.ends_at,
  location: r.location,
  requestId: r.request_id,
});

/** Events overlapping [from, to). */
export async function listEventsInRange(db: Queryable, from: Date, to: Date): Promise<CalendarEvent[]> {
  const res = await db.query<EventRow>(
    "SELECT * FROM calendar_events WHERE starts_at < $2 AND ends_at > $1 ORDER BY starts_at",
    [from, to],
  );
  return res.rows.map(toEvent);
}

export interface NewEvent {
  title: string;
  kind: EventKind;
  status?: "confirmed" | "tentative";
  startsAt: Date;
  endsAt: Date;
  location?: string | null;
  requestId?: string | null;
}

export async function insertEvent(db: Queryable, e: NewEvent): Promise<CalendarEvent> {
  const res = await db.query<EventRow>(
    `INSERT INTO calendar_events (title, kind, status, starts_at, ends_at, location, request_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [e.title, e.kind, e.status ?? "confirmed", e.startsAt, e.endsAt, e.location ?? null, e.requestId ?? null],
  );
  return toEvent(res.rows[0]!);
}

export type HoldResult =
  | { ok: true; event: CalendarEvent; created: boolean }
  | { ok: false; reason: "conflict"; conflicts: CalendarEvent[] };

/**
 * Place a tentative hold for a request. Refuses to overlap confirmed events.
 * Idempotent per (request, day): repeating the call returns the existing hold.
 */
export async function createHold(
  db: Queryable,
  h: { requestId: string; title: string; startsAt: Date; endsAt: Date; location?: string | null },
): Promise<HoldResult> {
  const existing = await db.query<EventRow>(
    `SELECT * FROM calendar_events
      WHERE request_id = $1 AND (starts_at AT TIME ZONE 'UTC')::date = ($2::timestamptz AT TIME ZONE 'UTC')::date`,
    [h.requestId, h.startsAt],
  );
  if (existing.rows[0]) return { ok: true, event: toEvent(existing.rows[0]), created: false };

  const conflicts = (await listEventsInRange(db, h.startsAt, h.endsAt)).filter((e) => e.status === "confirmed");
  if (conflicts.length) return { ok: false, reason: "conflict", conflicts };

  const event = await insertEvent(db, {
    title: h.title,
    kind: "hold",
    status: "tentative",
    startsAt: h.startsAt,
    endsAt: h.endsAt,
    location: h.location ?? null,
    requestId: h.requestId,
  });
  return { ok: true, event, created: true };
}
