import { z } from "zod";
import {
  audit,
  createHold,
  findContactByEmail,
  listEventsInRange,
  listRates,
  lookupRate,
  requestsBySender,
  searchContactsByName,
  upsertContact,
  type Db,
} from "@inbox/core";
import { addDays, daysBetween, localDate, localTime, TIMEZONE, zonedToUtc } from "./time.ts";

/**
 * Tool implementations, independent of the MCP transport so they can be unit tested
 * directly. Every input is validated with zod at the boundary: the caller is an LLM,
 * so arguments are untrusted.
 */

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD").refine((s) => !Number.isNaN(Date.parse(s)), "invalid date");
const HhMm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "use HH:MM (24h)");
const MAX_RANGE_DAYS = 62;

export class ToolInputError extends Error {}

export interface ToolContext {
  db: Db;
  /** Who is calling, recorded in the audit log (e.g. "agent", "mcp:stdio"). */
  actor: string;
  /** When set, the server is scoped to one request: write tools act on it only. */
  requestId?: string;
  /** Request to leave out of history lookups (the one being triaged). */
  excludeRequestId?: string;
}

export const checkAvailabilityInput = {
  from: IsoDate.describe("First date to check (YYYY-MM-DD), Europe/Amsterdam"),
  to: IsoDate.describe(`Last date to check, inclusive (max ${MAX_RANGE_DAYS} days after 'from')`),
};
export async function checkAvailability(ctx: ToolContext, args: { from: string; to: string }) {
  const span = daysBetween(args.from, args.to);
  if (span < 0) throw new ToolInputError("'to' must not be before 'from'");
  if (span > MAX_RANGE_DAYS) throw new ToolInputError(`range too large (max ${MAX_RANGE_DAYS} days)`);
  const events = await listEventsInRange(ctx.db, zonedToUtc(args.from, "00:00"), zonedToUtc(addDays(args.to, 1), "00:00"));
  const busy = new Set(events.filter((e) => e.status === "confirmed").map((e) => localDate(e.startsAt)));
  const tentative = new Set(events.filter((e) => e.status === "tentative").map((e) => localDate(e.startsAt)));
  const days = Array.from({ length: span + 1 }, (_, i) => addDays(args.from, i));
  return {
    timezone: TIMEZONE,
    freeDates: days.filter((d) => !busy.has(d) && !tentative.has(d)),
    tentativeDates: days.filter((d) => tentative.has(d) && !busy.has(d)),
    events: events.map((e) => ({
      date: localDate(e.startsAt),
      start: localTime(e.startsAt),
      end: localTime(e.endsAt),
      title: e.title,
      kind: e.kind,
      status: e.status,
      location: e.location,
    })),
  };
}

export const createHoldInput = {
  date: IsoDate.describe("Date to hold (YYYY-MM-DD), Europe/Amsterdam"),
  title: z.string().min(3).max(120).describe("Short title, e.g. 'HOLD – Zomerfest Utrecht'"),
  location: z.string().max(200).optional().describe("City and/or venue"),
  start_time: HhMm.optional().describe("Local start time, default 17:00"),
  end_time: HhMm.optional().describe("Local end time, default 23:59"),
};
export const createHoldUnscopedInput = {
  ...createHoldInput,
  request_id: z.uuid().describe("The inbound request this hold belongs to"),
};
export async function placeHold(
  ctx: ToolContext,
  args: { date: string; title: string; location?: string; start_time?: string; end_time?: string; request_id?: string },
) {
  const requestId = ctx.requestId ?? args.request_id;
  if (!requestId) throw new ToolInputError("request_id is required");
  const startsAt = zonedToUtc(args.date, args.start_time ?? "17:00");
  const endsAt = zonedToUtc(args.date, args.end_time ?? "23:59");
  if (endsAt <= startsAt) throw new ToolInputError("end_time must be after start_time");
  if (startsAt.getTime() < Date.now()) throw new ToolInputError("cannot place a hold in the past");

  const result = await createHold(ctx.db, { requestId, title: args.title, startsAt, endsAt, location: args.location });
  if (!result.ok) {
    return {
      placed: false,
      reason: "date conflicts with a confirmed event",
      conflicts: result.conflicts.map((e) => ({ title: e.title, start: localTime(e.startsAt), end: localTime(e.endsAt) })),
    };
  }
  if (result.created) {
    await audit(ctx.db, {
      actor: ctx.actor,
      action: "calendar.hold_created",
      requestId,
      details: { date: args.date, title: args.title, eventId: result.event.id },
    });
  }
  return { placed: true, alreadyExisted: !result.created, holdId: result.event.id, date: args.date, status: "tentative" };
}

export const findContactInput = {
  email: z.email().optional().describe("Exact email address"),
  name: z.string().min(2).max(200).optional().describe("Name or organization (partial match)"),
};
export async function findContact(ctx: ToolContext, args: { email?: string; name?: string }) {
  if (!args.email && !args.name) throw new ToolInputError("provide email or name");
  const matches = args.email
    ? [await findContactByEmail(ctx.db, args.email)].filter((c) => c !== null)
    : await searchContactsByName(ctx.db, args.name!);
  return {
    found: matches.length > 0,
    contacts: matches.map((c) => ({ name: c.name, email: c.email, organization: c.organization, tags: c.tags, notes: c.notes })),
  };
}

export const upsertContactInput = {
  name: z.string().min(1).max(200),
  email: z.email(),
  organization: z.string().max(200).optional(),
  tags: z.array(z.string().min(1).max(40)).max(10).optional().describe("e.g. promoter, press, brand"),
  note: z.string().max(1000).optional().describe("Short factual note to append to the contact's history"),
};
export async function saveContact(
  ctx: ToolContext,
  args: { name: string; email: string; organization?: string; tags?: string[]; note?: string },
) {
  const { contact, created } = await upsertContact(ctx.db, args);
  await audit(ctx.db, {
    actor: ctx.actor,
    action: created ? "crm.contact_created" : "crm.contact_updated",
    requestId: ctx.requestId ?? null,
    details: { contactId: contact.id, email: contact.email },
  });
  return { saved: true, created, contactId: contact.id };
}

export const ratesInput = {
  event_type: z.string().min(2).max(60).describe("e.g. festival, club_show, private_event, brand_deal, feature"),
  region: z.string().min(2).max(40).describe("Country code like NL or BE"),
};
export async function rates(ctx: ToolContext, args: { event_type: string; region: string }) {
  const rate = await lookupRate(ctx.db, args.event_type, args.region);
  if (rate) return { found: true, eventType: rate.eventType, region: rate.region, minFeeEur: rate.minFeeEur, notes: rate.notes };
  const known = [...new Set((await listRates(ctx.db)).map((r) => r.eventType))];
  return { found: false, knownEventTypes: known };
}

export const historyInput = {
  email: z.email().describe("Sender email address"),
};
export async function history(ctx: ToolContext, args: { email: string }) {
  const rows = (await requestsBySender(ctx.db, args.email, 10)).filter((r) => r.id !== ctx.excludeRequestId);
  return {
    previousRequests: rows.map((r) => ({
      date: localDate(r.receivedAt),
      subject: r.subject,
      category: r.category,
      status: r.status,
      summary: r.summary,
    })),
  };
}
