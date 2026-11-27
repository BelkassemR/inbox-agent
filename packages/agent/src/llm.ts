import Anthropic from "@anthropic-ai/sdk";

export type MessageParam = Anthropic.Beta.BetaMessageParam;
export type Message = Anthropic.Beta.BetaMessage;
export type Tool = Anthropic.Beta.BetaTool;
export type TextBlockParam = Anthropic.Beta.BetaTextBlockParam;
export type ToolUseBlock = Anthropic.Beta.BetaToolUseBlock;
export type ToolResultBlockParam = Anthropic.Beta.BetaToolResultBlockParam;

export interface TurnParams {
  system: TextBlockParam[];
  messages: MessageParam[];
  tools: Tool[];
}

/**
 * The one thing the agent loop needs from a model. Keeping this narrow means the loop
 * can run against Claude in production and against a deterministic scripted model in
 * tests and offline demos.
 */
export interface LLM {
  readonly name: string;
  createTurn(params: TurnParams, signal?: AbortSignal): Promise<Message>;
}

export interface AnthropicLLMOptions {
  apiKey?: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  maxTokens?: number;
  client?: Anthropic;
}

export class AnthropicLLM implements LLM {
  readonly name: string;
  private readonly client: Anthropic;
  private readonly model: string;
  private readonly effort: NonNullable<AnthropicLLMOptions["effort"]>;
  private readonly maxTokens: number;

  constructor(opts: AnthropicLLMOptions = {}) {
    // The SDK retries 408/409/429/5xx and connection errors with backoff (2 retries by default).
    this.client = opts.client ?? new Anthropic({ apiKey: opts.apiKey, maxRetries: 3, timeout: 120_000 });
    this.model = opts.model ?? "claude-opus-5-5";
    this.effort = opts.effort ?? "medium";
    this.maxTokens = opts.maxTokens ?? 16_000;
    this.name = `anthropic:${this.model}`;
  }

  async createTurn({ system, messages, tools }: TurnParams, signal?: AbortSignal): Promise<Message> {
    return this.client.beta.messages.create(
      {
        model: this.model,
        max_tokens: this.maxTokens,
        system,
        messages,
        tools,
        // Thinking is adaptive by default on this model; effort is the depth/cost dial.
        output_config: { effort: this.effort },
        // Cache the growing conversation prefix between agent turns.
        cache_control: { type: "ephemeral" },
        // If a safety classifier declines, let the API retry on a fallback model in the same call.
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
      },
      { signal },
    );
  }
}

/** Whether a failed model call is worth retrying later (rate limits, overload, network). */
export function isRetryableLLMError(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError) return true; // includes timeouts
  if (err instanceof Anthropic.RateLimitError) return true;
  if (err instanceof Anthropic.InternalServerError) return true;
  if (err instanceof Anthropic.APIError) return err.status === 408 || err.status === 409 || err.status === 529;
  return false;
}
