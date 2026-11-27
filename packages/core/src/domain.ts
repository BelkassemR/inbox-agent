import { z } from "zod";

export const Channel = z.enum(["email", "form", "dm", "webhook"]);
export type Channel = z.infer<typeof Channel>;

export const RequestStatus = z.enum([
  "received", // stored, not yet handed to the agent
  "queued", // waiting for a worker
  "processing", // agent is working on it
  "needs_review", // agent produced a draft, waiting for a human
  "approved", // human approved, reply is being sent
  "rejected", // human rejected the draft
  "sent", // reply delivered
  "failed", // agent or delivery failed after retries
]);
export type RequestStatus = z.infer<typeof RequestStatus>;

export const Category = z.enum(["booking", "collaboration", "press", "fan", "spam", "other"]);
export type Category = z.infer<typeof Category>;

export const Priority = z.enum(["low", "normal", "high", "urgent"]);
export type Priority = z.infer<typeof Priority>;

/** Payload accepted by the intake webhook. */
export const IntakePayload = z.object({
  externalId: z.string().min(1).max(200),
  channel: Channel,
  senderName: z.string().min(1).max(200),
  senderEmail: z.email().max(320).optional(),
  subject: z.string().max(500).optional(),
  body: z.string().min(1).max(20_000),
  receivedAt: z.iso.datetime({ offset: true }).optional(),
});
export type IntakePayload = z.infer<typeof IntakePayload>;

/** What the agent extracted from the request. All fields optional: the agent only fills what it found. */
export const Extracted = z.object({
  eventDate: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  venue: z.string().nullable().optional(),
  organization: z.string().nullable().optional(),
  budgetEur: z.number().nullable().optional(),
  audienceSize: z.number().nullable().optional(),
  eventType: z.string().nullable().optional(),
  language: z.string().nullable().optional(),
});
export type Extracted = z.infer<typeof Extracted>;

export interface InboundRequest {
  id: string;
  externalId: string;
  channel: Channel;
  senderName: string;
  senderEmail: string | null;
  subject: string | null;
  body: string;
  receivedAt: Date;
  status: RequestStatus;
  category: Category | null;
  priority: Priority | null;
  extracted: Extracted | null;
  summary: string | null;
  draftReply: string | null;
  riskFlags: string[];
  agentTrace: unknown | null;
  error: string | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Contact {
  id: string;
  name: string;
  email: string | null;
  organization: string | null;
  tags: string[];
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const EventKind = z.enum(["show", "hold", "studio", "travel", "private"]);
export type EventKind = z.infer<typeof EventKind>;

export interface CalendarEvent {
  id: string;
  title: string;
  kind: EventKind;
  status: "confirmed" | "tentative";
  startsAt: Date;
  endsAt: Date;
  location: string | null;
  requestId: string | null;
}

export interface RateCard {
  id: string;
  eventType: string;
  region: string;
  minFeeEur: number;
  notes: string | null;
}
