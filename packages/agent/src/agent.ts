import type { InboundRequest, Logger } from "@inbox/core";
import type { LLM, Message, MessageParam, ToolResultBlockParam, ToolUseBlock } from "./llm.ts";
import type { McpToolbox } from "./mcp-bridge.ts";
import { DEFAULT_LIMITS, ToolPolicy, type PolicyLimits } from "./policy.ts";
import { buildSystemPrompt, renderRequest, SUBMIT_TOOL_NAME, type BusinessContext } from "./prompt.ts";
import { SubmitInput, submitTool } from "./submit.ts";

export class AgentError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export type TraceStep =
  | { kind: "model"; text: string; toolCalls: { name: string; input: unknown }[]; stopReason: string | null; usage: Usage }
  | { kind: "tool"; name: string; input: unknown; isError: boolean; output: string; denied?: boolean };

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface AgentRun {
  result: SubmitInput;
  trace: TraceStep[];
  usage: Usage & { modelCalls: number; toolCalls: number; writeCalls: number };
  model: string;
}

export interface RunOptions {
  llm: LLM;
  toolbox: McpToolbox;
  request: InboundRequest;
  business: BusinessContext;
  limits?: PolicyLimits;
  /** Hard cap on model round-trips. */
  maxTurns?: number;
  logger?: Logger;
  signal?: AbortSignal;
  /** Remove state-changing tools entirely (used when the input looks manipulated). */
  readOnly?: boolean;
}

const MAX_TOOL_OUTPUT = 8_000;
const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… [truncated]` : s);

/**
 * The agent loop: model → tool calls (through policy + MCP) → results → model …
 * until the model submits its triage via the strict `submit_triage` tool.
 *
 * The conversation is append-only: assistant turns are sent back exactly as received
 * (including thinking blocks), which keeps prompt caching and preserved thinking intact.
 */
export async function runTriageAgent(opts: RunOptions): Promise<AgentRun> {
  const { llm, toolbox, request, business, logger } = opts;
  const maxTurns = opts.maxTurns ?? 10;

  // In read-only mode, write tools aren't just denied, they're never offered to the model.
  const mcpTools = (await toolbox.listTools()).filter((t) => !opts.readOnly || t.readOnly);
  const policy = new ToolPolicy(mcpTools, opts.limits ?? DEFAULT_LIMITS);
  const tools = [...mcpTools.map((t) => t.tool), submitTool];
  const system = buildSystemPrompt(business);
  const messages: MessageParam[] = [{ role: "user", content: renderRequest(request, business.today) }];
  const trace: TraceStep[] = [];
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, modelCalls: 0 };
  let nudged = false;
  let model = llm.name;

  for (let turn = 0; turn < maxTurns; turn++) {
    const msg: Message = await llm.createTurn({ system, messages, tools }, opts.signal);
    model = msg.model ?? model;
    usage.modelCalls++;
    usage.inputTokens += msg.usage.input_tokens;
    usage.outputTokens += msg.usage.output_tokens;
    usage.cacheReadTokens += msg.usage.cache_read_input_tokens ?? 0;
    usage.cacheWriteTokens += msg.usage.cache_creation_input_tokens ?? 0;

    const toolUses = msg.content.filter((b): b is ToolUseBlock => b.type === "tool_use");
    trace.push({
      kind: "model",
      text: msg.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("\n"),
      toolCalls: toolUses.map((t) => ({ name: t.name, input: t.input })),
      stopReason: msg.stop_reason,
      usage: {
        inputTokens: msg.usage.input_tokens,
        outputTokens: msg.usage.output_tokens,
        cacheReadTokens: msg.usage.cache_read_input_tokens ?? 0,
        cacheWriteTokens: msg.usage.cache_creation_input_tokens ?? 0,
      },
    });
    logger?.debug({ turn, stopReason: msg.stop_reason, tools: toolUses.map((t) => t.name) }, "model turn");

    // Check the stop reason before running anything: a refused or truncated turn
    // may contain a cut-off tool call that must never be executed.
    if (msg.stop_reason === "refusal") throw new AgentError("model declined the request", false);
    if (msg.stop_reason === "max_tokens") throw new AgentError("model output truncated (max_tokens)", true);

    messages.push({ role: "assistant", content: msg.content });

    if (msg.stop_reason === "pause_turn") continue;

    if (toolUses.length === 0) {
      if (nudged) throw new AgentError("model ended without submitting a result", true);
      nudged = true;
      messages.push({ role: "user", content: `Please finish by calling ${SUBMIT_TOOL_NAME}.` });
      continue;
    }

    // Run tool calls of this turn concurrently, then return ALL results in one user message.
    let submitted: SubmitInput | null = null;
    const results: ToolResultBlockParam[] = await Promise.all(
      toolUses.map(async (call): Promise<ToolResultBlockParam> => {
        if (call.name === SUBMIT_TOOL_NAME) {
          const parsed = SubmitInput.safeParse(call.input);
          if (!parsed.success) {
            const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
            trace.push({ kind: "tool", name: call.name, input: call.input, isError: true, output: issues });
            return { type: "tool_result", tool_use_id: call.id, is_error: true, content: `Invalid result: ${issues}` };
          }
          submitted = parsed.data;
          return { type: "tool_result", tool_use_id: call.id, content: "Submitted." };
        }

        const decision = policy.check(call.name);
        if (!decision.allow) {
          trace.push({ kind: "tool", name: call.name, input: call.input, isError: true, output: decision.reason, denied: true });
          logger?.warn({ tool: call.name, reason: decision.reason }, "tool call denied by policy");
          return { type: "tool_result", tool_use_id: call.id, is_error: true, content: decision.reason };
        }
        const out = await toolbox.call(call.name, (call.input ?? {}) as Record<string, unknown>);
        const output = truncate(out.text, MAX_TOOL_OUTPUT);
        trace.push({ kind: "tool", name: call.name, input: call.input, isError: out.isError, output });
        return { type: "tool_result", tool_use_id: call.id, is_error: out.isError || undefined, content: output };
      }),
    );

    if (submitted) {
      const { calls, writes } = policy.usage;
      return { result: submitted, trace, usage: { ...usage, toolCalls: calls, writeCalls: writes }, model };
    }
    messages.push({ role: "user", content: results });
  }

  throw new AgentError(`no result after ${maxTurns} turns`, true);
}
