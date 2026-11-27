import type { LLM, Message, MessageParam, ToolUseBlock, TurnParams } from "../llm.ts";
import { SUBMIT_TOOL_NAME } from "../prompt.ts";
import type { SubmitInput } from "../submit.ts";
import { classify, detectLanguage, extractAudience, extractBudget, extractCity, extractDate, looksLikeInjection } from "./extract.ts";

/**
 * A deterministic stand-in for Claude that follows the same protocol (tool_use blocks,
 * stop reasons, usage). It plans: look up → hold/save → submit, based on regex
 * extraction. It lets CI and demos exercise the full agent pipeline — MCP tools,
 * policy, persistence — with no API key and no cost. It is NOT the product's
 * intelligence; set LLM_PROVIDER=anthropic for that.
 */
export class ScriptedLLM implements LLM {
  readonly name = "scripted";
  private seq = 0;

  async createTurn({ messages }: TurnParams): Promise<Message> {
    const state = readState(messages);
    const r = state.request;
    const turn = messages.filter((m) => m.role === "assistant").length;

    if (turn === 0) {
      const calls: [string, Record<string, unknown>][] = [];
      if (r.category !== "spam" && !r.injection) {
        if (r.email) calls.push(["crm_find_contact", { email: r.email }], ["requests_history", { email: r.email }]);
        if (r.date && r.category === "booking") calls.push(["calendar_check_availability", { from: r.date, to: r.date }]);
        if (r.eventType && r.category === "booking") calls.push(["rates_lookup", { event_type: r.eventType, region: r.region ?? "NL" }]);
      }
      if (calls.length) return this.toolTurn("Let me look up the sender, the calendar and our rates.", calls);
    }

    if (turn === 1 && r.category !== "spam" && !r.injection) {
      const calls: [string, Record<string, unknown>][] = [];
      const free = state.results.calendar_check_availability?.freeDates?.includes(r.date ?? "");
      if (r.category === "booking" && r.date && free) {
        calls.push(["calendar_create_hold", { date: r.date, title: `HOLD – ${r.org ?? r.senderName}${r.city ? ` ${r.city}` : ""}`, location: r.city ?? undefined }]);
      }
      if (r.email && ["booking", "collaboration", "press"].includes(r.category)) {
        calls.push(["crm_upsert_contact", { name: r.senderName, email: r.email, organization: r.org ?? undefined, tags: [tagFor(r.category)], note: `${state.today}: ${r.category} request` }]);
      }
      if (calls.length) return this.toolTurn("Placing a hold and saving the contact.", calls);
    }

    return this.toolTurn("Submitting the triage.", [[SUBMIT_TOOL_NAME, buildSubmission(state)]]);
  }

  private toolTurn(text: string, calls: [string, Record<string, unknown>][]): Message {
    const content: Message["content"] = [
      { type: "text", text, citations: null },
      ...calls.map(([name, input]): ToolUseBlock => ({ type: "tool_use", id: `toolu_scripted_${++this.seq}`, name, input, caller: { type: "direct" } } as ToolUseBlock)),
    ];
    return {
      id: `msg_scripted_${this.seq}`,
      type: "message",
      role: "assistant",
      model: "scripted",
      content,
      stop_reason: "tool_use",
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    } as unknown as Message;
  }
}

const tagFor = (c: string) => (c === "booking" ? "promoter" : c === "press" ? "press" : "brand");

interface State {
  today: string;
  request: ReturnType<typeof parseRequest>;
  results: Record<string, any>;
}

