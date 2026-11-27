/**
 * Triage one request, or every request still in 'received':
 *   pnpm --filter @inbox/agent triage <request-id>
 *   pnpm --filter @inbox/agent triage --pending
 */
import { createLogger, createPool, listRequests } from "@inbox/core";
import { createLLM, DEFAULT_BUSINESS } from "./factory.ts";
import { triageRequest } from "./triage.ts";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required");
const db = createPool(url, 3);
const logger = createLogger(process.env.LOG_LEVEL ?? "info", "agent-cli");
const llm = createLLM({
  LLM_PROVIDER: (process.env.LLM_PROVIDER as "anthropic" | "scripted") ?? "scripted",
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  AGENT_MODEL: process.env.AGENT_MODEL ?? "claude-opus-5-5",
  AGENT_EFFORT: (process.env.AGENT_EFFORT as "medium") ?? "medium",
});

const arg = process.argv[2];
const ids = arg === "--pending" ? (await listRequests(db, { status: "received", limit: 200 })).map((r) => r.id) : arg ? [arg] : [];
if (!ids.length) console.error("usage: triage <request-id> | --pending");
for (const id of ids) {
  const out = await triageRequest({ db, llm, business: DEFAULT_BUSINESS, logger }, id);
  console.log(JSON.stringify(out.status === "done" ? { id, status: out.status, summary: out.request.summary, flags: out.request.riskFlags } : { id, ...out }));
}
await db.end();
