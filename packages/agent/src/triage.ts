import {
  audit,
  getRequest,
  saveAgentResult,
  transitionStatus,
  type Db,
  type InboundRequest,
  type Logger,
} from "@inbox/core";
import { AgentError, runTriageAgent, type AgentRun } from "./agent.ts";
import { isRetryableLLMError, type LLM } from "./llm.ts";
import { McpToolbox } from "./mcp-bridge.ts";
import type { BusinessContext } from "./prompt.ts";

export interface TriageDeps {
  db: Db;
  llm: LLM;
  business: Omit<BusinessContext, "today">;
  logger?: Logger;
  /** Injected for deterministic tests. */
  today?: () => string;
}

export type TriageOutcome =
  | { status: "done"; request: InboundRequest; run: AgentRun }
  | { status: "skipped"; reason: string }
  | { status: "failed"; retryable: boolean; error: string };

/**
 * Claim a request, run the agent on it, and persist the outcome.
 * Safe to call concurrently for the same request: only one caller wins the
 * compare-and-set claim, the others get `skipped`.
 */
export async function triageRequest(deps: TriageDeps, requestId: string, signal?: AbortSignal): Promise<TriageOutcome> {
  const { db, llm, logger } = deps;
  const claimed = await transitionStatus(db, requestId, ["received", "queued"], "processing");
  if (!claimed) {
    const current = await getRequest(db, requestId);
    return { status: "skipped", reason: current ? `request is ${current.status}` : "request not found" };
  }

  const toolbox = await McpToolbox.inProcess(
    { db, actor: "agent", requestId, excludeRequestId: requestId },
    (err) => logger?.error({ err, requestId }, "MCP tool error"),
  );
  const today = deps.today?.() ?? new Date().toISOString().slice(0, 10);
  const started = Date.now();
  try {
    const run = await runTriageAgent({ llm, toolbox, request: claimed, business: { ...deps.business, today }, logger, signal });
    const r = run.result;
    const saved = await saveAgentResult(db, requestId, {
      category: r.category,
      priority: r.priority,
      extracted: {
        eventDate: r.extracted.event_date,
        city: r.extracted.city,
        venue: r.extracted.venue,
        organization: r.extracted.organization,
        budgetEur: r.extracted.budget_eur,
        audienceSize: r.extracted.audience_size,
        eventType: r.extracted.event_type,
        language: r.language,
      },
      summary: r.summary,
      draftReply: r.draft_reply,
      riskFlags: r.risk_flags,
      trace: { model: run.model, usage: run.usage, durationMs: Date.now() - started, steps: run.trace },
    });
    if (!saved) return { status: "skipped", reason: "request changed state while the agent was running" };
    await audit(db, {
      actor: "agent",
      action: "agent.completed",
      requestId,
      details: { model: run.model, category: r.category, flags: r.risk_flags, ...run.usage, durationMs: Date.now() - started },
    });
    logger?.info({ requestId, category: r.category, flags: r.risk_flags, ms: Date.now() - started }, "triage done");
    return { status: "done", request: saved, run };
  } catch (err) {
    const retryable = err instanceof AgentError ? err.retryable : isRetryableLLMError(err);
    const message = err instanceof Error ? err.message : String(err);
    // Retryable failures go back to 'queued' so a later attempt can claim them again.
    await transitionStatus(db, requestId, ["processing"], retryable ? "queued" : "failed", { error: message });
    await audit(db, { actor: "agent", action: "agent.failed", requestId, details: { error: message, retryable } });
    logger?.warn({ requestId, err: message, retryable }, "triage failed");
    return { status: "failed", retryable, error: message };
  } finally {
    await toolbox.close();
  }
}
