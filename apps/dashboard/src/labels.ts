import type { Status } from "./api.ts";

export const STATUS_LABEL: Record<Status, string> = {
  received: "Ontvangen",
  queued: "In wachtrij",
  processing: "Agent bezig",
  needs_review: "Te beoordelen",
  approved: "Goedgekeurd",
  rejected: "Afgewezen",
  sent: "Verstuurd",
  failed: "Mislukt",
};

export const CATEGORY_LABEL: Record<string, string> = {
  booking: "Boeking",
  collaboration: "Samenwerking",
  press: "Pers",
  fan: "Fan",
  spam: "Spam",
  other: "Overig",
};

export const PRIORITY_LABEL: Record<string, string> = { low: "Laag", normal: "Normaal", high: "Hoog", urgent: "Urgent" };

export const FLAG_LABEL: Record<string, string> = {
  possible_prompt_injection: "Mogelijke prompt injection",
  budget_below_minimum: "Budget onder minimum",
  date_unavailable: "Datum bezet",
  missing_details: "Details ontbreken",
  suspicious_sender: "Verdachte afzender",
  urgent_deadline: "Urgente deadline",
  needs_legal_review: "Juridische check nodig",
  output_contains_other_email: "Concept bevat ander e-mailadres",
  output_contains_unknown_link: "Concept bevat onbekende link",
  output_mentions_internal_fee: "Concept noemt interne gage",
};

/** Flags that should make a reviewer stop and read carefully. */
export const SEVERE_FLAGS = new Set([
  "possible_prompt_injection",
  "suspicious_sender",
  "output_contains_other_email",
  "output_contains_unknown_link",
  "output_mentions_internal_fee",
]);

export const FIELD_LABEL: Record<string, string> = {
  eventDate: "Datum",
  city: "Stad",
  venue: "Locatie",
  organization: "Organisatie",
  budgetEur: "Budget (€)",
  audienceSize: "Bezoekers",
  eventType: "Type",
  language: "Taal",
};

export function timeAgo(iso: string): string {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 60) return "zojuist";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} u`;
  return new Date(iso).toLocaleDateString("nl-NL", { day: "numeric", month: "short" });
}
