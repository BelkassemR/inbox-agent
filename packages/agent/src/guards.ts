/**
 * Deterministic guards around the model. The model is asked to flag manipulation
 * itself, but we never rely on one layer: these checks run in code, before and after
 * the model, and their flags are added no matter what the model says.
 */

export interface InputAssessment {
  /** Signals found in the inbound message. */
  signals: string[];
  /** When true, the agent runs read-only (no holds, no CRM writes). */
  restrictWrites: boolean;
}

const INJECTION_PATTERNS: [string, RegExp][] = [
  ["override_instructions", /\b(ignore|disregard|forget|override)\b.{0,40}\b(previous|prior|above|earlier|all|your)\b.{0,20}\b(instructions?|rules?|prompts?|guidelines)\b/i],
  ["override_instructions_nl", /\b(negeer|vergeet)\b.{0,40}\b(vorige|eerdere|alle|je)\b.{0,20}\b(instructies|regels|opdrachten)\b/i],
  ["role_play", /\b(you are now|from now on you|act as|pretend to be|je bent nu|developer mode|jailbreak|DAN)\b/i],
  ["fake_authority", /\b(system|admin|developer|anthropic|openai)\s*(message|prompt|note|override|instruction)s?\s*[:\]]/i],
  ["prompt_exfiltration", /\b(reveal|print|show|repeat|output)\b.{0,30}\b(system prompt|your (instructions|prompt|rules)|hidden)\b/i],
  ["data_exfiltration", /\b(list|send|export|forward|share)\b.{0,40}\b(all|every|other)\b.{0,20}\b(contacts?|bookings?|emails?|clients?|fees?|rates?|calendar)\b/i],
  ["fake_markup", /<\/?\s*(system|assistant|tool_result|function_results?|instructions?)\b[^>]*>/i],
  ["hidden_text", /[​-‏‪-‮⁠-⁤﻿]/],
];

export function assessInput(text: string): InputAssessment {
  const signals = INJECTION_PATTERNS.filter(([, re]) => re.test(text)).map(([name]) => name);
  return { signals, restrictWrites: signals.length > 0 };
}

/** Strip invisible/bidi control characters that can hide instructions from a human reviewer. */
export function sanitizeInbound(text: string): string {
  return text.replace(/[​-‏‪-‮⁠-⁤﻿]/g, "");
}

export interface OutputContext {
  senderEmail: string | null;
  /** Fees the agent saw in tool results; these must never be quoted to the sender. */
  knownFees: number[];
  /** Hostnames we allow in replies (e.g. the artist's own site). */
  allowedLinkHosts: string[];
}

/**
 * Checks the draft reply for things the sender must not see: internal fees,
 * other people's email addresses, and links to unknown sites.
 */
export function checkOutput(draft: string, ctx: OutputContext): string[] {
  const flags = new Set<string>();

  const emails = draft.match(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g) ?? [];
  if (emails.some((e) => e.toLowerCase() !== ctx.senderEmail?.toLowerCase())) flags.add("output_contains_other_email");

  for (const url of draft.match(/\bhttps?:\/\/[^\s)>\]]+/gi) ?? []) {
    try {
      const host = new URL(url).hostname.toLowerCase();
      if (!ctx.allowedLinkHosts.some((h) => host === h || host.endsWith(`.${h}`))) flags.add("output_contains_unknown_link");
    } catch {
      flags.add("output_contains_unknown_link");
    }
  }

  const amounts = (draft.match(/\d{1,3}(?:[.,\s]\d{3})+|\d{3,}/g) ?? []).map((a) => Number(a.replace(/[.,\s]/g, "")));
  if (ctx.knownFees.some((fee) => amounts.includes(fee))) flags.add("output_mentions_internal_fee");

  return [...flags];
}

/** Pull the fees the agent saw out of its tool results. */
export function feesFromToolOutputs(outputs: string[]): number[] {
  const fees: number[] = [];
  for (const o of outputs) {
    try {
      const v = JSON.parse(o) as { minFeeEur?: unknown };
      if (typeof v.minFeeEur === "number") fees.push(v.minFeeEur);
    } catch {
      /* not JSON */
    }
  }
  return fees;
}