function parseRequest(text: string, today: string) {
  const from = text.match(/^From: (.*?)(?: <([^>]+)>)?$/m);
  const subject = text.match(/^Subject: (.*)$/m)?.[1] ?? "";
  const body = text.split(/^Subject: .*$/m)[1]?.replace(/<\/inbound_message>[\s\S]*$/, "") ?? text;
  const all = `${subject}\n${body}`;
  const { category, eventType } = classify(all);
  const city = extractCity(all);
  const org = all.match(/\b([A-Z][\w&-]*(?:\s[A-Z][\w&-]*)?\s?(?:Fest(?:ival)?|Events?|Club|Agency|Magazine|Records|Media|BV|B\.V\.))\b/)?.[1] ?? null;
  return {
    senderName: from?.[1]?.trim() ?? "there",
    email: from?.[2] ?? null,
    subject,
    body,
    category,
    eventType,
    date: extractDate(all, today),
    city: city?.city ?? null,
    region: city?.region ?? null,
    budget: extractBudget(all),
    audience: extractAudience(all),
    language: detectLanguage(all),
    org,
    injection: looksLikeInjection(all),
  };
}

function readState(messages: MessageParam[]): State {
  const first = messages[0]!.content as string;
  const today = first.match(/Today is (\d{4}-\d{2}-\d{2})/)?.[1] ?? new Date().toISOString().slice(0, 10);
  const names = new Map<string, string>();
  const results: Record<string, any> = {};
  for (const m of messages) {
    if (!m.content || typeof m.content === "string") continue;
    for (const b of m.content) {
      if (b.type === "tool_use") names.set(b.id, b.name);
      if (b.type === "tool_result" && !b.is_error && typeof b.content === "string") {
        try {
          results[names.get(b.tool_use_id) ?? "?"] = JSON.parse(b.content);
        } catch {
          /* non-JSON result */
        }
      }
    }
  }
  return { today, request: parseRequest(first, today), results };
}

const REPLIES = {
  nl: {
    hi: (n: string) => `Hoi ${n},`,
    thanks: "Dank voor je bericht en de interesse!",
    free: (d: string) => `Goed nieuws: ${d} lijkt op dit moment nog vrij in de agenda. We houden de datum voorlopig even vast terwijl we je aanvraag bekijken.`,
    busy: (d: string) => `Helaas staat er op ${d} al iets gepland. Zijn er alternatieve data mogelijk?`,
    missing: (f: string) => `Om je aanvraag goed te kunnen beoordelen hebben we nog wat informatie nodig: ${f}.`,
    budget: "We bekijken je aanvraag intern en komen bij je terug met een voorstel.",
    confirm: "Het team neemt binnenkort contact met je op om de details te bevestigen.",
    collab: "We vinden het leuk dat je aan ons denkt. Het team bekijkt je voorstel en komt bij je terug.",
    press: "Bedankt voor de interviewaanvraag. We bekijken de planning en laten snel iets van ons horen.",
    fan: "Wat leuk om te horen, dank je wel voor de support! ❤️",
    bye: "Met vriendelijke groet,",
    fields: { date: "datum", city: "stad", venue: "locatie", budget: "budget", audience: "verwacht aantal bezoekers" },
  },
  en: {
    hi: (n: string) => `Hi ${n},`,
    thanks: "Thanks for reaching out and for your interest!",
    free: (d: string) => `Good news: ${d} currently looks available. We're tentatively holding the date while we review your request.`,
    busy: (d: string) => `Unfortunately ${d} is already taken. Would any alternative dates work for you?`,
    missing: (f: string) => `To review your request properly we still need a few details: ${f}.`,
    budget: "We'll review your request internally and come back to you with a proposal.",
    confirm: "The team will be in touch shortly to confirm the details.",
    collab: "We appreciate you thinking of us. The team will review your proposal and get back to you.",
    press: "Thanks for the interview request. We'll check the schedule and get back to you soon.",
    fan: "So great to hear, thank you for the support! ❤️",
    bye: "Kind regards,",
    fields: { date: "date", city: "city", venue: "venue", budget: "budget", audience: "expected audience size" },
  },
  fr: {
    hi: (n: string) => `Bonjour ${n},`,
    thanks: "Merci pour votre message et votre intérêt !",
    free: (d: string) => `Bonne nouvelle : le ${d} semble encore disponible. Nous bloquons provisoirement la date pendant l'examen de votre demande.`,
    busy: (d: string) => `Malheureusement, le ${d} est déjà pris. Auriez-vous d'autres dates ?`,
    missing: (f: string) => `Pour bien évaluer votre demande, il nous manque encore : ${f}.`,
    budget: "Nous étudions votre demande en interne et revenons vers vous avec une proposition.",
    confirm: "L'équipe vous recontactera rapidement pour confirmer les détails.",
    collab: "Merci d'avoir pensé à nous. L'équipe étudie votre proposition et revient vers vous.",
    press: "Merci pour la demande d'interview. Nous vérifions le planning et revenons vers vous.",
    fan: "Merci beaucoup pour votre soutien ! ❤️",
    bye: "Cordialement,",
    fields: { date: "date", city: "ville", venue: "lieu", budget: "budget", audience: "nombre de visiteurs attendu" },
  },
};

