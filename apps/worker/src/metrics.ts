import { Counter, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export function createMetrics() {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  return {
    registry,
    jobs: new Counter({ name: "inbox_triage_jobs_total", help: "Triage jobs by outcome", labelNames: ["outcome"], registers: [registry] }),
    duration: new Histogram({
      name: "inbox_triage_duration_seconds",
      help: "End-to-end agent run time per request",
      buckets: [0.5, 1, 2, 5, 10, 20, 40, 60, 120],
      registers: [registry],
    }),
    tokens: new Counter({ name: "inbox_llm_tokens_total", help: "LLM tokens by kind", labelNames: ["kind"], registers: [registry] }),
    toolCalls: new Counter({ name: "inbox_agent_tool_calls_total", help: "Tool calls made by the agent", registers: [registry] }),
    flags: new Counter({ name: "inbox_risk_flags_total", help: "Risk flags raised", labelNames: ["flag"], registers: [registry] }),
    deliveries: new Counter({ name: "inbox_deliveries_total", help: "Approved replies delivered", labelNames: ["outcome"], registers: [registry] }),
    swept: new Counter({ name: "inbox_sweeper_requeued_total", help: "Requests re-enqueued by the sweeper", labelNames: ["from"], registers: [registry] }),
  };
}
export type Metrics = ReturnType<typeof createMetrics>;
