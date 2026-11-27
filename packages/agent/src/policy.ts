import type { McpToolInfo } from "./mcp-bridge.ts";

export interface PolicyLimits {
  /** Total tool calls per run (excluding the final submit). */
  maxToolCalls: number;
  /** Calls to tools that change state (holds, CRM writes) per run. */
  maxWriteCalls: number;
}

export const DEFAULT_LIMITS: PolicyLimits = { maxToolCalls: 12, maxWriteCalls: 3 };

export type Decision = { allow: true } | { allow: false; reason: string };

/**
 * Decides whether the agent may run a tool call. Least privilege: only tools that were
 * explicitly listed are callable, and state-changing tools have a small per-run budget,
 * so even a fully manipulated model can do little damage.
 */
export class ToolPolicy {
  private calls = 0;
  private writes = 0;
  private readonly tools: Map<string, McpToolInfo>;

  constructor(tools: McpToolInfo[], private readonly limits: PolicyLimits = DEFAULT_LIMITS) {
    this.tools = new Map(tools.map((t) => [t.tool.name, t]));
  }

  check(name: string): Decision {
    const tool = this.tools.get(name);
    if (!tool) return { allow: false, reason: `unknown tool '${name}'` };
    if (this.calls >= this.limits.maxToolCalls) return { allow: false, reason: "tool call budget for this request is used up; submit your result now" };
    if (!tool.readOnly && this.writes >= this.limits.maxWriteCalls) {
      return { allow: false, reason: "write budget for this request is used up; continue without further changes" };
    }
    this.calls++;
    if (!tool.readOnly) this.writes++;
    return { allow: true };
  }

  get usage() {
    return { calls: this.calls, writes: this.writes };
  }
}
