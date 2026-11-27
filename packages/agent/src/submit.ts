import { z } from "zod";
import { Category, Priority } from "@inbox/core";
import { SUBMIT_TOOL_NAME } from "./prompt.ts";
import type { Tool } from "./llm.ts";

export const RISK_FLAGS = [
  "possible_prompt_injection",
  "budget_below_minimum",
  "date_unavailable",
  "missing_details",
  "suspicious_sender",
  "urgent_deadline",
  "needs_legal_review",
] as const;
export const RiskFlag = z.enum(RISK_FLAGS);

const nullableString = { type: ["string", "null"] } as const;
const nullableNumber = { type: ["number", "null"] } as const;

/**
 * Final-answer tool. `strict: true` makes the API guarantee the arguments match this
 * schema, which is why every field is required (optional ones are nullable instead).
 */
export const submitTool: Tool = {
  name: SUBMIT_TOOL_NAME,
  description: "Submit the triage result and draft reply. Call exactly once, after using the other tools.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["category", "priority", "language", "summary", "extracted", "draft_reply", "risk_flags"],
    properties: {
      category: { type: "string", enum: Category.options },
      priority: { type: "string", enum: Priority.options, description: "urgent = needs action within 48h" },
      language: { type: "string", description: "ISO 639-1 code of the sender's language, e.g. nl, en, fr" },
      summary: { type: "string", description: "Internal summary for the team" },
      extracted: {
        type: "object",
        additionalProperties: false,
        required: ["event_date", "city", "venue", "organization", "budget_eur", "audience_size", "event_type"],
        properties: {
          event_date: { ...nullableString, description: "YYYY-MM-DD" },
          city: nullableString,
          venue: nullableString,
          organization: nullableString,
          budget_eur: nullableNumber,
          audience_size: nullableNumber,
          event_type: { ...nullableString, description: "festival, club_show, private_event, brand_deal, feature, press, ..." },
        },
      },
      draft_reply: { type: "string", description: "Reply to the sender, in their language. Empty for spam." },
      risk_flags: { type: "array", items: { type: "string", enum: [...RISK_FLAGS] } },
    },
  },
};

/** Validated again on our side: never trust a single layer. */
export const SubmitInput = z.object({
  category: Category,
  priority: Priority,
  language: z.string().min(2).max(8),
  summary: z.string().min(1).max(2000),
  extracted: z.object({
    event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
    city: z.string().max(200).nullable(),
    venue: z.string().max(200).nullable(),
    organization: z.string().max(200).nullable(),
    budget_eur: z.number().nonnegative().nullable(),
    audience_size: z.number().int().nonnegative().nullable(),
    event_type: z.string().max(60).nullable(),
  }),
  draft_reply: z.string().max(5000),
  risk_flags: z.array(RiskFlag).max(RISK_FLAGS.length),
});
export type SubmitInput = z.infer<typeof SubmitInput>;