function buildSubmission(state: State): SubmitInput {
  const r = state.request;
  const L = REPLIES[r.language];
  const flags: SubmitInput["risk_flags"] = [];
  const availability = state.results.calendar_check_availability;
  const hold = state.results.calendar_create_hold;
  const rate = state.results.rates_lookup;
  const dateFree = availability?.freeDates?.includes(r.date ?? "") ?? null;

  if (r.injection) flags.push("possible_prompt_injection");
  if (r.category === "booking" && r.date && dateFree === false) flags.push("date_unavailable");
  if (r.category === "booking" && rate?.found && r.budget !== null && r.budget < rate.minFeeEur) flags.push("budget_below_minimum");
  const missing = r.category === "booking"
    ? (["date", "city", "budget", "audience"] as const).filter((f) => (f === "date" ? !r.date : f === "city" ? !r.city : f === "budget" ? r.budget === null : r.audience === null))
    : [];
  if (missing.length) flags.push("missing_details");

  let draft = "";
  if (r.category !== "spam" && !r.injection) {
    const parts = [L.hi(r.senderName.split(" ")[0] ?? r.senderName), "", L.thanks];
    if (r.category === "booking") {
      if (r.date && dateFree === true) parts.push(L.free(r.date));
      if (r.date && dateFree === false) parts.push(L.busy(r.date));
      if (missing.length) parts.push(L.missing(missing.map((f) => L.fields[f]).join(", ")));
      parts.push(flags.includes("budget_below_minimum") ? L.budget : L.confirm);
    } else if (r.category === "collaboration") parts.push(L.collab);
    else if (r.category === "press") parts.push(L.press);
    else if (r.category === "fan") parts.push(L.fan);
    else parts.push(L.confirm);
    parts.push("", L.bye, "Team NOVA");
    draft = parts.join("\n");
  }

  const did = [hold?.placed ? `optie geplaatst op ${r.date}` : null, state.results.crm_upsert_contact?.saved ? "contact opgeslagen in CRM" : null].filter(Boolean);
  const summary = r.injection
    ? "Bericht bevat instructies gericht aan de assistent (mogelijke prompt injection); niets uitgevoerd."
    : `${cap(r.category)}-aanvraag van ${r.senderName}${r.city ? ` (${r.city})` : ""}${r.date ? ` voor ${r.date}` : ""}${r.budget !== null ? `, budget €${r.budget}` : ""}.${did.length ? ` ${cap(did.join(", "))}.` : ""}`;

  const soon = r.date ? (Date.parse(r.date) - Date.parse(state.today)) / 86_400_000 < 30 : false;
  return {
    category: r.category,
    priority: r.injection || r.category === "spam" ? "low" : r.category === "booking" ? (soon ? "urgent" : "high") : r.category === "fan" ? "low" : "normal",
    language: r.language,
    summary,
    extracted: {
      event_date: r.date,
      city: r.city,
      venue: null,
      organization: r.org,
      budget_eur: r.budget,
      audience_size: r.audience,
      event_type: r.eventType,
    },
    draft_reply: draft,
    risk_flags: flags,
  };
}

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
